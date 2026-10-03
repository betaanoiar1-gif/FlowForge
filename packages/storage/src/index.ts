import Database from "better-sqlite3";
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

  close(): void {
    this.db.close();
  }
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
