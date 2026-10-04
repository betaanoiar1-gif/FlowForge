import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { GenerationJob, GenerationRequest, JobStatus } from "@flowforge/core";
import { assertTransition } from "@flowforge/core";

export class SqliteJobRepository {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
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
    assertTransition(current.status, to);

    const updatedAt = new Date().toISOString();
    this.db.prepare(
      "UPDATE generation_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?",
    ).run(to, to === "FAILED" ? error ?? current.error ?? null : null, updatedAt, id);

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

  close(): void {
    this.db.close();
  }
}

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
