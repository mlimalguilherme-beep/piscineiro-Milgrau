import { useEffect, useState } from "react";
import { Bot, CheckCircle2, MessageCircle, Play, RefreshCw, SkipForward, Smartphone, XCircle } from "lucide-react";
import { QueueItem, SendLogEntry, Settings, StatusInfo } from "../../shared/types.ts";
import { formatBRL, formatDateBR, formatPhone } from "../../shared/format.ts";
import { api } from "../api.ts";
import { Badge, Notice, SectionTitle, useApi } from "../components/ui.tsx";

export default function TodayPage() {
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const queue = useApi(() => api<QueueItem[]>("GET", "/queue"));
  const log = useApi(() => api<SendLogEntry[]>("GET", "/log"));

  const refreshStatus = () => api<StatusInfo>("GET", "/status").then(setStatus).catch(() => {});

  // Atualiza com mais frequência enquanto espera a leitura do QR Code.
  useEffect(() => {
    refreshStatus();
    const ms = status?.whatsapp.state === "aguardando-qr" || status?.whatsapp.state === "conectando" ? 2500 : 10000;
    const id = setInterval(() => {
      refreshStatus();
      queue.reload();
      log.reload();
    }, ms);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.whatsapp.state]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
      refreshStatus();
      queue.reload();
      log.reload();
    }
  }

  async function toggleRobot() {
    const settings = await api<Settings>("GET", "/settings");
    await api("PUT", "/settings", { ...settings, robot: { ...settings.robot, enabled: !settings.robot.enabled } });
  }

  function sendManually(item: QueueItem) {
    window.open(item.whatsappUrl, "_blank", "noopener");
    void run("", () => api("POST", `/charges/${item.chargeId}/reminders/${item.stageKey}`, {}));
  }

  if (!status) return <p className="text-sm text-slate-500">Carregando…</p>;
  const wa = status.whatsapp;

  return (
    <div>
      {error && <div className="mb-3"><Notice kind="error">{error}</Notice></div>}
      {status.gatewayMode === "simulado" && (
        <div className="mb-3">
          <Notice kind="warn">
            <b>Modo simulado:</b> os links de pagamento são de teste. Para cobrar de verdade, coloque a chave do Asaas no
            arquivo <code>.env</code> (veja o README).
          </Notice>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {/* Robô */}
        <div className="card">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <Bot className={status.robot.enabled ? "text-green-600" : "text-slate-400"} />
              <div>
                <h3 className="font-bold">Robô de cobrança</h3>
                <Badge color={status.robot.enabled ? "green" : "slate"}>{status.robot.enabled ? "Ligado" : "Desligado"}</Badge>
              </div>
            </div>
            <button
              className={status.robot.enabled ? "btn-ghost" : "btn-green"}
              disabled={!!busy}
              onClick={() => run("robot", toggleRobot)}
            >
              {status.robot.enabled ? "Desligar" : "Ligar robô"}
            </button>
          </div>
          <p className="mt-3 text-sm text-slate-600">{status.robot.nextInfo}</p>
          <p className="mt-1 text-xs text-slate-500">
            Enviadas hoje: {status.robot.sentToday} de {status.robot.dailyLimit}
          </p>
        </div>

        {/* WhatsApp */}
        <div className="card">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <Smartphone className={wa.state === "conectado" ? "text-green-600" : "text-slate-400"} />
              <div>
                <h3 className="font-bold">WhatsApp</h3>
                <Badge color={wa.state === "conectado" ? "green" : wa.state === "desconectado" ? "red" : "amber"}>
                  {{ conectado: "Conectado", desconectado: "Desconectado", "aguardando-qr": "Aguardando QR Code", conectando: "Conectando…" }[wa.state]}
                </Badge>
              </div>
            </div>
            {wa.state === "conectado" ? (
              <button
                className="btn-danger"
                disabled={!!busy}
                onClick={() => confirm("Desconectar o WhatsApp do robô?") && run("wa", () => api("POST", "/whatsapp/logout"))}
              >
                Desconectar
              </button>
            ) : wa.state === "desconectado" ? (
              <button className="btn-primary" disabled={!!busy} onClick={() => run("wa", () => api("POST", "/whatsapp/connect"))}>
                Conectar
              </button>
            ) : null}
          </div>
          {wa.state === "conectado" && wa.phone && (
            <p className="mt-3 text-sm text-slate-600">Enviando pelo número {formatPhone(wa.phone)}</p>
          )}
          {wa.error && <p className="mt-3 text-sm text-red-600">{wa.error}</p>}
          {wa.state === "aguardando-qr" && wa.qrDataUrl && (
            <div className="mt-3 flex flex-col items-center gap-2 text-center">
              <img src={wa.qrDataUrl} alt="QR Code do WhatsApp" className="h-56 w-56" />
              <p className="text-xs text-slate-600">
                No celular: WhatsApp → <b>Aparelhos conectados</b> → <b>Conectar um aparelho</b> e aponte para o código.
              </p>
            </div>
          )}
        </div>
      </div>

      <SectionTitle
        right={
          <button className="btn-ghost" disabled={!!busy} onClick={() => run("jobs", () => api("POST", "/jobs/run"))}>
            <RefreshCw size={14} className={busy === "jobs" ? "animate-spin" : ""} /> Atualizar agora
          </button>
        }
      >
        Mensagens de hoje ({queue.data?.length ?? 0})
      </SectionTitle>
      <p className="mb-2 text-xs text-slate-500">
        {status.lastJobRunAt
          ? `Última verificação ${new Date(status.lastJobRunAt).toLocaleString("pt-BR")}: ${status.lastJobSummary}.`
          : "Ainda não verificou."}{" "}
        O sistema confere pagamentos e gera mensalidades a cada hora.
      </p>

      {queue.data?.length === 0 && (
        <div className="card text-center text-sm text-slate-500">
          <CheckCircle2 className="mx-auto mb-1 text-green-600" /> Nada para cobrar agora.
        </div>
      )}
      <div className="space-y-2">
        {queue.data?.map((item) => (
          <div key={`${item.chargeId}-${item.stageKey}`} className="card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-semibold">{item.clientName}</p>
                <p className="text-xs text-slate-500">
                  {formatBRL(item.amountCents)}, vence {formatDateBR(item.dueDate)}
                  {item.daysLate > 0 && <span className="text-red-600"> ({item.daysLate} dia(s) de atraso)</span>}
                </p>
              </div>
              <Badge color={item.daysLate > 0 ? "red" : "sky"}>{item.stageLabel}</Badge>
            </div>
            {item.missingPaymentLink && (
              <p className="mt-2 text-xs text-amber-700">
                Ainda sem link de pagamento (erro no Asaas). O robô espera o link ser criado; veja em Cobranças.
              </p>
            )}
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-sky-700">Ver mensagem</summary>
              <p className="mt-1 rounded-lg bg-slate-50 p-2 text-sm whitespace-pre-wrap">{item.message}</p>
            </details>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="btn-green" onClick={() => sendManually(item)}>
                <MessageCircle size={16} /> Enviar eu mesmo
              </button>
              {wa.state === "conectado" && (
                <button
                  className="btn-ghost"
                  disabled={!!busy}
                  onClick={() => run("send", () => api("POST", `/charges/${item.chargeId}/send-now`))}
                >
                  <Play size={14} /> Robô enviar agora
                </button>
              )}
              <button
                className="btn-ghost"
                disabled={!!busy}
                onClick={() => run("skip", () => api("POST", `/charges/${item.chargeId}/reminders/${item.stageKey}`, { skipped: true }))}
              >
                <SkipForward size={14} /> Pular
              </button>
            </div>
          </div>
        ))}
      </div>

      <SectionTitle>Últimos envios</SectionTitle>
      <div className="card divide-y divide-slate-100 p-0">
        {log.data?.length === 0 && <p className="p-4 text-sm text-slate-500">Nenhum envio ainda.</p>}
        {log.data?.slice(0, 30).map((l, i) => (
          <div key={i} className="flex items-start gap-2 px-4 py-2 text-sm">
            {l.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-green-600" /> : <XCircle size={16} className="mt-0.5 shrink-0 text-red-600" />}
            <div className="min-w-0 flex-1">
              <p>
                <b>{l.clientName}</b> · {l.stageLabel} · {l.via === "robo" ? "robô" : "manual"}
              </p>
              {l.error && <p className="text-xs text-red-600">{l.error}</p>}
            </div>
            <span className="shrink-0 text-xs text-slate-400">{new Date(l.at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
