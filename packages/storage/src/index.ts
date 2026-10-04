import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { CharacterRecord, GenerationJob, GenerationRequest, JobStatus, ProjectRecord, SceneCharacterRecord, SceneRecord } from "@flowforge/core";
import { assertTransition } from "@flowforge/core";

export class SqliteJobRepository {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scenes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        description TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        UNIQUE (project_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS characters (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS scene_characters (
        scene_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        role TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scene_id, character_id),
        FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_scenes_project
        ON scenes(project_id);
      CREATE INDEX IF NOT EXISTS idx_characters_project
        ON characters(project_id);
      CREATE INDEX IF NOT EXISTS idx_scene_characters_character
        ON scene_characters(character_id);

      CREATE TABLE IF NOT EXISTS generation_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        scene_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        prompt TEXT NOT NULL,
        references_json TEXT NOT NULL,
        metadata_json TEXT,
        status TEXT NOT NULL,
        external_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );


      CREATE TABLE IF NOT EXISTS generation_retry_state (job_id TEXT PRIMARY KEY, retry_count INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 3, updated_at TEXT NOT NULL, FOREIGN KEY (job_id) REFERENCES generation_jobs(id) ON DELETE CASCADE);

      CREATE TABLE IF NOT EXISTS queue_entries (
        job_id TEXT PRIMARY KEY,
        enqueued_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES generation_jobs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        scene_id TEXT,
        job_id TEXT,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        provider TEXT,
        external_id TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES generation_jobs(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_assets_project
        ON assets(project_id);
      CREATE INDEX IF NOT EXISTS idx_assets_scene
        ON assets(scene_id);
      CREATE INDEX IF NOT EXISTS idx_assets_job
        ON assets(job_id);
      CREATE INDEX IF NOT EXISTS idx_assets_sha256
        ON assets(sha256);
    `);
  }

  create(request: GenerationRequest, id: string): GenerationJob {
    const now = new Date().toISOString();
    const job: GenerationJob = {
      id,
      request,
      status: "CREATED",
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO generation_jobs
      (id, project_id, scene_id, provider, prompt, references_json, metadata_json,
       status, external_id, error, created_at, updated_at)
      VALUES (@id, @projectId, @sceneId, @provider, @prompt, @references,
              @metadata, @status, @externalId, @error, @createdAt, @updatedAt)
    `).run({
      id,
      projectId: request.projectId,
      sceneId: request.sceneId,
      provider: request.provider,
      prompt: request.prompt,
      references: JSON.stringify(request.references ?? []),
      metadata: request.metadata ? JSON.stringify(request.metadata) : null,
      status: job.status,
      externalId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });

    return job;
  }

  get(id: string): GenerationJob | null {
    const row = this.db.prepare("SELECT * FROM generation_jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? fromRow(row) : null;
  }

  transition(id: string, to: JobStatus, error?: string): GenerationJob {
    const current = this.get(id);
    if (!current) throw new Error(`Generation job not found: ${id}`);
    assertTransition(current.status, to, current.externalId);

    const updatedAt = new Date().toISOString();
    this.db.prepare(
      "UPDATE generation_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?",
    ).run(to, to === "FAILED" ? error ?? current.error ?? null : null, updatedAt, id);

    return this.get(id)!;
  }

  cancel(id: string): GenerationJob {
    const current = this.get(id);
    if (!current) throw new Error(`Generation job not found: ${id}`);
    if (current.status === "COMPLETED") {
      throw new Error(`Cannot cancel completed job ${id}`);
    }
    if (current.status === "CANCELLED") {
      return current;
    }
    assertTransition(current.status, "CANCELLED");
    const updatedAt = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      this.db.prepare(
        "UPDATE generation_jobs SET status = ?, error = NULL, updated_at = ? WHERE id = ?",
      ).run("CANCELLED", updatedAt, id);
      this.db.prepare("DELETE FROM queue_entries WHERE job_id = ?").run(id);
    });
    transaction();
    return this.get(id)!;
  }

  setExternalId(id: string, externalId: string): GenerationJob {
    const updatedAt = new Date().toISOString();
    this.db.prepare(
      "UPDATE generation_jobs SET external_id = ?, updated_at = ? WHERE id = ?",
    ).run(externalId, updatedAt, id);
    const job = this.get(id);
    if (!job) throw new Error(`Generation job not found: ${id}`);
    return job;
  }


