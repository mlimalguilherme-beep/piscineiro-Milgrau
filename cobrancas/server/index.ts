import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { createHmac, timingSafeEqual } from "crypto";
import { Charge, Client, Settings, StatusInfo } from "../shared/types.ts";
import {
  formatBRL,
  formatDateBR,
  isValidCpfCnpj,
  normalizePhone,
  todayISO,
  whatsappLink,
} from "../shared/format.ts";
import { newId, Store } from "./db.ts";
import { createGateway } from "./gateway.ts";
import {
  buildMessage,
  describeSummary,
  markPaid,
  pushChargeToGateway,
  runBillingJobs,
  stageForManualSend,
  computeQueue,
} from "./billing.ts";
import { WhatsAppSession } from "./whatsapp.ts";
import { BillingRobot, recordReminder } from "./robot.ts";

const ROOT = process.cwd();
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const PORT = Number(process.env.PORT || 3000);
const PRODUCTION = process.env.NODE_ENV === "production";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim();

if (!ADMIN_PASSWORD) {
  console.error("Defina ADMIN_PASSWORD no arquivo .env (veja .env.example).");
  process.exit(1);
}

const store = new Store(path.join(DATA_DIR, "db.json"));
const gateway = createGateway(process.env);
const wa = new WhatsAppSession(path.join(DATA_DIR, "whatsapp-auth"));
const robot = new BillingRobot(store, wa, gateway);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// ---------------------------------------------------------------------------
// Login: o token é derivado da senha, então continua válido após reiniciar.
// ---------------------------------------------------------------------------

const TOKEN = createHmac("sha256", ADMIN_PASSWORD).update("cobrancas-sessao").digest("hex");

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

app.post("/api/login", (req, res) => {
  const password = String(req.body?.password ?? "");
  if (!safeEqual(password, ADMIN_PASSWORD)) return res.status(401).json({ error: "Senha incorreta." });
  res.json({ token: TOKEN });
});

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!safeEqual(token, TOKEN)) return res.status(401).json({ error: "Faça login novamente." });
  next();
}

// ---------------------------------------------------------------------------
// Webhook do Asaas (público, protegido pelo token configurado no Asaas)
// ---------------------------------------------------------------------------

app.post("/api/webhooks/asaas", (req, res) => {
  const expected = process.env.ASAAS_WEBHOOK_TOKEN?.trim();
  const received = String(req.headers["asaas-access-token"] ?? "");
  if (!expected || !safeEqual(received, expected)) return res.status(401).json({ error: "token inválido" });

  const event = String(req.body?.event ?? "");
  const payment = req.body?.payment as { id?: string; externalReference?: string } | undefined;
  const charge = store.data.charges.find(
    (c) => (payment?.id && c.gatewayId === payment.id) || (payment?.externalReference && c.id === payment.externalReference),
  );
  if (charge) {
    if (["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"].includes(event)) markPaid(charge, "gateway");
    if (["PAYMENT_DELETED", "PAYMENT_REFUNDED"].includes(event)) charge.status = "canceled";
    store.save();
  }
  // Sempre 200 para o Asaas não pausar a fila de webhooks por eventos que ignoramos.
  res.json({ received: true });
});

// ---------------------------------------------------------------------------
// Página de pagamento do modo simulado (só existe sem chave do Asaas)
// ---------------------------------------------------------------------------

