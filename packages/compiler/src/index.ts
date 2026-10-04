import { createHash } from "node:crypto";
import Database from "better-sqlite3";
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

export class PromptCompilationStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS compiled_prompts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        scene_id TEXT NOT NULL,
        compiler_version TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        deterministic_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_compiled_prompts_scene
        ON compiled_prompts(scene_id);
      CREATE INDEX IF NOT EXISTS idx_compiled_prompts_source
        ON compiled_prompts(source_fingerprint);
    `);
  }

  save(compiled: CompiledPrompt): CompiledPrompt {
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO compiled_prompts (
        id, project_id, scene_id, compiler_version, schema_version,
        prompt, metadata_json, source_fingerprint, deterministic_hash, created_at
      ) VALUES (
        @id, @projectId, @sceneId, @compilerVersion, @schemaVersion,
        @prompt, @metadata, @sourceFingerprint, @deterministicHash, @createdAt
      )
      ON CONFLICT(deterministic_hash) DO UPDATE SET
        prompt = excluded.prompt,
        metadata_json = excluded.metadata_json
    `).run({
      id: compiled.id,
      projectId: compiled.projectId,
      sceneId: compiled.sceneId,
      compilerVersion: compiled.compilerVersion,
      schemaVersion: compiled.schemaVersion,
      prompt: compiled.prompt,
      metadata: JSON.stringify(compiled.metadata),
      sourceFingerprint: compiled.sourceFingerprint,
      deterministicHash: compiled.deterministicHash,
      createdAt,
    });

    return this.getByHash(compiled.deterministicHash)!;
  }

  get(id: string): CompiledPrompt | null {
    const row = this.db.prepare(
      "SELECT * FROM compiled_prompts WHERE id = ?",
    ).get(id) as CompiledPromptRow | undefined;
    return row ? compiledPromptFromRow(row) : null;
  }

  getByHash(hash: string): CompiledPrompt | null {
    const row = this.db.prepare(
      "SELECT * FROM compiled_prompts WHERE deterministic_hash = ?",
    ).get(hash) as CompiledPromptRow | undefined;
    return row ? compiledPromptFromRow(row) : null;
  }

  close(): void {
    this.db.close();
  }
}

interface CompiledPromptRow {
  id: string;
  project_id: string;
  scene_id: string;
  compiler_version: string;
  schema_version: number;
  prompt: string;
  metadata_json: string;
  source_fingerprint: string;
  deterministic_hash: string;
}

function compiledPromptFromRow(row: CompiledPromptRow): CompiledPrompt {
  return {
    id: row.id,
    projectId: row.project_id,
    sceneId: row.scene_id,
    compilerVersion: row.compiler_version,
    schemaVersion: row.schema_version,
    prompt: row.prompt,
    metadata: JSON.parse(row.metadata_json) as CompiledPrompt["metadata"],
    sourceFingerprint: row.source_fingerprint,
    deterministicHash: row.deterministic_hash,
  };
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
