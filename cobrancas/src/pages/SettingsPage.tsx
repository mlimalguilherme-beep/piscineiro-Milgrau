import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ReminderStage, Settings, TEMPLATE_VARIABLES } from "../../shared/types.ts";
import { api } from "../api.ts";
import { Notice, SectionTitle } from "../components/ui.tsx";

function offsetLabel(n: number): string {
  if (n === 0) return "no dia do vencimento";
  return n < 0 ? `${-n} dia(s) antes do vencimento` : `${n} dia(s) depois do vencimento`;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<Settings>("GET", "/settings").then(setSettings).catch((e) => setMessage({ kind: "error", text: e.message }));
  }, []);

  if (!settings) return <p className="text-sm text-slate-500">Carregando…</p>;

  const robot = settings.robot;
  const setRobot = (patch: Partial<Settings["robot"]>) => setSettings({ ...settings, robot: { ...robot, ...patch } });
  const setStage = (i: number, patch: Partial<ReminderStage>) =>
    setSettings({ ...settings, stages: settings.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      setSettings(await api<Settings>("PUT", "/settings", settings));
      setMessage({ kind: "ok", text: "Configurações salvas." });
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <SectionTitle>Geral</SectionTitle>
      <div className="card grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Nome do seu negócio (assinatura das mensagens)</label>
          <input className="input" value={settings.businessName} onChange={(e) => setSettings({ ...settings, businessName: e.target.value })} />
        </div>
        <div>
          <label className="label">Gerar a mensalidade quantos dias antes do vencimento</label>
          <input
            className="input"
            type="number"
            min={0}
            max={28}
            value={settings.daysAheadToGenerate}
            onChange={(e) => setSettings({ ...settings, daysAheadToGenerate: Number(e.target.value) })}
          />
        </div>
      </div>

      <SectionTitle>Robô</SectionTitle>
      <div className="card space-y-3">
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={robot.enabled} onChange={(e) => setRobot({ enabled: e.target.checked })} />
          Robô ligado (envia sozinho pelo WhatsApp conectado)
        </label>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <label className="label">Enviar a partir de (hora)</label>
            <input className="input" type="number" min={0} max={23} value={robot.startHour} onChange={(e) => setRobot({ startHour: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label">Parar às (hora)</label>
            <input className="input" type="number" min={1} max={24} value={robot.endHour} onChange={(e) => setRobot({ endHour: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label">Intervalo mín. (seg)</label>
            <input className="input" type="number" min={10} value={robot.minDelaySeconds} onChange={(e) => setRobot({ minDelaySeconds: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label">Intervalo máx. (seg)</label>
            <input className="input" type="number" min={10} value={robot.maxDelaySeconds} onChange={(e) => setRobot({ maxDelaySeconds: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label">Limite por dia</label>
            <input className="input" type="number" min={1} value={robot.dailyLimit} onChange={(e) => setRobot({ dailyLimit: Number(e.target.value) })} />
          </div>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={robot.sendOnSaturday} onChange={(e) => setRobot({ sendOnSaturday: e.target.checked })} /> Enviar aos sábados
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={robot.sendOnSunday} onChange={(e) => setRobot({ sendOnSunday: e.target.checked })} /> Enviar aos domingos
          </label>
        </div>
        <p className="text-xs text-slate-500">
          O intervalo aleatório entre mensagens e o limite diário diminuem o risco de o WhatsApp bloquear seu número.
          Evite reduzir muito.
        </p>
      </div>

      <SectionTitle
        right={
          <button
            className="btn-ghost"
            onClick={() =>
              setSettings({
                ...settings,
                stages: [
                  ...settings.stages,
                  {
                    key: `etapa-${Date.now()}`,
                    label: "Nova etapa",
                    offsetDays: Math.max(0, ...settings.stages.map((s) => s.offsetDays)) + 5,
                    enabled: true,
                    template: "Olá {nome}! A mensalidade de {valor} venceu em {vencimento}. Link: {link}",
                  },
                ],
              })
            }
          >
            <Plus size={14} /> Etapa
          </button>
        }
      >
        Régua de cobrança
      </SectionTitle>
      <Notice>
        Variáveis que você pode usar nas mensagens:{" "}
        {TEMPLATE_VARIABLES.map(([v, d]) => (
          <span key={v} className="mr-2 whitespace-nowrap" title={d}>
            <code className="rounded bg-white px-1">{v}</code>
          </span>
        ))}
      </Notice>
      {settings.stages.map((stage, i) => (
        <div key={stage.key} className={`card space-y-2 ${stage.enabled ? "" : "opacity-60"}`}>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" checked={stage.enabled} onChange={(e) => setStage(i, { enabled: e.target.checked })} />
            </label>
            <div className="min-w-40 flex-1">
              <label className="label">Nome da etapa</label>
              <input className="input" value={stage.label} onChange={(e) => setStage(i, { label: e.target.value })} />
            </div>
            <div className="w-28">
              <label className="label">Dias (− antes, + depois)</label>
              <input className="input" type="number" value={stage.offsetDays} onChange={(e) => setStage(i, { offsetDays: Number(e.target.value) })} />
            </div>
            <button
              className="btn-danger"
              aria-label="Remover etapa"
              onClick={() => setSettings({ ...settings, stages: settings.stages.filter((_, j) => j !== i) })}
            >
              <Trash2 size={14} />
            </button>
          </div>
          <p className="text-xs text-slate-500">Enviada {offsetLabel(stage.offsetDays)}, se a cobrança ainda não estiver paga.</p>
          <textarea className="input" rows={5} value={stage.template} onChange={(e) => setStage(i, { template: e.target.value })} />
        </div>
      ))}

      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      <div className="sticky bottom-16 flex justify-end sm:bottom-4">
        <button className="btn-primary shadow-lg" disabled={saving} onClick={save}>
          Salvar configurações
        </button>
      </div>
    </div>
  );
}
