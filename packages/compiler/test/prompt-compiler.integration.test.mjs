import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptCompiler, PromptCompilationStore } from "../dist/index.js";
import { SqliteJobRepository } from "../../storage/dist/index.js";
import { SqliteJobQueue, LocalQueueWorker } from "../../queue/dist/index.js";

const project = {
  id: "project-integration",
  name: "Integration Project",
  description: "Compiler to persistent generation pipeline.",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
};

const scene = {
  id: "scene-integration",
  projectId: project.id,
  name: "Opening",
  sequence: 1,
  description: "Integration scene.",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
};

const compiler = new PromptCompiler();

const compiled = compiler.compile({
  project,
  scene,
  characters: [
    {
      id: "char-1",
      projectId: project.id,
      name: "Ari",
      description: "A curious guide.",
      createdAt: "x",
      updatedAt: "x",
    },
  ],
  sceneCharacters: [
    {
      sceneId: scene.id,
      characterId: "char-1",
      role: "guide",
      createdAt: "x",
    },
  ],
  references: [
    {
      id: "asset-1",
      kind: "character",
      label: "Ari reference",
    },
  ],
  creativeIntent: "Quiet cinematic opening.",
});

const directory = mkdtempSync(join(tmpdir(), "flowforge-phase1a-integration-"));
const dbPath = join(directory, "flowforge.sqlite");

const compilerStore = new PromptCompilationStore(dbPath);
compilerStore.save(compiled);

const repository = new SqliteJobRepository(dbPath);
const request = {
  projectId: compiled.projectId,
  sceneId: compiled.sceneId,
  provider: "google-flow",
  prompt: compiled.prompt,
  references: compiled.metadata.referenceIds,
  metadata: {
    flowforge: {
      compiledPromptId: compiled.id,
      deterministicHash: compiled.deterministicHash,
      compilerVersion: compiled.compilerVersion,
      schemaVersion: compiled.schemaVersion,
    },
  },
};

const job = repository.create(request, "job-integration-1");
assert.equal(job.status, "CREATED");
assert.equal(job.request.prompt, compiled.prompt);
assert.equal(
  job.request.metadata.flowforge.deterministicHash,
  compiled.deterministicHash,
);

const queue = new SqliteJobQueue(repository);
queue.enqueue(job.id);
assert.equal(queue.size(), 1);

const worker = new LocalQueueWorker(repository, queue);
const result = worker.runOnce();
assert.deepEqual(result, {
  jobId: job.id,
  status: "PREPARING",
});

repository.close();
compilerStore.close();

const recoveredStore = new PromptCompilationStore(dbPath);
const recoveredCompiled = recoveredStore.getByHash(compiled.deterministicHash);
assert.deepEqual(recoveredCompiled, compiled);
recoveredStore.close();

const recoveredRepository = new SqliteJobRepository(dbPath);
const recoveredJob = recoveredRepository.get(job.id);
assert.ok(recoveredJob);
assert.equal(recoveredJob.request.prompt, compiled.prompt);
assert.equal(
  recoveredJob.request.metadata.flowforge.compiledPromptId,
  compiled.id,
);
assert.equal(
  recoveredJob.request.metadata.flowforge.deterministicHash,
  compiled.deterministicHash,
);
assert.equal(recoveredJob.status, "PREPARING");
assert.equal(recoveredRepository.get(job.id)?.request.provider, "google-flow");
recoveredRepository.close();

rmSync(directory, { recursive: true, force: true });

console.log("[Phase 1A] compiled prompt -> generation request: PASS");
console.log("[Phase 1A] generation job persistence: PASS");
console.log("[Phase 1A] queue/worker handoff: PASS");
console.log("[Phase 1A] restart recovery of compiled prompt + job: PASS");
console.log("[Phase 1A] Google Flow submission: NONE");