  getRetryState(jobId: string, defaultMaxRetries = 3): RetryState {
    const job = this.get(jobId);
    if (!job) throw new Error(`Generation job not found: ${jobId}`);
    const row = this.db.prepare("SELECT retry_count, max_retries, updated_at FROM generation_retry_state WHERE job_id = ?").get(jobId) as RetryStateRow | undefined;
    if (row) return { jobId, retryCount: row.retry_count, maxRetries: row.max_retries, updatedAt: row.updated_at };
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO generation_retry_state (job_id, retry_count, max_retries, updated_at) VALUES (?, 0, ?, ?)").run(jobId, defaultMaxRetries, now);
    return { jobId, retryCount: 0, maxRetries: defaultMaxRetries, updatedAt: now };
  }

  requestRetry(jobId: string, maxRetries = 3): RetryState {
    const job = this.get(jobId);
    if (!job) throw new Error(`Generation job not found: ${jobId}`);
    if (job.status === "COMPLETED") throw new Error(`Cannot retry completed job ${jobId}`);
    if (job.status === "CANCELLED") throw new Error(`Cannot retry cancelled job ${jobId}`);
    if (job.status !== "FAILED") throw new Error(`Cannot retry job ${jobId} from status ${job.status}`);
    if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error("maxRetries must be a non-negative integer");
    const current = this.getRetryState(jobId, maxRetries);
    if (current.retryCount >= current.maxRetries) throw new Error(`Retry limit exhausted for job ${jobId}: ${current.retryCount}/${current.maxRetries}`);
    const now = new Date().toISOString();
    const next = current.retryCount + 1;
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE generation_retry_state SET retry_count = ?, updated_at = ? WHERE job_id = ?").run(next, now, jobId);
      if (job.externalId) {
        this.db.prepare("UPDATE generation_jobs SET status = ?, error = NULL, updated_at = ? WHERE id = ?").run("GENERATING", now, jobId);
        this.db.prepare("DELETE FROM queue_entries WHERE job_id = ?").run(jobId);
      } else {
        this.db.prepare("INSERT INTO queue_entries (job_id, enqueued_at) VALUES (?, ?) ON CONFLICT(job_id) DO UPDATE SET enqueued_at = excluded.enqueued_at").run(jobId, now);
      }
    });
    tx();
    return this.getRetryState(jobId);
  }

  enqueue(jobId: string): QueueEntry {
    const job = this.get(jobId);

    if (!job) {
      throw new Error(`Cannot enqueue unknown job: ${jobId}`);
    }

    if (job.status !== "CREATED" && job.status !== "FAILED") {
      throw new Error(
        `Cannot enqueue job ${jobId} from status ${job.status}`,
      );
    }

    if (job.status === "FAILED" && job.externalId) { throw new Error(`Cannot enqueue failed job ${jobId} with an externalId; use retry recovery`); }

    const enqueuedAt = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO queue_entries (job_id, enqueued_at)
      VALUES (?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        enqueued_at = excluded.enqueued_at
    `).run(jobId, enqueuedAt);

    return {
      jobId,
      enqueuedAt,
    };
  }

  dequeue(): QueueEntry | null {
    const row = this.db.prepare(`
      SELECT job_id, enqueued_at
      FROM queue_entries
      ORDER BY enqueued_at ASC, rowid ASC
      LIMIT 1
    `).get() as QueueRow | undefined;

    if (!row) return null;

    this.db.prepare(`
      DELETE FROM queue_entries
      WHERE job_id = ?
    `).run(row.job_id);

    return {
      jobId: row.job_id,
      enqueuedAt: row.enqueued_at,
    };
  }

  hasQueueEntry(jobId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS present
      FROM queue_entries
      WHERE job_id = ?
      LIMIT 1
    `).get(jobId) as { present: number } | undefined;

    return row?.present === 1;
  }

  queueSize(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM queue_entries
    `).get() as { count: number };

    return row.count;
  }

  registerAsset(input: RegisterAssetInput): AssetRecord {
    if (!existsSync(input.path)) {
      throw new Error(`Asset file does not exist: ${input.path}`);
    }

    const stats = statSync(input.path);

    if (!stats.isFile()) {
      throw new Error(`Asset path is not a file: ${input.path}`);
    }

    const sha256 = hashFileSha256(input.path);
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO assets (
        id, project_id, scene_id, job_id, kind, path, mime_type,
        size_bytes, sha256, provider, external_id, metadata_json,
        created_at, updated_at
      )
      VALUES (
        @id, @projectId, @sceneId, @jobId, @kind, @path, @mimeType,
        @sizeBytes, @sha256, @provider, @externalId, @metadata,
        @createdAt, @updatedAt
      )
    `).run({
      id: input.id,
      projectId: input.projectId,
      sceneId: input.sceneId ?? null,
      jobId: input.jobId ?? null,
      kind: input.kind,
      path: input.path,
      mimeType: input.mimeType ?? null,
      sizeBytes: stats.size,
      sha256,
      provider: input.provider ?? null,
      externalId: input.externalId ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt: now,
      updatedAt: now,
    });

    return this.getAsset(input.id)!;
  }

  getAsset(id: string): AssetRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM assets WHERE id = ?",
    ).get(id) as AssetRow | undefined;

    return row ? assetFromRow(row) : null;
  }

  findAssetsBySha256(sha256: string): AssetRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM assets
      WHERE sha256 = ?
      ORDER BY created_at ASC
    `).all(sha256) as AssetRow[];

    return rows.map(assetFromRow);
  }

  listProjectAssets(projectId: string): AssetRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM assets
      WHERE project_id = ?
      ORDER BY created_at ASC
    `).all(projectId) as AssetRow[];

    return rows.map(assetFromRow);
  }


  createProject(input: CreateProjectInput): ProjectRecord {
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO projects (id, name, description, metadata_json, created_at, updated_at)
      VALUES (@id, @name, @description, @metadata, @createdAt, @updatedAt)
    `).run({
      id: input.id,
      name: input.name,
      description: input.description ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt: now,
      updatedAt: now,
    });

    return this.getProject(input.id)!;
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row ? projectFromRow(row) : null;
  }

  createScene(input: CreateSceneInput): SceneRecord {
    if (!this.getProject(input.projectId)) {
      throw new Error(`Project not found: ${input.projectId}`);
    }

    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO scenes (
        id, project_id, name, sequence, description, metadata_json,
        created_at, updated_at
      )
      VALUES (
        @id, @projectId, @name, @sequence, @description, @metadata,
        @createdAt, @updatedAt
      )
    `).run({
      id: input.id,
      projectId: input.projectId,
      name: input.name,
      sequence: input.sequence,
      description: input.description ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt: now,
      updatedAt: now,
    });

    return this.getScene(input.id)!;
  }

  getScene(id: string): SceneRecord | null {
    const row = this.db.prepare("SELECT * FROM scenes WHERE id = ?").get(id) as SceneRow | undefined;
    return row ? sceneFromRow(row) : null;
  }

  listProjectScenes(projectId: string): SceneRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM scenes
      WHERE project_id = ?
      ORDER BY sequence ASC, created_at ASC
    `).all(projectId) as SceneRow[];

    return rows.map(sceneFromRow);
  }

  createCharacter(input: CreateCharacterInput): CharacterRecord {
    if (!this.getProject(input.projectId)) {
      throw new Error(`Project not found: ${input.projectId}`);
    }

    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO characters (
        id, project_id, name, description, metadata_json,
        created_at, updated_at
      )
      VALUES (
        @id, @projectId, @name, @description, @metadata,
        @createdAt, @updatedAt
      )
    `).run({
      id: input.id,
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt: now,
      updatedAt: now,
    });

    return this.getCharacter(input.id)!;
  }

  getCharacter(id: string): CharacterRecord | null {
    const row = this.db.prepare("SELECT * FROM characters WHERE id = ?").get(id) as CharacterRow | undefined;
    return row ? characterFromRow(row) : null;
  }

  listProjectCharacters(projectId: string): CharacterRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM characters
      WHERE project_id = ?
      ORDER BY created_at ASC
    `).all(projectId) as CharacterRow[];

    return rows.map(characterFromRow);
  }

  attachCharacterToScene(input: AttachCharacterToSceneInput): SceneCharacterRecord {
    const scene = this.getScene(input.sceneId);
    if (!scene) throw new Error(`Scene not found: ${input.sceneId}`);

    const character = this.getCharacter(input.characterId);
    if (!character) throw new Error(`Character not found: ${input.characterId}`);

    if (scene.projectId !== character.projectId) {
      throw new Error(
        `Scene and character belong to different projects: ${scene.projectId} != ${character.projectId}`,
      );
    }

    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO scene_characters (scene_id, character_id, role, created_at)
      VALUES (@sceneId, @characterId, @role, @createdAt)
      ON CONFLICT(scene_id, character_id) DO UPDATE SET
        role = excluded.role
    `).run({
      sceneId: input.sceneId,
      characterId: input.characterId,
      role: input.role ?? null,
      createdAt: now,
    });

    return this.getSceneCharacter(input.sceneId, input.characterId)!;
  }

  getSceneCharacter(sceneId: string, characterId: string): SceneCharacterRecord | null {
    const row = this.db.prepare(`
      SELECT scene_id, character_id, role, created_at
      FROM scene_characters
      WHERE scene_id = ? AND character_id = ?
    `).get(sceneId, characterId) as SceneCharacterRow | undefined;

    return row ? sceneCharacterFromRow(row) : null;
  }

  listSceneCharacters(sceneId: string): SceneCharacterRecord[] {
    const rows = this.db.prepare(`
      SELECT scene_id, character_id, role, created_at
      FROM scene_characters
      WHERE scene_id = ?
      ORDER BY created_at ASC
    `).all(sceneId) as SceneCharacterRow[];

    return rows.map(sceneCharacterFromRow);
  }

  close(): void {
    this.db.close();
  }
}