if (gateway.mode === "simulado") {
  app.get("/pagamento-simulado/:id", (req, res) => {
    const charge = store.data.charges.find((c) => c.id === req.params.id);
    if (!charge) return res.status(404).send("Cobrança não encontrada");
    const paid = charge.status === "paid";
    res.send(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pagamento simulado</title><body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px">
<h2>Pagamento simulado</h2><p>Esta página só existe para testes, enquanto o Asaas não está configurado.</p>
<p><b>${escapeHtml(charge.description)}</b><br>${formatBRL(charge.amountCents)}, vencimento ${formatDateBR(charge.dueDate)}</p>
${paid ? "<p style='color:green'><b>Pago ✔</b></p>" : `<form method="post"><button style="padding:12px 20px;font-size:16px">Simular pagamento</button></form>`}
</body></html>`);
  });
  app.post("/pagamento-simulado/:id", (req, res) => {
    const charge = store.data.charges.find((c) => c.id === req.params.id);
    if (!charge) return res.status(404).send("Cobrança não encontrada");
    markPaid(charge, "gateway");
    store.save();
    res.redirect(`/pagamento-simulado/${charge.id}`);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---------------------------------------------------------------------------
// API do painel (precisa de login)
// ---------------------------------------------------------------------------

const api = express.Router();
api.use(requireAuth);

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const wrap =
  (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

function findCharge(id: string): Charge {
  const charge = store.data.charges.find((c) => c.id === id);
  if (!charge) throw new HttpError(404, "Cobrança não encontrada.");
  return charge;
}

function findClient(id: string): Client {
  const client = store.data.clients.find((c) => c.id === id);
  if (!client) throw new HttpError(404, "Cliente não encontrado.");
  return client;
}

function statusInfo(): StatusInfo {
  return {
    gatewayMode: gateway.mode,
    webhookConfigured: !!process.env.ASAAS_WEBHOOK_TOKEN?.trim(),
    whatsapp: { state: wa.state, qrDataUrl: wa.qrDataUrl, phone: wa.phone, error: wa.error },
    robot: robot.status(),
    lastJobRunAt: store.data.meta.lastJobRunAt,
    lastJobSummary: store.data.meta.lastJobSummary,
    today: todayISO(),
  };
}

api.get("/status", (_req, res) => res.json(statusInfo()));

// --- WhatsApp ---------------------------------------------------------------

api.post("/whatsapp/connect", wrap(async (_req, res) => {
  await wa.connect();
  res.json(statusInfo());
}));

api.post("/whatsapp/logout", wrap(async (_req, res) => {
  await wa.logout();
  res.json(statusInfo());
}));

api.get("/log", (_req, res) => res.json(store.data.sendLog.slice(0, 100)));

// --- Clientes ---------------------------------------------------------------

function validateClient(body: Record<string, unknown>): Omit<Client, "id" | "createdAt" | "gatewayCustomerId"> {
  const name = String(body.name ?? "").trim();
  if (!name) throw new HttpError(400, "Informe o nome do cliente.");
  const phone = normalizePhone(String(body.phone ?? ""));
  if (!phone) throw new HttpError(400, "Telefone inválido. Use DDD + número, ex.: (19) 99999-8888.");
  const cpfCnpj = String(body.cpfCnpj ?? "").replace(/\D/g, "");
  if (!isValidCpfCnpj(cpfCnpj)) throw new HttpError(400, "CPF ou CNPJ inválido.");
  const monthlyAmountCents = Number(body.monthlyAmountCents);
  if (!Number.isInteger(monthlyAmountCents) || monthlyAmountCents < 500)
    throw new HttpError(400, "Informe um valor mensal de pelo menos R$ 5,00.");
  const dueDay = Number(body.dueDay);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) throw new HttpError(400, "Dia de vencimento deve ser de 1 a 31.");
  const billingStartDate = String(body.billingStartDate ?? todayISO());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(billingStartDate)) throw new HttpError(400, "Data de início inválida.");
  return {
    name,
    phone,
    cpfCnpj,
    monthlyAmountCents,
    dueDay,
    description: String(body.description ?? "").trim() || "Manutenção de piscina",
    notes: String(body.notes ?? "").trim(),
    active: body.active !== false,
    billingStartDate,
  };
}

api.get("/clients", (_req, res) => res.json(store.data.clients));

api.post("/clients", (req, res) => {
  const client: Client = { id: newId("cli"), createdAt: new Date().toISOString(), ...validateClient(req.body) };
  store.data.clients.push(client);
  store.save();
  res.status(201).json(client);
});

api.put("/clients/:id", wrap(async (req, res) => {
  const client = findClient(req.params.id);
  const before = { name: client.name, phone: client.phone, cpfCnpj: client.cpfCnpj };
  Object.assign(client, validateClient(req.body));
  store.save();
  if (client.name !== before.name || client.phone !== before.phone || client.cpfCnpj !== before.cpfCnpj) {
    gateway.updateCustomer(client).catch((err) => console.error("[asaas] atualizar cliente:", err.message));
  }
  res.json(client);
}));

api.delete("/clients/:id", (req, res) => {
  const client = findClient(req.params.id);
  if (store.data.charges.some((c) => c.clientId === client.id))
    throw new HttpError(409, "Este cliente já tem cobranças. Desative-o em vez de excluir.");
  store.data.clients = store.data.clients.filter((c) => c.id !== client.id);
  store.save();
  res.json({ ok: true });
});

// --- Cobranças --------------------------------------------------------------

api.get("/charges", (_req, res) => {
  const sorted = [...store.data.charges].sort((a, b) => b.dueDate.localeCompare(a.dueDate));
  res.json(sorted);
});

api.post("/charges", wrap(async (req, res) => {
  const client = findClient(String(req.body.clientId));
  const amountCents = Number(req.body.amountCents);
  if (!Number.isInteger(amountCents) || amountCents < 500) throw new HttpError(400, "Valor mínimo: R$ 5,00.");
  const dueDate = String(req.body.dueDate ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || dueDate < todayISO())
    throw new HttpError(400, "Informe um vencimento de hoje em diante.");
  const charge: Charge = {
    id: newId("cob"),
    clientId: client.id,
    reference: `avulsa-${Date.now()}`,
    description: String(req.body.description ?? "").trim() || "Serviço avulso",
    amountCents,
    dueDate,
    status: "pending",
    reminders: {},
    createdAt: new Date().toISOString(),
  };
  store.data.charges.push(charge);
  store.save();
  await pushChargeToGateway(store.data, gateway, charge);
  store.save();
  res.status(201).json(charge);
}));

api.post("/charges/:id/retry-gateway", wrap(async (req, res) => {
  const charge = findCharge(req.params.id);
  await pushChargeToGateway(store.data, gateway, charge);
  store.save();
  if (charge.gatewayError) throw new HttpError(502, charge.gatewayError);
  res.json(charge);
}));

api.post("/charges/:id/paid", wrap(async (req, res) => {
  const charge = findCharge(req.params.id);
  if (charge.status !== "pending") throw new HttpError(409, "Só cobranças pendentes podem ser marcadas como pagas.");
  if (charge.gatewayId) {
    try {
      await gateway.markPaidManually(charge.gatewayId, charge.amountCents, todayISO());
    } catch (err) {
      throw new HttpError(502, `Não foi possível dar baixa no Asaas: ${(err as Error).message}`);
    }
  }
  markPaid(charge, "manual");
  store.save();
  res.json(charge);
}));

api.post("/charges/:id/cancel", wrap(async (req, res) => {
  const charge = findCharge(req.params.id);
  if (charge.status !== "pending") throw new HttpError(409, "Só cobranças pendentes podem ser canceladas.");
  if (charge.gatewayId) {
    try {
      await gateway.cancel(charge.gatewayId);
    } catch (err) {
      throw new HttpError(502, `Não foi possível cancelar no Asaas: ${(err as Error).message}`);
    }
  }
  charge.status = "canceled";
  store.save();
  res.json(charge);
}));

/** Mensagem pronta para envio manual (botão "Cobrar agora" na lista de cobranças). */
api.get("/charges/:id/message", (req, res) => {
  const charge = findCharge(req.params.id);
  const client = findClient(charge.clientId);
  const today = todayISO();
  const stage = stageForManualSend(charge, store.data.settings, today);
  const message = buildMessage(stage.template, charge, client, store.data.settings, today);
  res.json({ stageKey: stage.key, message, whatsappUrl: whatsappLink(client.phone, message) });
});

/** Marca a etapa como enviada manualmente ou pulada. */
api.post("/charges/:id/reminders/:stage", (req, res) => {
  findCharge(req.params.id);
  const via = req.body?.skipped ? "pulado" : "manual";
  if (!recordReminder(store.data, req.params.id, req.params.stage, via))
    throw new HttpError(400, "Etapa da régua não encontrada.");
  store.save();
  res.json({ ok: true });
});

/** Envia agora pelo robô (WhatsApp conectado), fora da fila automática. */
api.post("/charges/:id/send-now", wrap(async (req, res) => {
  const charge = findCharge(req.params.id);
  const client = findClient(charge.clientId);
  const today = todayISO();
  const stage = stageForManualSend(charge, store.data.settings, today);
  const message = buildMessage(stage.template, charge, client, store.data.settings, today);
  try {
    await wa.send(client.phone, message);
  } catch (err) {
    throw new HttpError(502, (err as Error).message);
  }
  recordReminder(store.data, charge.id, stage.key, "manual");
  store.save();
  res.json({ ok: true });
}));

// --- Fila, rotina e configurações ---------------------------------------------

api.get("/queue", (_req, res) => res.json(computeQueue(store.data, todayISO())));

api.post("/jobs/run", wrap(async (_req, res) => {
  const summary = await runJobsNow();
  res.json({ summary });
}));

api.get("/settings", (_req, res) => res.json(store.data.settings));

api.put("/settings", (req, res) => {
  const input = req.body as Settings;
  const current = store.data.settings;
  const days = Number(input.daysAheadToGenerate);
  if (!Number.isInteger(days) || days < 0 || days > 28) throw new HttpError(400, "Antecedência deve ser de 0 a 28 dias.");
  if (!Array.isArray(input.stages)) throw new HttpError(400, "Régua inválida.");
  const stages = input.stages.map((s) => {
    const offset = Number(s.offsetDays);
    if (!Number.isInteger(offset) || offset < -15 || offset > 60) throw new HttpError(400, "Dias da régua devem ficar entre -15 e 60.");
    if (!String(s.template ?? "").trim()) throw new HttpError(400, `A mensagem "${s.label}" está vazia.`);
    return {
      key: String(s.key || newId("etapa")),
      label: String(s.label || "Etapa").trim(),
      offsetDays: offset,
      enabled: !!s.enabled,
      template: String(s.template),
    };
  });
  if (new Set(stages.map((s) => s.offsetDays)).size !== stages.length)
    throw new HttpError(400, "Duas etapas da régua não podem ter o mesmo dia.");
  const r = input.robot ?? current.robot;
  const robotSettings = {
    enabled: !!r.enabled,
    startHour: clampInt(r.startHour, 0, 23, "Hora inicial"),
    endHour: clampInt(r.endHour, 1, 24, "Hora final"),
    sendOnSaturday: !!r.sendOnSaturday,
    sendOnSunday: !!r.sendOnSunday,
    minDelaySeconds: clampInt(r.minDelaySeconds, 10, 3600, "Intervalo mínimo"),
    maxDelaySeconds: clampInt(r.maxDelaySeconds, 10, 3600, "Intervalo máximo"),
    dailyLimit: clampInt(r.dailyLimit, 1, 500, "Limite diário"),
  };
  if (robotSettings.endHour <= robotSettings.startHour) throw new HttpError(400, "A hora final deve ser depois da inicial.");
  if (robotSettings.maxDelaySeconds < robotSettings.minDelaySeconds)
    throw new HttpError(400, "O intervalo máximo deve ser maior que o mínimo.");
  store.data.settings = {
    businessName: String(input.businessName ?? "").trim() || current.businessName,
    daysAheadToGenerate: days,
    stages: stages.sort((a, b) => a.offsetDays - b.offsetDays),
    robot: robotSettings,
  };
  store.save();
  res.json(store.data.settings);
});

function clampInt(value: unknown, min: number, max: number, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} deve ser um número de ${min} a ${max}.`);
  return n;
}

app.use("/api", api);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Erro interno. Veja o log do servidor." });
});

