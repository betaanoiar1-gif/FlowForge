import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderExecutionWorker, SqliteJobQueue } from "../dist/index.js";
import { SqliteJobRepository } from "@flowforge/storage";

const repository = new SqliteJobRepository(join(mkdtempSync(join(tmpdir(), "flowforge-1d-")), "jobs.sqlite"));
const queue = new SqliteJobQueue(repository);
const events = [];
const provider = {
  id: "fake-provider",
  async connect() {},
  async inspectState() { return { ready: true }; },
  async submit() { return { externalId: "external-1" }; },
  async waitForCompletion() { throw new Error("not part of Phase 1D"); },
  async download() { throw new Error("not part of Phase 1D"); },
  async disconnect() {},
};
const job = repository.create({
  projectId: "project-1", sceneId: "scene-1", provider: provider.id,
  prompt: "FLOWFORGE EVENT TEST — DO NOT GENERATE", references: [],
}, "job-1");
queue.enqueue(job.id);

const worker = new ProviderExecutionWorker(repository, queue, () => provider, {
  publish(event) { events.push(event); },
});
const result = await worker.runOnce();
assert.equal(result?.status, "GENERATING");
assert.deepEqual(events.map(e => e.type), [
  "generation.created",
  "generation.preparing",
  "generation.submitting",
  "generation.generating",
]);
assert.equal(events.at(-1).externalId, "external-1");
assert.ok(events.every(e => typeof e.at === "string" && e.at.length > 0));
console.log("[Phase 1D] execution lifecycle events: PASS");
console.log("[Phase 1D] generation.completed event: NOT EMITTED");
console.log("[Phase 1D] Google Flow submission: NONE");
