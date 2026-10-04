import { createHash } from "node:crypto";
import type { CharacterRecord, ProjectRecord, SceneRecord } from "@flowforge/core";

export const PROMPT_COMPILER_VERSION = "1.0.0";
export const PROMPT_SCHEMA_VERSION = 1;

export interface PromptReference {
  id: string;
  kind: string;
  label?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface PromptCompilationInput {
  project: ProjectRecord;
  scene: SceneRecord;
  characters: CharacterRecord[];
  references?: PromptReference[];
  creativeIntent?: string;
}

export interface CompiledPrompt {
  id: string;
  projectId: string;
  sceneId: string;
  compilerVersion: string;
  schemaVersion: number;
  prompt: string;
  metadata: {
    characterIds: string[];
    referenceIds: string[];
    creativeIntent?: string;
  };
  sourceFingerprint: string;
  deterministicHash: string;
}

function normalizeText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = canonicalize(record[key]);
        return result;
      }, {});
  }

  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateInput(input: PromptCompilationInput): void {
  if (input.scene.projectId !== input.project.id) {
    throw new Error(
      `Scene belongs to project ${input.scene.projectId}, expected ${input.project.id}`,
    );
  }

  for (const character of input.characters) {
    if (character.projectId !== input.project.id) {
      throw new Error(
        `Character ${character.id} belongs to project ${character.projectId}, expected ${input.project.id}`,
      );
    }
  }
}

function buildSource(input: PromptCompilationInput) {
  validateInput(input);

  const characters = [...input.characters]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((character) => ({
      id: character.id,
      name: character.name,
      description: normalizeText(character.description),
      metadata: character.metadata,
    }));

  const references = [...(input.references ?? [])]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((reference) => ({
      id: reference.id,
      kind: reference.kind,
      label: normalizeText(reference.label),
      description: normalizeText(reference.description),
      metadata: reference.metadata,
    }));

  return {
    project: {
      id: input.project.id,
      name: input.project.name,
      description: normalizeText(input.project.description),
      metadata: input.project.metadata,
    },
    scene: {
      id: input.scene.id,
      name: input.scene.name,
      sequence: input.scene.sequence,
      description: normalizeText(input.scene.description),
      metadata: input.scene.metadata,
    },
    characters,
    references,
    creativeIntent: normalizeText(input.creativeIntent),
  };
}

function renderPrompt(source: ReturnType<typeof buildSource>): string {
  const lines: string[] = [
    "FLOWFORGE PROMPT",
    "",
    "PROJECT",
    `Name: ${source.project.name}`,
  ];

  if (source.project.description) {
    lines.push(`Description: ${source.project.description}`);
  }

  lines.push(
    "",
    "SCENE",
    `Sequence: ${source.scene.sequence}`,
    `Name: ${source.scene.name}`,
  );

  if (source.scene.description) {
    lines.push(`Description: ${source.scene.description}`);
  }

  if (source.creativeIntent) {
    lines.push("", "CREATIVE INTENT", source.creativeIntent);
  }

  lines.push("", "CHARACTERS");

  if (source.characters.length === 0) {
    lines.push("None specified.");
  } else {
    for (const character of source.characters) {
      lines.push(`- [${character.id}] ${character.name}`);
      if (character.description) {
        lines.push(`  Description: ${character.description}`);
      }
    }
  }

  lines.push("", "REFERENCE ASSETS");

  if (source.references.length === 0) {
    lines.push("None specified.");
  } else {
    for (const reference of source.references) {
      const label = reference.label ?? reference.id;
      lines.push(`- [${reference.id}] ${label} (kind: ${reference.kind})`);
      if (reference.description) {
        lines.push(`  Description: ${reference.description}`);
      }
    }
  }

  return lines.join("\n");
}

export class PromptCompiler {
  compile(input: PromptCompilationInput): CompiledPrompt {
    const source = buildSource(input);
    const sourceFingerprint = sha256(
      stableJson({
        compilerVersion: PROMPT_COMPILER_VERSION,
        schemaVersion: PROMPT_SCHEMA_VERSION,
        source,
      }),
    );

    const prompt = renderPrompt(source);
    const metadata: CompiledPrompt["metadata"] = {
      characterIds: source.characters.map((character) => character.id),
      referenceIds: source.references.map((reference) => reference.id),
      ...(source.creativeIntent
        ? { creativeIntent: source.creativeIntent }
        : {}),
    };

    const deterministicHash = sha256(
      stableJson({
        compilerVersion: PROMPT_COMPILER_VERSION,
        schemaVersion: PROMPT_SCHEMA_VERSION,
        prompt,
        metadata,
        sourceFingerprint,
      }),
    );

    return {
      id: `cp_${deterministicHash.slice(0, 24)}`,
      projectId: input.project.id,
      sceneId: input.scene.id,
      compilerVersion: PROMPT_COMPILER_VERSION,
      schemaVersion: PROMPT_SCHEMA_VERSION,
      prompt,
      metadata,
      sourceFingerprint,
      deterministicHash,
    };
  }
}
