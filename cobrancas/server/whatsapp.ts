import fs from "fs";
import QRCode from "qrcode";
import pino from "pino";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
} from "baileys";
import { WhatsAppState } from "../shared/types.ts";

const logger = pino({ level: "silent" });

/**
 * Conexão com o WhatsApp do próprio usuário, no mesmo esquema do WhatsApp Web
 * (aparelho conectado, via QR Code). A sessão fica salva em `authDir`, então
 * depois de ler o QR uma vez o app reconecta sozinho ao reiniciar.
 */
export class WhatsAppSession {
  state: WhatsAppState = "desconectado";
  qrDataUrl?: string;
  phone?: string;
  error?: string;
  private sock?: WASocket;
  private wasConnected = false;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(private authDir: string) {}

  hasSavedSession(): boolean {
    return fs.existsSync(`${this.authDir}/creds.json`);
  }

  async connect(): Promise<void> {
    if (this.state === "conectado" || this.state === "conectando" || this.state === "aguardando-qr") return;
    clearTimeout(this.reconnectTimer);
    this.state = "conectando";
    try {
      await this.open();
    } catch (err) {
      this.state = "desconectado";
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  private async open(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      // usa a versão padrão da biblioteca
    }
    const sock = makeWASocket({
      version,
      logger,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      browser: ["Cobrancas Piscineiro", "Chrome", "1.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async (update) => {
      if (this.sock !== sock) return;
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.state = "aguardando-qr";
        this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 300 });
      }
      if (connection === "open") {
        this.state = "conectado";
        this.wasConnected = true;
        this.qrDataUrl = undefined;
        this.error = undefined;
        this.phone = sock.user?.id.split(":")[0].split("@")[0];
      }
      if (connection === "close") {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode;
        const waitingQr = this.state === "aguardando-qr";
        this.sock = undefined;
        this.state = "desconectado";
        this.qrDataUrl = undefined;
        if (code === DisconnectReason.loggedOut) {
          // Desconectado pelo celular: apaga a sessão, precisa ler o QR de novo.
          this.wasConnected = false;
          fs.rmSync(this.authDir, { recursive: true, force: true });
          this.error = "O WhatsApp foi desconectado pelo celular. Conecte de novo lendo o QR Code.";
          return;
        }
        if (waitingQr && !this.wasConnected && code !== DisconnectReason.restartRequired) {
          // Ninguém leu o QR a tempo: para de gerar QR até o usuário pedir de novo.
          this.error = "O QR Code expirou. Clique em conectar para gerar outro.";
          return;
        }
        const reason = lastDisconnect?.error?.message ?? `código ${code}`;
        if (!this.wasConnected && !this.hasSavedSession() && code !== DisconnectReason.restartRequired) {
          // Nunca conectou e nem chegou a gerar QR: provavelmente sem internet até o WhatsApp.
          this.error = `Não foi possível falar com o WhatsApp (${reason}). Verifique a internet do servidor e tente de novo.`;
          return;
        }
        // Queda de conexão comum (ou reinício pedido após ler o QR): reconecta.
        if (code !== DisconnectReason.restartRequired) this.error = `Conexão caiu (${reason}). Reconectando…`;
        this.reconnectTimer = setTimeout(() => void this.connect(), code === DisconnectReason.restartRequired ? 500 : 15000);
      }
    });
  }

  async logout(): Promise<void> {
    clearTimeout(this.reconnectTimer);
    const sock = this.sock;
    this.sock = undefined;
    try {
      await sock?.logout();
    } catch {
      sock?.end(undefined);
    }
    fs.rmSync(this.authDir, { recursive: true, force: true });
    this.state = "desconectado";
    this.wasConnected = false;
    this.qrDataUrl = undefined;
    this.phone = undefined;
  }

  /** Envia texto. Lança erro com mensagem amigável se não der. */
  async send(phone: string, text: string): Promise<void> {
    if (this.state !== "conectado" || !this.sock) throw new Error("WhatsApp não está conectado");
    // Resolve o número real no WhatsApp (resolve o caso do 9º dígito em celulares antigos).
    const result = (await this.sock.onWhatsApp(phone))?.[0];
    if (!result?.exists) throw new Error("Este número não tem WhatsApp");
    await this.sock.sendMessage(result.jid, { text });
  }
}
