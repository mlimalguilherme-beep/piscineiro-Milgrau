import { Charge, Client, QueueItem, ReminderStage, Settings } from "../shared/types.ts";
import {
  diffDays,
  dueDateFor,
  formatBRL,
  formatDateBR,
  formatReference,
  renderTemplate,
  whatsappLink,
} from "../shared/format.ts";
import { Data, newId } from "./db.ts";
import { Gateway } from "./gateway.ts";

// ---------------------------------------------------------------------------
// Geração das mensalidades
// ---------------------------------------------------------------------------

/**
 * Cria (localmente) as mensalidades que vencem nos próximos
 * `settings.daysAheadToGenerate` dias. Considera o mês atual e o próximo.
 * Retorna as cobranças criadas.
 */
export function generateMonthlyCharges(data: Data, today: string): Charge[] {
  const created: Charge[] = [];
  const [year, month] = today.split("-").map(Number);
  const months = [
    [year, month],
    month === 12 ? [year + 1, 1] : [year, month + 1],
  ];

  for (const client of data.clients) {
    if (!client.active) continue;
    for (const [y, m] of months) {
      const dueDate = dueDateFor(y, m, client.dueDay);
      const reference = `${y}-${String(m).padStart(2, "0")}`;
      if (dueDate < client.billingStartDate) continue;
      if (diffDays(today, dueDate) > data.settings.daysAheadToGenerate) continue;
      if (data.charges.some((c) => c.clientId === client.id && c.reference === reference)) continue;

      const charge: Charge = {
        id: newId("cob"),
        clientId: client.id,
        reference,
        description: `${client.description} - ${formatReference(reference)}`,
        amountCents: client.monthlyAmountCents,
        dueDate,
        status: "pending",
        reminders: {},
        createdAt: new Date().toISOString(),
      };
      data.charges.push(charge);
      created.push(charge);
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// Régua de cobrança
// ---------------------------------------------------------------------------

function enabledStages(settings: Settings): ReminderStage[] {
  return settings.stages.filter((s) => s.enabled).sort((a, b) => a.offsetDays - b.offsetDays);
}

/**
 * Etapa da régua que deve ser enviada hoje para esta cobrança, ou null.
 *
 * Sempre vale a etapa mais recente cuja data já chegou. Se o app ficou parado
 * alguns dias, as etapas antigas são puladas (o cliente recebe só a mensagem
 * atual, não várias de uma vez). Uma etapa já enviada, ou uma posterior a
 * ela, encerra a etapa.
 */
export function dueStage(charge: Charge, settings: Settings, today: string): ReminderStage | null {
  if (charge.status !== "pending") return null;
  const elapsed = diffDays(charge.dueDate, today);
  const stages = enabledStages(settings);
  const applicable = stages.filter((s) => s.offsetDays <= elapsed);
  if (applicable.length === 0) return null;
  const latest = applicable[applicable.length - 1];
  const alreadyHandled = settings.stages.some(
    (s) => s.offsetDays >= latest.offsetDays && charge.reminders[s.key],
  );
  return alreadyHandled ? null : latest;
}

/** Etapa usada para um envio manual fora da régua: a etapa atual, ou a primeira. */
export function stageForManualSend(charge: Charge, settings: Settings, today: string): ReminderStage {
  const stages = enabledStages(settings);
  const all = stages.length > 0 ? stages : settings.stages;
  const elapsed = diffDays(charge.dueDate, today);
  const applicable = all.filter((s) => s.offsetDays <= elapsed);
  return applicable[applicable.length - 1] ?? all[0];
}

export function buildMessage(
  template: string,
  charge: Charge,
  client: Client,
  settings: Settings,
  today: string,
): string {
  return renderTemplate(template, {
    nome: client.name.trim().split(/\s+/)[0],
    valor: formatBRL(charge.amountCents),
    vencimento: formatDateBR(charge.dueDate),
    referencia: formatReference(charge.reference),
    link: charge.paymentUrl ?? "",
    pix: charge.pixCode ?? "",
    dias_atraso: String(Math.max(0, diffDays(charge.dueDate, today))),
    empresa: settings.businessName,
  });
}

/** Todas as mensagens que precisam sair hoje, mais atrasadas primeiro. */
export function computeQueue(data: Data, today: string): QueueItem[] {
  const clients = new Map(data.clients.map((c) => [c.id, c]));
  const items: QueueItem[] = [];
  for (const charge of data.charges) {
    const client = clients.get(charge.clientId);
    if (!client || !client.active) continue;
    const stage = dueStage(charge, data.settings, today);
    if (!stage) continue;
    const message = buildMessage(stage.template, charge, client, data.settings, today);
    items.push({
      chargeId: charge.id,
      stageKey: stage.key,
      stageLabel: stage.label,
      clientId: client.id,
      clientName: client.name,
      phone: client.phone,
      amountCents: charge.amountCents,
      dueDate: charge.dueDate,
      daysLate: Math.max(0, diffDays(charge.dueDate, today)),
      message,
      whatsappUrl: whatsappLink(client.phone, message),
      missingPaymentLink: !charge.paymentUrl,
    });
  }
  return items.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

// ---------------------------------------------------------------------------
// Integração com o gateway
// ---------------------------------------------------------------------------

/** Cria cliente + cobrança no gateway. Em caso de erro, guarda a mensagem na cobrança. */
export async function pushChargeToGateway(data: Data, gateway: Gateway, charge: Charge): Promise<boolean> {
  const client = data.clients.find((c) => c.id === charge.clientId);
  if (!client) return false;
  try {
    client.gatewayCustomerId = await gateway.ensureCustomer(client);
    const payment = await gateway.createPayment(client, charge);
    charge.gatewayId = payment.id;
    charge.paymentUrl = payment.url;
    charge.pixCode = payment.pixCode;
    delete charge.gatewayError;
    return true;
  } catch (err) {
    charge.gatewayError = err instanceof Error ? err.message : String(err);
    return false;
  }
}

export function markPaid(charge: Charge, via: "gateway" | "manual"): void {
  if (charge.status === "paid") return;
  charge.status = "paid";
  charge.paidAt = new Date().toISOString();
  charge.paidVia = via;
}

export interface JobSummary {
  created: number;
  linked: number;
  linkErrors: number;
  newlyPaid: number;
  syncErrors: number;
}

/** Rotina periódica: gera mensalidades, cria links de pagamento e confere pagamentos. */
export async function runBillingJobs(data: Data, gateway: Gateway, today: string): Promise<JobSummary> {
  const summary: JobSummary = { created: 0, linked: 0, linkErrors: 0, newlyPaid: 0, syncErrors: 0 };
  summary.created = generateMonthlyCharges(data, today).length;

  for (const charge of data.charges) {
    if (charge.status !== "pending") continue;
    if (!charge.gatewayId) {
      if (await pushChargeToGateway(data, gateway, charge)) summary.linked++;
      else summary.linkErrors++;
      continue;
    }
    try {
      const status = await gateway.getStatus(charge.gatewayId);
      if (status === "paid") {
        markPaid(charge, "gateway");
        summary.newlyPaid++;
      } else if (status === "canceled") {
        charge.status = "canceled";
      }
    } catch {
      summary.syncErrors++;
    }
  }
  return summary;
}

export function describeSummary(s: JobSummary): string {
  const parts = [
    `${s.created} mensalidade(s) gerada(s)`,
    `${s.linked} link(s) de pagamento criado(s)`,
    `${s.newlyPaid} pagamento(s) confirmado(s)`,
  ];
  if (s.linkErrors) parts.push(`${s.linkErrors} erro(s) ao criar link`);
  if (s.syncErrors) parts.push(`${s.syncErrors} erro(s) ao consultar pagamentos`);
  return parts.join(", ");
}
