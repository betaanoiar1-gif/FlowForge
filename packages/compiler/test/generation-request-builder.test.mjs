import assert from "node:assert/strict";
import { PromptCompiler, buildGenerationRequest } from "../dist/index.js";

const project = {
  id: "project-builder",
  name: "Builder Project",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
};

const scene = {
  id: "scene-builder",
  projectId: project.id,
  name: "Scene",
  sequence: 1,
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
};

const compiled = new PromptCompiler().compile({
  project,
  scene,
  characters: [],
  references: [
    { id: "ref-b", kind: "image" },
    { id: "ref-a", kind: "image" },
  ],
});

const request = buildGenerationRequest(compiled, " google-flow ");

assert.deepEqual(request, {
  projectId: compiled.projectId,
  sceneId: compiled.sceneId,
  provider: "google-flow",
  prompt: compiled.prompt,
  references: ["ref-a", "ref-b"],
  metadata: {
    flowforge: {
      compiledPromptId: compiled.id,
      deterministicHash: compiled.deterministicHash,
      compilerVersion: compiled.compilerVersion,
      schemaVersion: compiled.schemaVersion,
    },
  },
});

assert.notStrictEqual(request.references, compiled.metadata.referenceIds);
assert.throws(
  () => buildGenerationRequest(compiled, "   "),
  /Generation provider is required/,
);

console.log("[Phase 1B] compiled prompt -> generation request: PASS");
console.log("[Phase 1B] provenance propagation: PASS");
console.log("[Phase 1B] provider validation: PASS");
console.log("[Phase 1B] Google Flow submission: NONE");
