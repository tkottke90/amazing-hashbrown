import fs from "node:fs/promises";
import path from "node:path";
import type { ProvenanceEntry } from "./types.js";

export class ProvenanceStore {
  private readonly filePath: string;

  constructor(opts: { path: string }) {
    this.filePath = opts.path;
  }

  async record(entry: ProvenanceEntry): Promise<void> {
    const line = JSON.stringify(entry) + "\n";
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, line, "utf-8");
  }

  async lookup(factText: string): Promise<ProvenanceEntry[]> {
    // NOTE: substring match only. Production use requires fuzzy or vector-based
    // lookup — the model queries with natural-language paraphrases rather than
    // the exact stored claim text, so substring match will often miss.
    const entries = await this._loadAll();
    const lower = factText.toLowerCase();
    return entries.filter((e) => e.claimText.toLowerCase().includes(lower));
  }

  async stale(entityId: string, maxAgeDays: number): Promise<ProvenanceEntry[]> {
    const entries = await this._loadAll();
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    return entries.filter((e) => {
      if (e.entityId !== entityId) return false;
      const age = new Date(e.writtenAt).getTime();
      return age < cutoff;
    });
  }

  private async _loadAll(): Promise<ProvenanceEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProvenanceEntry);
  }
}
