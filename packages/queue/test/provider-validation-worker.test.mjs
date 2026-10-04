import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderValidationWorker } from "../dist/index.js";
import { SqliteJobRepository } from "@flowforge/storage";

function setup(id, provider) {
  const repository = new SqliteJobRepository(join(mkdtempSync(join(tmpdir(), "flowforge-1g-")), "jobs.sqlite"));
  repository.create({ projectId: "project-1", sceneId: "scene-1", provider: provider.id, prompt: "FLOWFORGE VALIDATION TEST — DO NOT GENERATE", references: [] }, id);
  repository.transition(id, "PREPARING");
  repository.transition(id, "SUBMITTING");
  repository.setExternalId(id, "external-1");
  repository.transition(id, "GENERATING");
  repository.transition(id, "VERIFYING");
  repository.transition(id, "DOWNLOADING");
  repository.transition(id, "VALIDATING");
  return repository;
}

const dir = mkdtempSync(join(tmpdir(), "flowforge-1g-assets-"));
const asset = join(dir, "clip.mp4");
writeFileSync(asset, "FLOWFORGE TEST ASSET");

const provider = { id: "fake-provider" };
const repository = setup("job-1", provider);
repository.registerAsset({ id: "asset-1", projectId: "project-1", sceneId: "scene-1", jobId: "job-1", kind: "generation-output", path: asset, provider: provider.id, externalId: "external-1" });

const events = [];
const worker = new ProviderValidationWorker(repository, () => provider, { publish(e) { events.push(e); } });
const result = await worker.runOnce("job-1", [asset]);

assert.equal(result?.status, "COMPLETED");
assert.equal(repository.get("job-1")?.status, "COMPLETED");
assert.deepEqual(result?.assets, [asset]);
assert.deepEqual(events.map((e) => e.type), ["generation.completed"]);
console.log("[Phase 1G] validation -> COMPLETED: PASS");

const missingRepository = setup("job-2", provider);
const missingWorker = new ProviderValidationWorker(missingRepository, () => provider);
assert.equal(await missingWorker.runOnce("job-2", [asset]), null);
assert.equal(missingRepository.get("job-2")?.status, "FAILED");
assert.match(missingRepository.get("job-2")?.error ?? "", /not registered/);
console.log("[Phase 1G] unregistered asset rejection: PASS");

const emptyRepository = setup("job-3", provider);
const emptyWorker = new ProviderValidationWorker(emptyRepository, () => provider);
assert.equal(await emptyWorker.runOnce("job-3", []), null);
assert.equal(emptyRepository.get("job-3")?.status, "FAILED");
assert.match(emptyRepository.get("job-3")?.error ?? "", /no valid assets/);
console.log("[Phase 1G] empty asset rejection: PASS");

console.log("[Phase 1G] Google Flow submission: NONE");
