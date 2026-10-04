import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResumableGenerationWorker } from "../dist/index.js";
import { SqliteJobRepository } from "@flowforge/storage";

function createJob(dbPath, id, status) {
  const repository = new SqliteJobRepository(dbPath);
  repository.create({ projectId: "project-1", sceneId: "scene-1", provider: "fake-provider", prompt: "FLOWFORGE RECOVERY TEST — DO NOT GENERATE", references: [] }, id);
  for (const next of ["PREPARING", "SUBMITTING"]) repository.transition(id, next);
  repository.setExternalId(id, "external-1");
  repository.transition(id, "GENERATING");
  if (status === "VERIFYING") repository.transition(id, "VERIFYING");
  if (status === "DOWNLOADING") { repository.transition(id, "VERIFYING"); repository.transition(id, "DOWNLOADING"); }
  if (status === "VALIDATING") {
    repository.transition(id, "VERIFYING");
    repository.transition(id, "DOWNLOADING");
    repository.transition(id, "VALIDATING");
  }
  return repository;
}

const dir = mkdtempSync(join(tmpdir(), "flowforge-1h-"));
const dbPath = join(dir, "jobs.sqlite");
const asset = join(dir, "clip.mp4");
writeFileSync(asset, "FLOWFORGE RECOVERY ASSET");

let completionCalls = 0;
let submitCalls = 0;
const provider = {
  id: "fake-provider",
  async connect() {},
  async inspectState() { return { ready: true }; },
  async submit() { submitCalls += 1; return { externalId: "external-1" }; },
  async waitForCompletion() {
    completionCalls += 1;
    return { jobId: "job-1", provider: "fake-provider", status: "COMPLETED", assets: [asset] };
  },
  async download() { return [asset]; },
  async disconnect() {},
};

const first = createJob(dbPath, "job-1", "GENERATING");
first.close();
const recovered = new SqliteJobRepository(dbPath);
const worker = new ResumableGenerationWorker(recovered, () => provider);
const step1 = await worker.resumeOnce("job-1");
assert.equal(step1?.status, "VERIFYING");
assert.equal(submitCalls, 0);
assert.equal(completionCalls, 1);
recovered.close();
console.log("[Phase 1H] restart recovery from GENERATING: PASS");

const second = new SqliteJobRepository(dbPath);
const step2 = await new ResumableGenerationWorker(second, () => provider).resumeOnce("job-1");
assert.equal(step2?.status, "VALIDATING");
assert.equal(submitCalls, 0);
second.close();
console.log("[Phase 1H] resume from VERIFYING without resubmission: PASS");

const third = new SqliteJobRepository(dbPath);
const step3 = await new ResumableGenerationWorker(third, () => provider).resumeOnce("job-1");
assert.equal(step3?.status, "COMPLETED");
assert.equal(third.get("job-1")?.status, "COMPLETED");
assert.equal(submitCalls, 0);
third.close();
console.log("[Phase 1H] resume from VALIDATING to COMPLETED: PASS");

const completed = new SqliteJobRepository(dbPath);
const final = await new ResumableGenerationWorker(completed, () => provider).resumeOnce("job-1");
assert.equal(final?.status, "COMPLETED");
completed.close();
console.log("[Phase 1H] completed job is idempotent: PASS");

console.log("[Phase 1H] Google Flow submission: NONE");
