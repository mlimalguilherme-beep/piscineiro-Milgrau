export interface Client {
  id: string;
  name: string;
  /** Telefone com DDD, guardado só com dígitos e com o 55 do Brasil (ex.: 5519999998888). */
  phone: string;
  /** CPF ou CNPJ, só dígitos. Obrigatório para gerar cobrança no Asaas. */
  cpfCnpj: string;
  /** Valor mensal em centavos. */
  monthlyAmountCents: number;
  /** Dia do mês do vencimento (1 a 31; em meses mais curtos vira o último dia). */
  dueDay: number;
  /** Descrição que aparece na cobrança, ex.: "Manutenção de piscina". */
  description: string;
  notes: string;
  active: boolean;
  /** Só gera mensalidades com vencimento a partir desta data (YYYY-MM-DD). */
  billingStartDate: string;
  gatewayCustomerId?: string;
  createdAt: string;
}

export type ChargeStatus = "pending" | "paid" | "canceled";

export interface Charge {
  id: string;
  clientId: string;
  /** "2026-12" para mensalidade, ou "avulsa-..." para cobrança avulsa. */
  reference: string;
  description: string;
  amountCents: number;
  /** YYYY-MM-DD */
  dueDate: string;
  status: ChargeStatus;
  gatewayId?: string;
  paymentUrl?: string;
  pixCode?: string;
  gatewayError?: string;
  paidAt?: string;
  paidVia?: "gateway" | "manual";
  /** Etapa da régua -> quando e como a mensagem foi tratada. */
  reminders: Record<string, ReminderRecord>;
  createdAt: string;
}

export interface ReminderRecord {
  at: string;
  via: "robo" | "manual" | "pulado";
  /** Preenchido quando o robô tentou e não conseguiu enviar. */
  error?: string;
}

export interface RobotSettings {
  /** Liga/desliga o envio automático. */
  enabled: boolean;
  /** Janela de envio (hora de Brasília): envia de startHour até antes de endHour. */
  startHour: number;
  endHour: number;
  sendOnSaturday: boolean;
  sendOnSunday: boolean;
  /** Intervalo aleatório entre mensagens, para parecer envio humano. */
  minDelaySeconds: number;
  maxDelaySeconds: number;
  dailyLimit: number;
}

export interface SendLogEntry {
  at: string;
  chargeId: string;
  clientName: string;
  stageLabel: string;
  via: "robo" | "manual";
  ok: boolean;
  error?: string;
}

export type WhatsAppState = "desconectado" | "aguardando-qr" | "conectando" | "conectado";

export interface ReminderStage {
  key: string;
  label: string;
  /** Dias em relação ao vencimento: -3 = três dias antes, 0 = no dia, 5 = cinco dias depois. */
  offsetDays: number;
  enabled: boolean;
  template: string;
}

export interface Settings {
  businessName: string;
  /** Quantos dias antes do vencimento a mensalidade é criada no gateway. */
  daysAheadToGenerate: number;
  stages: ReminderStage[];
  robot: RobotSettings;
}

export interface QueueItem {
  chargeId: string;
  stageKey: string;
  stageLabel: string;
  clientId: string;
  clientName: string;
  phone: string;
  amountCents: number;
  dueDate: string;
  daysLate: number;
  message: string;
  whatsappUrl: string;
  missingPaymentLink: boolean;
}

export interface StatusInfo {
  gatewayMode: "asaas-sandbox" | "asaas-production" | "simulado";
  webhookConfigured: boolean;
  whatsapp: { state: WhatsAppState; qrDataUrl?: string; phone?: string; error?: string };
  robot: { enabled: boolean; sentToday: number; dailyLimit: number; inWindow: boolean; nextInfo: string };
  lastJobRunAt?: string;
  lastJobSummary?: string;
  today: string;
}

export const TEMPLATE_VARIABLES = [
  ["{nome}", "Primeiro nome do cliente"],
  ["{valor}", "Valor, ex.: R$ 250,00"],
  ["{vencimento}", "Data de vencimento, ex.: 10/12/2026"],
  ["{referencia}", "Mês de referência, ex.: dezembro/2026"],
  ["{link}", "Link de pagamento (Pix, boleto ou cartão)"],
  ["{pix}", "Código Pix copia e cola"],
  ["{dias_atraso}", "Dias de atraso"],
  ["{empresa}", "Nome do seu negócio"],
] as const;

export const DEFAULT_SETTINGS: Settings = {
  businessName: "Piscineiro Mil Grau",
  daysAheadToGenerate: 7,
  robot: {
    enabled: false,
    startHour: 9,
    endHour: 18,
    sendOnSaturday: true,
    sendOnSunday: false,
    minDelaySeconds: 45,
    maxDelaySeconds: 120,
    dailyLimit: 60,
  },
  stages: [
    {
      key: "antes",
      label: "Lembrete antes do vencimento",
      offsetDays: -3,
      enabled: true,
      template:
        "Olá {nome}! Passando para lembrar que a mensalidade da piscina ({referencia}) no valor de {valor} vence em {vencimento}.\n\nPague por Pix, boleto ou cartão neste link: {link}\n\nObrigado! {empresa}",
    },
    {
      key: "vencimento",
      label: "No dia do vencimento",
      offsetDays: 0,
      enabled: true,
      template:
        "Olá {nome}! A mensalidade da piscina de {valor} vence hoje ({vencimento}).\n\nLink para pagamento: {link}\n\nSe já pagou, desconsidere. {empresa}",
    },
    {
      key: "atraso-1",
      label: "1 dia de atraso",
      offsetDays: 1,
      enabled: true,
      template:
        "Olá {nome}, tudo bem? Não identificamos o pagamento da mensalidade de {valor}, que venceu em {vencimento}.\n\nVocê pode pagar por aqui: {link}\n\nSe já pagou, desconsidere. {empresa}",
    },
    {
      key: "atraso-5",
      label: "5 dias de atraso",
      offsetDays: 5,
      enabled: true,
      template:
        "Olá {nome}. A mensalidade de {valor} (vencimento {vencimento}) está em aberto há {dias_atraso} dias.\n\nLink para pagamento: {link}\n\nQualquer dúvida, é só responder. {empresa}",
    },
    {
      key: "atraso-10",
      label: "10 dias de atraso",
      offsetDays: 10,
      enabled: true,
      template:
        "Olá {nome}. Seguimos sem o pagamento da mensalidade de {valor}, vencida em {vencimento} ({dias_atraso} dias de atraso). Podemos conversar para regularizar?\n\nLink: {link}\n\n{empresa}",
    },
  ],
};
