import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProvenanceStore } from "../../src/provenance.js";
import type { ProvenanceEntry } from "../../src/types.js";

function entry(overrides: Partial<ProvenanceEntry> = {}): ProvenanceEntry {
  return {
    entityId: "people/marcus",
    claimText: "Marcus Delacroix is the lead on DataBridge",
    sourceDocId: "email-2024-01-15",
    sourceType: "email",
    writtenAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago
    ...overrides,
  };
}

describe("ProvenanceStore", () => {
  let tmpDir: string;
  let store: ProvenanceStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rlm-prov-"));
    store = new ProvenanceStore({ path: path.join(tmpDir, "prov.jsonl") });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("records an entry and retrieves it by substring", async () => {
    await store.record(entry());
    const results = await store.lookup("DataBridge");
    expect(results).to.have.length(1);
    expect(results[0]!.claimText).to.include("DataBridge");
  });

  it("returns empty array for unmatched lookup", async () => {
    await store.record(entry());
    const results = await store.lookup("zzz-no-match");
    expect(results).to.deep.equal([]);
  });

  it("returns empty array when store file does not exist", async () => {
    const results = await store.lookup("anything");
    expect(results).to.deep.equal([]);
  });

  it("records multiple entries and finds each", async () => {
    await store.record(entry({ claimText: "Marcus is the lead on DataBridge" }));
    await store.record(entry({ entityId: "projects/q4", claimText: "Q4 deadline is October 31" }));
    const r1 = await store.lookup("DataBridge");
    expect(r1).to.have.length(1);
    const r2 = await store.lookup("October");
    expect(r2).to.have.length(1);
  });

  it("stale() returns entries older than maxAgeDays", async () => {
    const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(); // 400 days ago
    await store.record(entry({ writtenAt: oldDate }));
    const stale = await store.stale("people/marcus", 365);
    expect(stale).to.have.length(1);
  });

  it("stale() excludes recent entries", async () => {
    await store.record(entry()); // 10 days ago
    const stale = await store.stale("people/marcus", 365);
    expect(stale).to.have.length(0);
  });

  it("stale() filters by entityId", async () => {
    const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    await store.record(entry({ entityId: "other/entity", writtenAt: oldDate }));
    const stale = await store.stale("people/marcus", 365);
    expect(stale).to.have.length(0);
  });
});
