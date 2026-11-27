import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { Charge, Client, DEFAULT_SETTINGS, SendLogEntry, Settings } from "../shared/types.ts";

export interface Data {
  clients: Client[];
  charges: Charge[];
  settings: Settings;
  /** Últimos envios (mais recente primeiro), para conferência no painel. */
  sendLog: SendLogEntry[];
  meta: { lastJobRunAt?: string; lastJobSummary?: string; robotDay?: string; robotSentToday?: number };
}

/**
 * Armazenamento simples em arquivo JSON. Os dados ficam num único objeto em
 * memória (compartilhado por todas as rotas e tarefas) e cada alteração é
 * gravada no disco de forma atômica (arquivo temporário + rename).
 */
export class Store {
  data: Data;

  constructor(private file: string) {
    this.data = this.load();
  }

  private load(): Data {
    if (!fs.existsSync(this.file)) {
      return { clients: [], charges: [], settings: structuredClone(DEFAULT_SETTINGS), sendLog: [], meta: {} };
    }
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Data>;
    return {
      clients: raw.clients ?? [],
      charges: raw.charges ?? [],
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        ...raw.settings,
        robot: { ...DEFAULT_SETTINGS.robot, ...raw.settings?.robot },
      },
      sendLog: raw.sendLog ?? [],
      meta: raw.meta ?? {},
    };
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}