// ---------------------------------------------------------------------------
// Rotina automática
// ---------------------------------------------------------------------------

let jobRunning: Promise<string> | null = null;

function runJobsNow(): Promise<string> {
  if (jobRunning) return jobRunning;
  jobRunning = (async () => {
    try {
      const summary = describeSummary(await runBillingJobs(store.data, gateway, todayISO()));
      store.data.meta.lastJobRunAt = new Date().toISOString();
      store.data.meta.lastJobSummary = summary;
      store.save();
      console.log(`[rotina] ${summary}`);
      return summary;
    } finally {
      jobRunning = null;
    }
  })();
  return jobRunning;
}

// ---------------------------------------------------------------------------
// Frontend
// ---------------------------------------------------------------------------

async function start() {
  if (!PRODUCTION) {
    const { createServer } = await import("vite");
    const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(ROOT, "dist");
    if (!fs.existsSync(dist)) {
      console.error("Rode `npm run build` antes de `npm start`.");
      process.exit(1);
    }
    app.use(express.static(dist));
    app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[cobrancas] rodando em http://localhost:${PORT}`);
    console.log(`[cobrancas] gateway: ${gateway.mode}`);
  });

  // Rotina de cobrança: ao iniciar e depois a cada hora.
  runJobsNow().catch((err) => console.error("[rotina]", err));
  setInterval(() => runJobsNow().catch((err) => console.error("[rotina]", err)), 60 * 60 * 1000);

  // Reconecta o WhatsApp se já foi conectado antes, e liga o robô.
  if (wa.hasSavedSession()) void wa.connect();
  robot.start();
}

start();
