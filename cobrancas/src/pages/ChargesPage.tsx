import { useState } from "react";
import { Ban, Check, Copy, ExternalLink, MessageCircle, Plus, RefreshCw } from "lucide-react";
import { Charge, Client } from "../../shared/types.ts";
import { formatBRL, formatDateBR, parseBRL, todayISO } from "../../shared/format.ts";
import { api } from "../api.ts";
import { Badge, Modal, Notice, SectionTitle, useApi } from "../components/ui.tsx";

type Filter = "pending" | "late" | "paid" | "all";

export default function ChargesPage() {
  const charges = useApi(() => api<Charge[]>("GET", "/charges"));
  const clients = useApi(() => api<Client[]>("GET", "/clients"));
  const [filter, setFilter] = useState<Filter>("pending");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const today = todayISO();

  const byId = new Map((clients.data ?? []).map((c) => [c.id, c]));
  const all = charges.data ?? [];
  const list = all.filter((c) =>
    filter === "all" ? true : filter === "late" ? c.status === "pending" && c.dueDate < today : c.status === filter,
  );
  const sum = (xs: Charge[]) => xs.reduce((s, c) => s + c.amountCents, 0);
  const pending = all.filter((c) => c.status === "pending");
  const late = pending.filter((c) => c.dueDate < today);
  const month = today.slice(0, 7);
  const paidThisMonth = all.filter((c) => c.status === "paid" && c.paidAt?.slice(0, 7) === month);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
      charges.reload();
    }
  }

  async function sendWhatsApp(charge: Charge) {
    // Abre a janela antes do await para o navegador não bloquear o pop-up.
    const win = window.open("", "_blank");
    try {
      const { whatsappUrl, stageKey } = await api<{ whatsappUrl: string; stageKey: string }>("GET", `/charges/${charge.id}/message`);
      if (win) win.location.href = whatsappUrl;
      else window.location.href = whatsappUrl;
      await api("POST", `/charges/${charge.id}/reminders/${stageKey}`, {});
    } catch (e) {
      win?.close();
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="A receber" value={formatBRL(sum(pending))} sub={`${pending.length} cobrança(s)`} />
        <Stat label="Em atraso" value={formatBRL(sum(late))} sub={`${late.length} cobrança(s)`} danger={late.length > 0} />
        <Stat label="Recebido no mês" value={formatBRL(sum(paidThisMonth))} sub={`${paidThisMonth.length} pagamento(s)`} />
      </div>

      <SectionTitle
        right={
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> Cobrança avulsa
          </button>
        }
      >
        Cobranças
      </SectionTitle>

      <div className="mb-3 flex gap-1 overflow-x-auto">
        {(
          [
            ["pending", "Pendentes"],
            ["late", "Atrasadas"],
            ["paid", "Pagas"],
            ["all", "Todas"],
          ] as [Filter, string][]
        ).map(([id, label]) => (
          <button key={id} onClick={() => setFilter(id)} className={filter === id ? "btn-primary" : "btn-ghost"}>
            {label}
          </button>
        ))}
      </div>

      {error && <div className="mb-2"><Notice kind="error">{error}</Notice></div>}
      {charges.data && list.length === 0 && <div className="card text-center text-sm text-slate-500">Nenhuma cobrança aqui.</div>}

      <div className="space-y-2">
        {list.map((c) => {
          const client = byId.get(c.clientId);
          const isLate = c.status === "pending" && c.dueDate < today;
          const lastReminder = Object.values(c.reminders).sort((a, b) => b.at.localeCompare(a.at))[0];
          return (
            <div key={c.id} className="card">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold">{client?.name ?? "Cliente removido"}</p>
                  <p className="text-xs text-slate-500">{c.description}</p>
                  <p className="text-sm">
                    <b>{formatBRL(c.amountCents)}</b> · vence {formatDateBR(c.dueDate)}
                  </p>
                </div>
                {c.status === "paid" ? (
                  <Badge color="green">Pago{c.paidVia === "manual" ? " (manual)" : ""}</Badge>
                ) : c.status === "canceled" ? (
                  <Badge color="slate">Cancelada</Badge>
                ) : isLate ? (
                  <Badge color="red">Atrasada</Badge>
                ) : (
                  <Badge color="amber">Pendente</Badge>
                )}
              </div>
              {lastReminder && (
                <p className={`mt-1 text-xs ${lastReminder.error ? "text-red-600" : "text-slate-500"}`}>
                  Última mensagem: {new Date(lastReminder.at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
                  {lastReminder.via === "pulado" ? " (pulada)" : lastReminder.via === "robo" ? " pelo robô" : " (manual)"}
                  {lastReminder.error && `. Falhou: ${lastReminder.error}`}
                </p>
              )}
              {c.gatewayError && c.status === "pending" && (
                <p className="mt-1 text-xs text-amber-700">Erro ao gerar link de pagamento: {c.gatewayError}</p>
              )}
              {c.status === "pending" && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button className="btn-green" disabled={!client} onClick={() => sendWhatsApp(c)}>
                    <MessageCircle size={14} /> Cobrar
                  </button>
                  {c.paymentUrl ? (
                    <>
                      <button
                        className="btn-ghost"
                        onClick={() => navigator.clipboard.writeText(c.paymentUrl!).catch(() => prompt("Copie o link:", c.paymentUrl))}
                      >
                        <Copy size={14} /> Copiar link
                      </button>
                      <a className="btn-ghost" href={c.paymentUrl} target="_blank" rel="noopener">
                        <ExternalLink size={14} /> Abrir
                      </a>
                    </>
                  ) : (
                    <button className="btn-ghost" disabled={busy === c.id} onClick={() => act(c.id, () => api("POST", `/charges/${c.id}/retry-gateway`))}>
                      <RefreshCw size={14} /> Gerar link
                    </button>
                  )}
                  <button
                    className="btn-ghost"
                    disabled={busy === c.id}
                    onClick={() => confirm("Marcar como paga (recebido por fora)?") && act(c.id, () => api("POST", `/charges/${c.id}/paid`))}
                  >
                    <Check size={14} /> Marcar paga
                  </button>
                  <button
                    className="btn-danger"
                    disabled={busy === c.id}
                    onClick={() => confirm("Cancelar esta cobrança? O link de pagamento deixa de funcionar.") && act(c.id, () => api("POST", `/charges/${c.id}/cancel`))}
                  >
                    <Ban size={14} /> Cancelar
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {creating && (
        <NewChargeForm
          clients={(clients.data ?? []).filter((c) => c.active)}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            charges.reload();
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, sub, danger }: { label: string; value: string; sub: string; danger?: boolean }) {
  return (
    <div className="card p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-base font-bold sm:text-xl ${danger ? "text-red-600" : ""}`}>{value}</p>
      <p className="text-xs text-slate-400">{sub}</p>
    </div>
  );
}

function NewChargeForm({ clients, onClose, onSaved }: { clients: Client[]; onClose: () => void; onSaved: () => void }) {
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(todayISO());
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const amountCents = parseBRL(amount);
    if (amountCents === null) return setError("Valor inválido. Ex.: 150,00");
    setSaving(true);
    setError("");
    try {
      await api("POST", "/charges", { clientId, amountCents, dueDate, description });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Cobrança avulsa" onClose={onClose}>
      {clients.length === 0 ? (
        <Notice kind="warn">Cadastre um cliente primeiro.</Notice>
      ) : (
        <form onSubmit={save} className="space-y-3">
          <p className="text-sm text-slate-600">Para serviços extras: troca de areia, conserto da bomba, produtos…</p>
          <div>
            <label className="label">Cliente</label>
            <select className="input" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Descrição</label>
            <input className="input" placeholder="Troca de areia do filtro" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Valor (R$)</label>
              <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            </div>
            <div>
              <label className="label">Vencimento</label>
              <input className="input" type="date" min={todayISO()} value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
            </div>
          </div>
          {error && <Notice kind="error">{error}</Notice>}
          <div className="flex justify-end pt-2">
            <button className="btn-primary" disabled={saving}>
              Criar cobrança
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
