import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptCompiler, PromptCompilationStore } from "../dist/index.js";

const project = {
  id: "project-1",
  name: "Demo Project",
  description: "A deterministic compiler fixture.",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
};

const scene = {
  id: "scene-1",
  projectId: "project-1",
  name: "Opening",
  sequence: 1,
  description: "A quiet opening scene.",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
};

const compiler = new PromptCompiler();
const input = {
  project,
  scene,
  characters: [
    { id: "char-2", projectId: "project-1", name: "Mika", description: "A calm traveler.", createdAt: "x", updatedAt: "x" },
    { id: "char-1", projectId: "project-1", name: "Ari", description: "A curious guide.", createdAt: "x", updatedAt: "x" },
  ],
  references: [
    { id: "asset-2", kind: "style", label: "Night palette" },
    { id: "asset-1", kind: "character", label: "Ari reference" },
  ],
  creativeIntent: "Quiet, cinematic, emotionally restrained.",
};

const first = compiler.compile(input);
const second = compiler.compile({
  ...input,
  characters: [...input.characters].reverse(),
  references: [...input.references].reverse(),
});

assert.equal(first.prompt, second.prompt);
assert.equal(first.sourceFingerprint, second.sourceFingerprint);
assert.equal(first.deterministicHash, second.deterministicHash);
assert.equal(first.id, second.id);
assert.deepEqual(first.metadata.characterIds, ["char-1", "char-2"]);
assert.deepEqual(first.metadata.referenceIds, ["asset-1", "asset-2"]);

const directory = mkdtempSync(join(tmpdir(), "flowforge-phase1a-"));
const dbPath = join(directory, "flowforge.sqlite");

const store1 = new PromptCompilationStore(dbPath);
const saved = store1.save(first);
assert.equal(saved.deterministicHash, first.deterministicHash);
assert.equal(store1.get(first.id)?.prompt, first.prompt);
store1.close();

const store2 = new PromptCompilationStore(dbPath);
const recovered = store2.getByHash(first.deterministicHash);
assert.deepEqual(recovered, first);
store2.close();
rmSync(directory, { recursive: true, force: true });

assert.throws(
  () => compiler.compile({
    project,
    scene: { ...scene, projectId: "other-project" },
    characters: [],
  }),
  /Scene belongs to project/,
);

assert.throws(
  () => compiler.compile({
    project,
    scene,
    characters: [{
      id: "foreign",
      projectId: "other-project",
      name: "Foreign",
      createdAt: "x",
      updatedAt: "x",
    }],
  }),
  /Character foreign belongs to project/,
);

console.log("[Phase 1A] deterministic compile: PASS");
console.log("[Phase 1A] persistence: PASS");
console.log("[Phase 1A] restart recovery: PASS");
console.log("[Phase 1A] project isolation: PASS");
console.log("[Phase 1A] Google Flow action: NONE");