export interface CreateProjectInput {
  id: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateSceneInput {
  id: string;
  projectId: string;
  name: string;
  sequence: number;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateCharacterInput {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface AttachCharacterToSceneInput {
  sceneId: string;
  characterId: string;
  role?: string;
}

export interface RetryState { jobId: string; retryCount: number; maxRetries: number; updatedAt: string; }

interface RetryStateRow { retry_count: number; max_retries: number; updated_at: string; }

export interface QueueEntry {
  jobId: string;
  enqueuedAt: string;
}

export interface RegisterAssetInput {
  id: string;
  projectId: string;
  sceneId?: string;
  jobId?: string;
  kind: string;
  path: string;
  mimeType?: string;
  provider?: string;
  externalId?: string;
  metadata?: Record<string, unknown>;
}

export interface AssetRecord {
  id: string;
  projectId: string;
  sceneId?: string;
  jobId?: string;
  kind: string;
  path: string;
  mimeType?: string;
  sizeBytes: number;
  sha256: string;
  provider?: string;
  externalId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}



interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

interface SceneRow {
  id: string;
  project_id: string;
  name: string;
  sequence: number;
  description: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

interface CharacterRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

interface SceneCharacterRow {
  scene_id: string;
  character_id: string;
  role: string | null;
  created_at: string;
}

interface QueueRow {
  job_id: string;
  enqueued_at: string;
}

interface AssetRow {
  id: string;
  project_id: string;
  scene_id: string | null;
  job_id: string | null;
  kind: string;
  path: string;
  mime_type: string | null;
  size_bytes: number;
  sha256: string;
  provider: string | null;
  external_id: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  id: string;
  project_id: string;
  scene_id: string;
  provider: string;
  prompt: string;
  references_json: string;
  metadata_json: string | null;
  status: JobStatus;
  external_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}


function projectFromRow(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sceneFromRow(row: SceneRow): SceneRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    sequence: row.sequence,
    description: row.description ?? undefined,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function characterFromRow(row: CharacterRow): CharacterRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description ?? undefined,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sceneCharacterFromRow(row: SceneCharacterRow): SceneCharacterRecord {
  return {
    sceneId: row.scene_id,
    characterId: row.character_id,
    role: row.role ?? undefined,
    createdAt: row.created_at,
  };
}

function fromRow(row: JobRow): GenerationJob {
  const request: GenerationRequest = {
    projectId: row.project_id,
    sceneId: row.scene_id,
    provider: row.provider,
    prompt: row.prompt,
    references: JSON.parse(row.references_json) as string[],
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : undefined,
  };

  return {
    id: row.id,
    request,
    status: row.status,
    externalId: row.external_id ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assetFromRow(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sceneId: row.scene_id ?? undefined,
    jobId: row.job_id ?? undefined,
    kind: row.kind,
    path: row.path,
    mimeType: row.mime_type ?? undefined,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    provider: row.provider ?? undefined,
    externalId: row.external_id ?? undefined,
    metadata: row.metadata_json
      ? JSON.parse(row.metadata_json) as Record<string, unknown>
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hashFileSha256(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  try {
    let bytesRead: number;

    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);

      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);

    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
