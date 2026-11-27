import { RobotSettings, StatusInfo } from "../shared/types.ts";
import { todayISO } from "../shared/format.ts";
import { Data, Store } from "./db.ts";
import { Gateway } from "./gateway.ts";
import { WhatsAppSession } from "./whatsapp.ts";
import { computeQueue, markPaid } from "./billing.ts";

const LOG_LIMIT = 300;

/** Hora (0-23) e dia da semana (0 = domingo) no fuso de Brasília. */
export function brasiliaClock(now: Date = new Date()): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    hour: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  const wd = parts.find((p) => p.type === "weekday")!.value;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  return { hour, weekday };
}

export function inSendingWindow(robot: RobotSettings, now: Date = new Date()): boolean {
  const { hour, weekday } = brasiliaClock(now);
  if (weekday === 0 && !robot.sendOnSunday) return false;
  if (weekday === 6 && !robot.sendOnSaturday) return false;
  return hour >= robot.startHour && hour < robot.endHour;
}

/** Registra que a etapa da régua foi tratada (enviada, pulada ou falhou) e grava no histórico. */
export function recordReminder(
  data: Data,
  chargeId: string,
  stageKey: string,
  via: "robo" | "manual" | "pulado",
  error?: string,
): boolean {
  const charge = data.charges.find((c) => c.id === chargeId);
  const stage = data.settings.stages.find((s) => s.key === stageKey);
  if (!charge || !stage) return false;
  charge.reminders[stageKey] = { at: new Date().toISOString(), via, ...(error ? { error } : {}) };
  if (via !== "pulado") {
    const client = data.clients.find((c) => c.id === charge.clientId);
    data.sendLog.unshift({
      at: new Date().toISOString(),
      chargeId,
      clientName: client?.name ?? "?",
      stageLabel: stage.label,
      via,
      ok: !error,
      ...(error ? { error } : {}),
    });
    data.sendLog.length = Math.min(data.sendLog.length, LOG_LIMIT);
  }
  return true;
}

/**
 * Robô de cobrança: de tempos em tempos olha a fila do dia e envia UMA
 * mensagem pelo WhatsApp, respeitando a janela de horário, o limite diário e
 * um intervalo aleatório entre envios (para não parecer disparo em massa).
 */
export class BillingRobot {
  private busy = false;
  private nextAllowedAt = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    private store: Store,
    private wa: WhatsAppSession,
    private gateway: Gateway,
  ) {}

  start(intervalMs = 15_000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private sentToday(): number {
    const meta = this.store.data.meta;
    return meta.robotDay === todayISO() ? meta.robotSentToday ?? 0 : 0;
  }

  status(): StatusInfo["robot"] {
    const robot = this.store.data.settings.robot;
    const sentToday = this.sentToday();
    const inWindow = inSendingWindow(robot);
    const pending = computeQueue(this.store.data, todayISO()).filter((i) => !i.missingPaymentLink).length;
    let nextInfo: string;
    if (!robot.enabled) nextInfo = "Robô desligado.";
    else if (this.wa.state !== "conectado") nextInfo = "Aguardando o WhatsApp ser conectado.";
    else if (pending === 0) nextInfo = "Nenhuma mensagem pendente hoje.";
    else if (sentToday >= robot.dailyLimit) nextInfo = `Limite diário atingido. ${pending} mensagem(ns) ficam para amanhã.`;
    else if (!inWindow) nextInfo = `${pending} mensagem(ns) aguardando o horário de envio (${robot.startHour}h às ${robot.endHour}h).`;
    else {
      const secs = Math.max(0, Math.round((this.nextAllowedAt - Date.now()) / 1000));
      nextInfo = `${pending} mensagem(ns) na fila. Próximo envio ${secs > 0 ? `em ~${secs}s` : "em instantes"}.`;
    }
    return { enabled: robot.enabled, sentToday, dailyLimit: robot.dailyLimit, inWindow, nextInfo };
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    const data = this.store.data;
    const robot = data.settings.robot;
    if (!robot.enabled || this.wa.state !== "conectado") return;
    if (!inSendingWindow(robot)) return;
    if (this.sentToday() >= robot.dailyLimit) return;
    if (Date.now() < this.nextAllowedAt) return;

    const today = todayISO();
    // Sem link de pagamento não envia: espera a próxima tentativa de gerar o link.
    const item = computeQueue(data, today).find((i) => !i.missingPaymentLink);
    if (!item) return;

    this.busy = true;
    try {
      const charge = data.charges.find((c) => c.id === item.chargeId)!;
      // Confere no gateway antes de cobrar, para não cobrar quem acabou de pagar.
      if (charge.gatewayId) {
        try {
          const status = await this.gateway.getStatus(charge.gatewayId);
          if (status === "paid") {
            markPaid(charge, "gateway");
            this.store.save();
            return;
          }
          if (status === "canceled") {
            charge.status = "canceled";
            this.store.save();
            return;
          }
        } catch {
          // Gateway fora do ar: segue com o envio, a cobrança continua pendente.
        }
      }

      let error: string | undefined;
      try {
        await this.wa.send(item.phone, item.message);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        if (this.wa.state !== "conectado") return; // caiu a conexão: tenta de novo depois
      }
      recordReminder(data, item.chargeId, item.stageKey, "robo", error);
      if (!error) {
        data.meta.robotSentToday = this.sentToday() + 1;
        data.meta.robotDay = today;
      }
      this.store.save();
    } finally {
      const { minDelaySeconds: min, maxDelaySeconds: max } = robot;
      const delay = (min + Math.random() * Math.max(0, max - min)) * 1000;
      this.nextAllowedAt = Date.now() + delay;
      this.busy = false;
    }
  }
}
