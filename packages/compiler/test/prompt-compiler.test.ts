import assert from "node:assert/strict";
import { PromptCompiler } from "../src/index.ts";

const project = {
  id: "project-1",
  name: "Demo Project",
  description: "A deterministic compiler fixture.",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
} as const;

const scene = {
  id: "scene-1",
  projectId: "project-1",
  name: "Opening",
  sequence: 1,
  description: "A quiet opening scene.",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
} as const;

const compiler = new PromptCompiler();

const first = compiler.compile({
  project,
  scene,
  characters: [
    {
      id: "char-2",
      projectId: "project-1",
      name: "Mika",
      description: "A calm traveler.",
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
    },
    {
      id: "char-1",
      projectId: "project-1",
      name: "Ari",
      description: "A curious guide.",
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
    },
  ],
  references: [
    {
      id: "asset-2",
      kind: "style",
      label: "Night palette",
    },
    {
      id: "asset-1",
      kind: "character",
      label: "Ari reference",
    },
  ],
  creativeIntent: "Quiet, cinematic, emotionally restrained.",
});

const second = compiler.compile({
  project,
  scene,
  characters: [
    {
      id: "char-1",
      projectId: "project-1",
      name: "Ari",
      description: "A curious guide.",
      createdAt: "different",
      updatedAt: "different",
    },
    {
      id: "char-2",
      projectId: "project-1",
      name: "Mika",
      description: "A calm traveler.",
      createdAt: "different",
      updatedAt: "different",
    },
  ],
  references: [
    {
      id: "asset-1",
      kind: "character",
      label: "Ari reference",
    },
    {
      id: "asset-2",
      kind: "style",
      label: "Night palette",
    },
  ],
  creativeIntent: "Quiet, cinematic, emotionally restrained.",
});

assert.equal(first.prompt, second.prompt);
assert.equal(first.sourceFingerprint, second.sourceFingerprint);
assert.equal(first.deterministicHash, second.deterministicHash);
assert.equal(first.id, second.id);
assert.deepEqual(first.metadata.characterIds, ["char-1", "char-2"]);
assert.deepEqual(first.metadata.referenceIds, ["asset-1", "asset-2"]);

assert.throws(
  () =>
    compiler.compile({
      project,
      scene: {
        ...scene,
        projectId: "other-project",
      },
      characters: [],
    }),
  /Scene belongs to project/,
);

assert.throws(
  () =>
    compiler.compile({
      project,
      scene,
      characters: [
        {
          id: "foreign",
          projectId: "other-project",
          name: "Foreign",
          createdAt: "2026-10-04T00:00:00.000Z",
          updatedAt: "2026-10-04T00:00:00.000Z",
        },
      ],
    }),
  /Character foreign belongs to project/,
);

console.log("[Phase 1A] Prompt compiler deterministic tests passed.");
