// Utilitários puros usados no servidor e no navegador.

const TZ = "America/Sao_Paulo";

/** Data de hoje (YYYY-MM-DD) no fuso de Brasília. */
export function todayISO(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function parse(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
}

/** b - a, em dias. */
export function diffDays(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
}

/** Data de vencimento num mês; dia 31 em fevereiro vira o último dia do mês. */
export function dueDateFor(year: number, month1to12: number, dueDay: number): string {
  const lastDay = new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
  const day = Math.min(Math.max(1, dueDay), lastDay);
  return fmt(new Date(Date.UTC(year, month1to12 - 1, day)));
}

export function formatDateBR(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}

const MONTHS = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/** "2026-12" -> "dezembro/2026"; referências avulsas voltam como estão. */
export function formatReference(ref: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ref);
  if (!m) return "avulsa";
  return `${MONTHS[Number(m[2]) - 1]}/${m[1]}`;
}

export function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
    .format(cents / 100)
    .replace(/ /g, " ");
}

/** "250", "250,00", "1.250,50", "R$ 99,9" -> centavos. Retorna null se inválido. */
export function parseBRL(input: string): number | null {
  const clean = input.replace(/[R$\s]/g, "");
  if (!clean) return null;
  const normalized = clean.includes(",")
    ? clean.replace(/\./g, "").replace(",", ".")
    : clean;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

/**
 * Normaliza telefone brasileiro para o formato do WhatsApp: 55 + DDD + número.
 * Retorna null se não parecer um telefone válido.
 */
export function normalizePhone(input: string): string | null {
  let digits = input.replace(/\D/g, "");
  if (digits.startsWith("0")) digits = digits.replace(/^0+/, "");
  if (digits.length === 10 || digits.length === 11) digits = "55" + digits;
  if (!/^55\d{10,11}$/.test(digits)) return null;
  return digits;
}

export function formatPhone(phone: string): string {
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(phone);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : phone;
}

export function whatsappLink(phone: string, message: string): string {
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? vars[key] : whole,
  );
}

export function isValidCpfCnpj(value: string): boolean {
  const d = value.replace(/\D/g, "");
  if (d.length === 11) return validCpf(d);
  if (d.length === 14) return validCnpj(d);
  return false;
}

function validCpf(d: string): boolean {
  if (/^(\d)\1+$/.test(d)) return false;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const check = ((sum * 10) % 11) % 10;
    if (check !== Number(d[len])) return false;
  }
  return true;
}

function validCnpj(d: string): boolean {
  if (/^(\d)\1+$/.test(d)) return false;
  const weights = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  for (const len of [12, 13]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * weights[i + (13 - len)];
    const rest = sum % 11;
    const check = rest < 2 ? 0 : 11 - rest;
    if (check !== Number(d[len])) return false;
  }
  return true;
}
