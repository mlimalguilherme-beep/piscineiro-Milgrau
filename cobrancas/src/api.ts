const KEY = "cobrancas-token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    // navegador sem armazenamento: o login vale só nesta aba
  }
  memoryToken = token;
}

let memoryToken: string | null = getToken();
let onUnauthorized: () => void = () => {};

export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(memoryToken ? { Authorization: `Bearer ${memoryToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/login") {
    setToken(null);
    onUnauthorized();
  }
  if (!res.ok) throw new Error(json.error ?? `Erro ${res.status}`);
  return json as T;
}
