import { test } from "node:test";
import assert from "node:assert/strict";
import { Charge, Client, DEFAULT_SETTINGS } from "../shared/types.ts";
import {
  dueDateFor,
  isValidCpfCnpj,
  normalizePhone,
  parseBRL,
  todayISO,
} from "../shared/format.ts";
import { Data } from "./db.ts";
import { computeQueue, dueStage, generateMonthlyCharges, runBillingJobs } from "./billing.ts";
import { inSendingWindow, recordReminder } from "./robot.ts";
import { mapAsaasStatus, SimulatedGateway } from "./gateway.ts";

function client(over: Partial<Client> = {}): Client {
  return {
    id: "cli_1",
    name: "Maria da Silva",
    phone: "5519999998888",
    cpfCnpj: "52998224725",
    monthlyAmountCents: 25000,
    dueDay: 10,
    description: "Manutenção de piscina",
    notes: "",
    active: true,
    billingStartDate: "2026-01-01",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function data(clients: Client[] = [client()], charges: Charge[] = []): Data {
  return { clients, charges, settings: structuredClone(DEFAULT_SETTINGS), sendLog: [], meta: {} };
}

function charge(over: Partial<Charge> = {}): Charge {
  return {
    id: "cob_1",
    clientId: "cli_1",
    reference: "2026-12",
    description: "x",
    amountCents: 25000,
    dueDate: "2026-12-10",
    status: "pending",
    paymentUrl: "https://pagar/1",
    reminders: {},
    createdAt: "2026-12-01T00:00:00Z",
    ...over,
  };
}

test("datas de vencimento respeitam meses curtos", () => {
  assert.equal(dueDateFor(2027, 2, 31), "2027-02-28");
  assert.equal(dueDateFor(2028, 2, 30), "2028-02-29");
  assert.equal(dueDateFor(2026, 12, 10), "2026-12-10");
});

test("hoje usa o fuso de Brasília", () => {
  // 02:00 UTC do dia 28 ainda é dia 27 em Brasília (UTC-3).
  assert.equal(todayISO(new Date("2026-11-28T02:00:00Z")), "2026-11-27");
});

test("telefone, valor e CPF/CNPJ", () => {
  assert.equal(normalizePhone("(19) 99999-8888"), "5519999998888");
  assert.equal(normalizePhone("+55 19 3456-7890"), "551934567890");
  assert.equal(normalizePhone("12345"), null);
  assert.equal(parseBRL("1.250,50"), 125050);
  assert.equal(parseBRL("R$ 99,9"), 9990);
  assert.equal(parseBRL("abc"), null);
  assert.ok(isValidCpfCnpj("529.982.247-25"));
  assert.ok(isValidCpfCnpj("11.222.333/0001-81"));
  assert.ok(!isValidCpfCnpj("111.111.111-11"));
});

test("gera a mensalidade só dentro da antecedência e sem duplicar", () => {
  const d = data();
  assert.equal(generateMonthlyCharges(d, "2026-12-01").length, 0); // vence dia 10, 9 dias antes
  const created = generateMonthlyCharges(d, "2026-12-03");
  assert.equal(created.length, 1);
  assert.equal(created[0].dueDate, "2026-12-10");
  assert.equal(created[0].reference, "2026-12");
  assert.equal(generateMonthlyCharges(d, "2026-12-04").length, 0);
});

test("vira o ano para a mensalidade de janeiro", () => {
  const d = data([client({ dueDay: 2, billingStartDate: "2026-12-20" })]);
  const created = generateMonthlyCharges(d, "2026-12-28");
  assert.deepEqual(created.map((c) => c.reference), ["2027-01"]);
});

test("não gera mensalidade antes da data de início nem para inativo", () => {
  assert.equal(generateMonthlyCharges(data([client({ billingStartDate: "2026-12-11" })]), "2026-12-05").length, 0);
  assert.equal(generateMonthlyCharges(data([client({ active: false })]), "2026-12-05").length, 0);
});

test("régua: etapa certa em cada dia", () => {
  const s = DEFAULT_SETTINGS;
  const c = charge();
  assert.equal(dueStage(c, s, "2026-12-06"), null);
  assert.equal(dueStage(c, s, "2026-12-07")?.key, "antes");
  assert.equal(dueStage(c, s, "2026-12-10")?.key, "vencimento");
  assert.equal(dueStage(c, s, "2026-12-11")?.key, "atraso-1");
  assert.equal(dueStage(c, s, "2026-12-14")?.key, "atraso-1");
  assert.equal(dueStage(c, s, "2026-12-15")?.key, "atraso-5");
});

test("régua: etapa enviada não repete e app parado pula etapas antigas", () => {
  const s = DEFAULT_SETTINGS;
  const c = charge({ reminders: { antes: { at: "x", via: "robo" } } });
  assert.equal(dueStage(c, s, "2026-12-08"), null);
  assert.equal(dueStage(c, s, "2026-12-10")?.key, "vencimento");
  // Ninguém enviou nada e já passou 6 dias: manda só a de 5 dias de atraso.
  assert.equal(dueStage(charge(), s, "2026-12-16")?.key, "atraso-5");
  // Etapa posterior já tratada encerra as anteriores.
  const late = charge({ reminders: { "atraso-5": { at: "x", via: "manual" } } });
  assert.equal(dueStage(late, s, "2026-12-16"), null);
});

test("régua: cobrança paga ou cancelada não entra na fila", () => {
  assert.equal(dueStage(charge({ status: "paid" }), DEFAULT_SETTINGS, "2026-12-10"), null);
  assert.equal(dueStage(charge({ status: "canceled" }), DEFAULT_SETTINGS, "2026-12-10"), null);
});

test("fila monta a mensagem com as variáveis", () => {
  const d = data([client()], [charge()]);
  const [item] = computeQueue(d, "2026-12-12");
  assert.equal(item.stageKey, "atraso-1");
  assert.match(item.message, /^Olá Maria,/);
  assert.match(item.message, /R\$ 250,00/);
  assert.match(item.message, /10\/12\/2026/);
  assert.match(item.message, /https:\/\/pagar\/1/);
  assert.ok(item.whatsappUrl.startsWith("https://wa.me/5519999998888?text="));
  assert.equal(item.missingPaymentLink, false);
});

test("fila ignora clientes desativados", () => {
  const d = data([client({ active: false })], [charge()]);
  assert.equal(computeQueue(d, "2026-12-10").length, 0);
});

test("registrar envio tira da fila e grava no histórico", () => {
  const d = data([client()], [charge()]);
  recordReminder(d, "cob_1", "vencimento", "robo", "Este número não tem WhatsApp");
  assert.equal(computeQueue(d, "2026-12-10").length, 0);
  assert.equal(d.sendLog[0].ok, false);
  assert.equal(d.charges[0].reminders.vencimento.error, "Este número não tem WhatsApp");
});

test("rotina gera e cria link no gateway simulado", async () => {
  const d = data();
  const summary = await runBillingJobs(d, new SimulatedGateway("http://x"), "2026-12-05");
  assert.equal(summary.created, 1);
  assert.equal(summary.linked, 1);
  assert.equal(d.charges[0].paymentUrl, `http://x/pagamento-simulado/${d.charges[0].id}`);
});

test("status do Asaas", () => {
  assert.equal(mapAsaasStatus("RECEIVED"), "paid");
  assert.equal(mapAsaasStatus("CONFIRMED"), "paid");
  assert.equal(mapAsaasStatus("OVERDUE"), "pending");
  assert.equal(mapAsaasStatus("PENDING", true), "canceled");
});

test("janela de envio do robô (horário de Brasília)", () => {
  const r = DEFAULT_SETTINGS.robot; // 9h às 18h, sábado sim, domingo não
  assert.ok(inSendingWindow(r, new Date("2026-11-27T13:00:00Z"))); // sexta 10h
  assert.ok(!inSendingWindow(r, new Date("2026-11-27T11:30:00Z"))); // sexta 8h30
  assert.ok(!inSendingWindow(r, new Date("2026-11-27T21:00:00Z"))); // sexta 18h
  assert.ok(inSendingWindow(r, new Date("2026-11-28T13:00:00Z"))); // sábado
  assert.ok(!inSendingWindow(r, new Date("2026-11-29T13:00:00Z"))); // domingo
});

test("robô envia uma por vez, respeita intervalo e não cobra quem já pagou", async () => {
  const { Store } = await import("./db.ts");
  const { BillingRobot } = await import("./robot.ts");
  const os = await import("os");
  const path = await import("path");
  const fs = await import("fs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robo-"));
  const store = new Store(path.join(dir, "db.json"));
  const today = todayISO();
  const due = (days: number) => {
    const d = new Date(today + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  store.data.clients.push(client(), client({ id: "cli_2", name: "Pedro Lima", phone: "5519911112222" }));
  store.data.charges.push(
    charge({ id: "a", dueDate: due(-1), gatewayId: "pay_a" }),
    charge({ id: "b", clientId: "cli_2", dueDate: due(-2), gatewayId: "pay_b" }),
  );
  Object.assign(store.data.settings.robot, {
    enabled: true, startHour: 0, endHour: 24, sendOnSaturday: true, sendOnSunday: true,
    minDelaySeconds: 3600, maxDelaySeconds: 3600,
  });
  const sent: string[] = [];
  const fakeWa = { state: "conectado", send: async (phone: string) => void sent.push(phone) };
  const paidInGateway = new Set(["pay_b"]);
  const fakeGateway = {
    ...new SimulatedGateway("http://x"),
    getStatus: async (id: string) => (paidInGateway.has(id) ? ("paid" as const) : ("pending" as const)),
  };
  const robot = new BillingRobot(store, fakeWa as never, fakeGateway as never);

  await robot.tick(); // "b" vence antes, mas já foi paga no gateway: dá baixa e não envia
  assert.equal(store.data.charges.find((c) => c.id === "b")!.status, "paid");
  assert.deepEqual(sent, []);
  await robot.tick(); // ainda dentro do intervalo entre envios
  assert.deepEqual(sent, []);

  (robot as unknown as { nextAllowedAt: number }).nextAllowedAt = 0;
  await robot.tick();
  assert.deepEqual(sent, ["5519999998888"]);
  assert.equal(store.data.charges.find((c) => c.id === "a")!.reminders["atraso-1"].via, "robo");
  assert.equal(store.data.meta.robotSentToday, 1);

  (robot as unknown as { nextAllowedAt: number }).nextAllowedAt = 0;
  await robot.tick(); // nada mais na fila
  assert.equal(sent.length, 1);

  fakeWa.state = "desconectado";
  store.data.charges.push(charge({ id: "c", dueDate: due(0), gatewayId: "pay_c" }));
  (robot as unknown as { nextAllowedAt: number }).nextAllowedAt = 0;
  await robot.tick(); // desconectado: não envia
  assert.equal(sent.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
