import { useEffect, useState } from "react";
import { CalendarClock, LogOut, Receipt, Settings as SettingsIcon, Users, Waves } from "lucide-react";
import { api, getToken, setToken, setUnauthorizedHandler } from "./api.ts";
import TodayPage from "./pages/TodayPage.tsx";
import ChargesPage from "./pages/ChargesPage.tsx";
import ClientsPage from "./pages/ClientsPage.tsx";
import SettingsPage from "./pages/SettingsPage.tsx";

type Tab = "hoje" | "cobrancas" | "clientes" | "config";

const TABS: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: "hoje", label: "Hoje", icon: CalendarClock },
  { id: "cobrancas", label: "Cobranças", icon: Receipt },
  { id: "clientes", label: "Clientes", icon: Users },
  { id: "config", label: "Configurações", icon: SettingsIcon },
];

export default function App() {
  const [logged, setLogged] = useState(!!getToken());
  const [tab, setTab] = useState<Tab>("hoje");

  useEffect(() => setUnauthorizedHandler(() => setLogged(false)), []);

  if (!logged) return <Login onDone={() => setLogged(true)} />;

  return (
    <div className="mx-auto min-h-screen max-w-5xl pb-24 sm:pb-8">
      <header className="flex items-center justify-between px-4 pt-5 pb-3">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-sky-700 p-1.5 text-white">
            <Waves size={20} />
          </div>
          <div>
            <h1 className="text-lg leading-tight font-bold">Robô de Cobrança</h1>
            <p className="text-xs text-slate-500">Mensalidades das piscinas pelo WhatsApp</p>
          </div>
        </div>
        <button
          className="btn-ghost"
          onClick={() => {
            setToken(null);
            setLogged(false);
          }}
        >
          <LogOut size={16} /> Sair
        </button>
      </header>

      <nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-slate-200 bg-white sm:static sm:mx-4 sm:mb-4 sm:gap-1 sm:rounded-xl sm:border-0 sm:p-1 sm:ring-1 sm:ring-slate-200">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs font-medium sm:flex-row sm:justify-center sm:gap-2 sm:rounded-lg sm:text-sm ${
              tab === id ? "text-sky-700 sm:bg-sky-50" : "text-slate-500"
            }`}
          >
            <Icon size={18} />
            {label}
          </button>
        ))}
      </nav>

      <main className="px-4">
        {tab === "hoje" && <TodayPage />}
        {tab === "cobrancas" && <ChargesPage />}
        {tab === "clientes" && <ClientsPage />}
        {tab === "config" && <SettingsPage />}
      </main>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const { token } = await api<{ token: string }>("POST", "/login", { password });
      setToken(token);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-sky-700 p-1.5 text-white">
            <Waves size={20} />
          </div>
          <h1 className="text-lg font-bold">Robô de Cobrança</h1>
        </div>
        <div>
          <label className="label">Senha</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn-primary w-full" disabled={loading || !password}>
          Entrar
        </button>
      </form>
    </div>
  );
}
