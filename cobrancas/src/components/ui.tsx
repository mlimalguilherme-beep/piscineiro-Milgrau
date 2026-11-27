import { ReactNode, useEffect, useState } from "react";

/** Carrega dados da API e oferece `reload`. */
export function useApi<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    loader()
      .then((d) => alive && (setData(d), setError("")))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);
  return { data, error, reload: () => setVersion((v) => v + 1) };
}

export function Notice({ kind = "info", children }: { kind?: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  const styles = {
    info: "bg-sky-50 text-sky-900 ring-sky-200",
    warn: "bg-amber-50 text-amber-900 ring-amber-200",
    error: "bg-red-50 text-red-800 ring-red-200",
    ok: "bg-green-50 text-green-800 ring-green-200",
  }[kind];
  return <div className={`rounded-lg px-3 py-2 text-sm ring-1 ${styles}`}>{children}</div>;
}

export function Badge({ color, children }: { color: "green" | "amber" | "red" | "slate" | "sky"; children: ReactNode }) {
  const styles = {
    green: "bg-green-100 text-green-800",
    amber: "bg-amber-100 text-amber-800",
    red: "bg-red-100 text-red-800",
    slate: "bg-slate-100 text-slate-600",
    sky: "bg-sky-100 text-sky-800",
  }[color];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${styles}`}>{children}</span>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 sm:max-w-lg sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button className="text-2xl leading-none text-slate-400" onClick={onClose} aria-label="Fechar">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mt-6 mb-2 flex items-center justify-between gap-2">
      <h2 className="text-sm font-bold tracking-wide text-slate-500 uppercase">{children}</h2>
      {right}
    </div>
  );
}
