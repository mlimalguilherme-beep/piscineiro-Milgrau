import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { Client } from "../../shared/types.ts";
import { formatBRL, formatPhone, parseBRL, todayISO } from "../../shared/format.ts";
import { api } from "../api.ts";
import { Badge, Modal, Notice, SectionTitle, useApi } from "../components/ui.tsx";

export default function ClientsPage() {
  const clients = useApi(() => api<Client[]>("GET", "/clients"));
  const [editing, setEditing] = useState<Client | "new" | null>(null);
  const [search, setSearch] = useState("");

  const list = (clients.data ?? [])
    .filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  const monthly = (clients.data ?? []).filter((c) => c.active).reduce((s, c) => s + c.monthlyAmountCents, 0);

  return (
    <div>
      {clients.error && <Notice kind="error">{clients.error}</Notice>}
      <div className="grid grid-cols-2 gap-3">
        <div className="card">
          <p className="text-xs text-slate-500">Clientes ativos</p>
          <p className="text-2xl font-bold">{(clients.data ?? []).filter((c) => c.active).length}</p>
        </div>
        <div className="card">
          <p className="text-xs text-slate-500">Receita mensal prevista</p>
          <p className="text-2xl font-bold">{formatBRL(monthly)}</p>
        </div>
      </div>

      <SectionTitle
        right={
          <button className="btn-primary" onClick={() => setEditing("new")}>
            <Plus size={16} /> Novo cliente
          </button>
        }
      >
        Clientes
      </SectionTitle>
      <input className="input mb-2" placeholder="Buscar por nome…" value={search} onChange={(e) => setSearch(e.target.value)} />

      <div className="space-y-2">
        {clients.data && list.length === 0 && (
          <div className="card text-center text-sm text-slate-500">Nenhum cliente cadastrado ainda.</div>
        )}
        {list.map((c) => (
          <div key={c.id} className={`card flex items-center justify-between gap-3 ${c.active ? "" : "opacity-60"}`}>
            <div className="min-w-0">
              <p className="truncate font-semibold">
                {c.name} {!c.active && <Badge color="slate">Inativo</Badge>}
              </p>
              <p className="text-xs text-slate-500">
                {formatPhone(c.phone)} · {formatBRL(c.monthlyAmountCents)} todo dia {c.dueDay}
              </p>
            </div>
            <button className="btn-ghost shrink-0" onClick={() => setEditing(c)}>
              <Pencil size={14} /> Editar
            </button>
          </div>
        ))}
      </div>

      {editing && (
        <ClientForm
          client={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            clients.reload();
          }}
        />
      )}
    </div>
  );
}

function ClientForm({ client, onClose, onSaved }: { client: Client | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: client?.name ?? "",
    phone: client ? formatPhone(client.phone) : "",
    cpfCnpj: client?.cpfCnpj ?? "",
    amount: client ? (client.monthlyAmountCents / 100).toFixed(2).replace(".", ",") : "",
    dueDay: String(client?.dueDay ?? 10),
    description: client?.description ?? "Manutenção de piscina",
    billingStartDate: client?.billingStartDate ?? todayISO(),
    notes: client?.notes ?? "",
    active: client?.active ?? true,
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const monthlyAmountCents = parseBRL(form.amount);
    if (monthlyAmountCents === null) return setError("Valor mensal inválido. Ex.: 250,00");
    setSaving(true);
    setError("");
    try {
      const body = { ...form, monthlyAmountCents, dueDay: Number(form.dueDay) };
      if (client) await api("PUT", `/clients/${client.id}`, body);
      else await api("POST", "/clients", body);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!client || !confirm(`Excluir ${client.name}?`)) return;
    try {
      await api("DELETE", `/clients/${client.id}`);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal title={client ? "Editar cliente" : "Novo cliente"} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <div>
          <label className="label">Nome</label>
          <input className="input" value={form.name} onChange={set("name")} required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">WhatsApp (com DDD)</label>
            <input className="input" inputMode="tel" placeholder="(19) 99999-8888" value={form.phone} onChange={set("phone")} required />
          </div>
          <div>
            <label className="label">CPF ou CNPJ</label>
            <input className="input" inputMode="numeric" value={form.cpfCnpj} onChange={set("cpfCnpj")} required />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Valor mensal (R$)</label>
            <input className="input" inputMode="decimal" placeholder="250,00" value={form.amount} onChange={set("amount")} required />
          </div>
          <div>
            <label className="label">Dia do vencimento</label>
            <input className="input" type="number" min={1} max={31} value={form.dueDay} onChange={set("dueDay")} required />
          </div>
        </div>
        <div>
          <label className="label">Descrição na cobrança</label>
          <input className="input" value={form.description} onChange={set("description")} />
        </div>
        <div>
          <label className="label">Cobrar mensalidades com vencimento a partir de</label>
          <input className="input" type="date" value={form.billingStartDate} onChange={set("billingStartDate")} required />
        </div>
        <div>
          <label className="label">Observações</label>
          <textarea className="input" rows={2} value={form.notes} onChange={set("notes")} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.active} onChange={set("active")} /> Cliente ativo (recebe cobranças)
        </label>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex justify-between gap-2 pt-2">
          {client ? (
            <button type="button" className="btn-danger" onClick={remove}>
              Excluir
            </button>
          ) : (
            <span />
          )}
          <button className="btn-primary" disabled={saving}>
            Salvar
          </button>
        </div>
      </form>
    </Modal>
  );
}
