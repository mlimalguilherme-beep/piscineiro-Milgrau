import { Charge, ChargeStatus, Client } from "../shared/types.ts";

export interface CreatedPayment {
  id: string;
  url: string;
  pixCode?: string;
}

export interface Gateway {
  mode: "asaas-sandbox" | "asaas-production" | "simulado";
  ensureCustomer(client: Client): Promise<string>;
  updateCustomer(client: Client): Promise<void>;
  createPayment(client: Client, charge: Charge): Promise<CreatedPayment>;
  /** Situação atual no gateway, ou null se o gateway não souber informar. */
  getStatus(paymentId: string): Promise<ChargeStatus | null>;
  /** Registra no gateway que a cobrança foi paga por fora (dinheiro, Pix direto...). */
  markPaidManually(paymentId: string, amountCents: number, date: string): Promise<void>;
  cancel(paymentId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Asaas – https://docs.asaas.com
// ---------------------------------------------------------------------------

const PAID = new Set(["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"]);
const CANCELED = new Set(["REFUNDED", "REFUND_REQUESTED", "REFUND_IN_PROGRESS"]);

export function mapAsaasStatus(status: string, deleted = false): ChargeStatus {
  if (deleted) return "canceled";
  if (PAID.has(status)) return "paid";
  if (CANCELED.has(status)) return "canceled";
  return "pending";
}

export class AsaasGateway implements Gateway {
  mode: Gateway["mode"];
  private base: string;

  constructor(private apiKey: string, env: string) {
    const production = env === "production";
    this.mode = production ? "asaas-production" : "asaas-sandbox";
    this.base = production ? "https://api.asaas.com/v3" : "https://api-sandbox.asaas.com/v3";
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        access_token: this.apiKey,
        "Content-Type": "application/json",
        "User-Agent": "piscineiro-cobrancas",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const detail = Array.isArray(json.errors)
        ? json.errors.map((e: { description: string }) => e.description).join("; ")
        : text.slice(0, 200);
      throw new Error(`Asaas ${res.status}: ${detail}`);
    }
    return json as T;
  }

  private customerBody(client: Client) {
    return {
      name: client.name,
      cpfCnpj: client.cpfCnpj,
      mobilePhone: client.phone.replace(/^55/, ""),
      externalReference: client.id,
      // As mensagens são enviadas por você no WhatsApp; o Asaas não manda e-mail/SMS.
      notificationDisabled: true,
    };
  }

  async ensureCustomer(client: Client): Promise<string> {
    if (client.gatewayCustomerId) return client.gatewayCustomerId;
    const found = await this.request<{ data: { id: string }[] }>(
      "GET",
      `/customers?externalReference=${encodeURIComponent(client.id)}`,
    );
    if (found.data.length > 0) return found.data[0].id;
    const created = await this.request<{ id: string }>("POST", "/customers", this.customerBody(client));
    return created.id;
  }

  async updateCustomer(client: Client): Promise<void> {
    if (!client.gatewayCustomerId) return;
    await this.request("PUT", `/customers/${client.gatewayCustomerId}`, this.customerBody(client));
  }

  async createPayment(client: Client, charge: Charge): Promise<CreatedPayment> {
    // Evita cobrança duplicada se uma tentativa anterior criou mas não chegou a salvar aqui.
    const existing = await this.request<{ data: { id: string; invoiceUrl: string; deleted: boolean }[] }>(
      "GET",
      `/payments?externalReference=${encodeURIComponent(charge.id)}`,
    );
    let payment = existing.data.find((p) => !p.deleted);
    if (!payment) {
      payment = await this.request("POST", "/payments", {
        customer: client.gatewayCustomerId,
        // UNDEFINED: o cliente escolhe Pix, boleto ou cartão na página de pagamento.
        billingType: "UNDEFINED",
        value: charge.amountCents / 100,
        dueDate: charge.dueDate,
        description: charge.description,
        externalReference: charge.id,
      });
    }
    let pixCode: string | undefined;
    try {
      const pix = await this.request<{ payload: string }>("GET", `/payments/${payment!.id}/pixQrCode`);
      pixCode = pix.payload;
    } catch {
      // Conta sem chave Pix cadastrada: segue só com o link.
    }
    return { id: payment!.id, url: payment!.invoiceUrl, pixCode };
  }

  async getStatus(paymentId: string): Promise<ChargeStatus | null> {
    const p = await this.request<{ status: string; deleted: boolean }>("GET", `/payments/${paymentId}`);
    return mapAsaasStatus(p.status, p.deleted);
  }

  async markPaidManually(paymentId: string, amountCents: number, date: string): Promise<void> {
    await this.request("POST", `/payments/${paymentId}/receiveInCash`, {
      paymentDate: date,
      value: amountCents / 100,
      notifyCustomer: false,
    });
  }

  async cancel(paymentId: string): Promise<void> {
    await this.request("DELETE", `/payments/${paymentId}`);
  }
}

// ---------------------------------------------------------------------------
// Modo simulado: sem chave do Asaas, gera links locais para testar o fluxo.
// ---------------------------------------------------------------------------

export class SimulatedGateway implements Gateway {
  mode = "simulado" as const;

  constructor(private appUrl: string) {}

  async ensureCustomer(client: Client): Promise<string> {
    return client.gatewayCustomerId ?? `sim_cus_${client.id}`;
  }
  async updateCustomer(): Promise<void> {}
  async createPayment(_client: Client, charge: Charge): Promise<CreatedPayment> {
    return {
      id: `sim_pay_${charge.id}`,
      url: `${this.appUrl.replace(/\/$/, "")}/pagamento-simulado/${charge.id}`,
      pixCode: "00020126SIMULADO-PIX-COPIA-E-COLA",
    };
  }
  async getStatus(): Promise<ChargeStatus | null> {
    return null;
  }
  async markPaidManually(): Promise<void> {}
  async cancel(): Promise<void> {}
}

export function createGateway(env: NodeJS.ProcessEnv): Gateway {
  const key = env.ASAAS_API_KEY?.trim();
  if (key) return new AsaasGateway(key, env.ASAAS_ENV ?? "sandbox");
  return new SimulatedGateway(env.APP_URL || `http://localhost:${env.PORT || 3000}`);
}
