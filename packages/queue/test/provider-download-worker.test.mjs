import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderDownloadWorker } from "../dist/index.js";
import { SqliteJobRepository } from "@flowforge/storage";

function setup(id, provider) {
  const repository = new SqliteJobRepository(join(mkdtempSync(join(tmpdir(), "flowforge-1f-")), "jobs.sqlite"));
  repository.create({ projectId: "project-1", sceneId: "scene-1", provider: provider.id, prompt: "FLOWFORGE DOWNLOAD TEST — DO NOT GENERATE", references: [] }, id);
  repository.transition(id, "PREPARING");
  repository.transition(id, "SUBMITTING");
  repository.setExternalId(id, "external-1");
  repository.transition(id, "GENERATING");
  repository.transition(id, "VERIFYING");
  return repository;
}

const dir = mkdtempSync(join(tmpdir(), "flowforge-assets-"));
const asset = join(dir, "clip.mp4");
writeFileSync(asset, "FLOWFORGE TEST ASSET");

const events = [];
const provider = {
  id: "fake-provider",
  async connect() {},
  async inspectState() { return { ready: true }; },
  async submit() { return { externalId: "external-1" }; },
  async waitForCompletion() { return { jobId: "job-1", provider: "fake-provider", status: "COMPLETED", assets: [] }; },
  async download(result) { assert.equal(result.jobId, "job-1"); return [asset, asset]; },
  async disconnect() {},
};

const repository = setup("job-1", provider);
const worker = new ProviderDownloadWorker(repository, () => provider, { publish(e) { events.push(e); } });
const result = await worker.runOnce("job-1", { jobId: "job-1", provider: "fake-provider", status: "COMPLETED", assets: [] });

assert.equal(result?.status, "VALIDATING");
assert.deepEqual(result?.assets, [asset, asset]);
assert.equal(repository.get("job-1")?.status, "VALIDATING");
assert.equal(repository.listProjectAssets("project-1").length, 1);
assert.equal(repository.listProjectAssets("project-1")[0]?.jobId, "job-1");
assert.deepEqual(events.map((e) => e.type), ["generation.downloading", "generation.validating"]);
console.log("[Phase 1F] download -> asset registration -> VALIDATING: PASS");

const failingProvider = { ...provider, id: "failing-provider", async download() { throw new Error("download failed"); } };
const failureRepository = setup("job-2", failingProvider);
const failureWorker = new ProviderDownloadWorker(failureRepository, () => failingProvider);
assert.equal(await failureWorker.runOnce("job-2", { jobId: "job-2", provider: "failing-provider", status: "COMPLETED", assets: [] }), null);
assert.equal(failureRepository.get("job-2")?.status, "FAILED");
assert.equal(failureRepository.get("job-2")?.error, "download failed");
console.log("[Phase 1F] download failure persistence: PASS");

const badProvider = { ...provider, id: "bad-provider", async download() { return ["/path/that/does/not/exist.mp4"]; } };
const badRepository = setup("job-3", badProvider);
const badWorker = new ProviderDownloadWorker(badRepository, () => badProvider);
assert.equal(await badWorker.runOnce("job-3", { jobId: "job-3", provider: "bad-provider", status: "COMPLETED", assets: [] }), null);
assert.equal(badRepository.get("job-3")?.status, "FAILED");
assert.match(badRepository.get("job-3")?.error ?? "", /does not exist/);
console.log("[Phase 1F] asset path validation: PASS");

console.log("[Phase 1F] Google Flow submission: NONE");
