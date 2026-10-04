import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import {
  assertProjectStatusTransition,
  assertSceneStatusTransition,
  assertTransition,
  type AssetRecord,
  type AssetVersionRecord,
  type CharacterRecord,
  type GenerationAttempt,
  type GenerationAttemptStatus,
  type GenerationJob,
  type GenerationRequest,
  type JobStatus,
  type ProjectRecord,
  type ProjectStatus,
  type QCCheckEvidence,
  type QCResultRecord,
  type QCStatus,
  type QueueItemRecord,
  type QueueItemStatus,
  type ReviewRecord,
  type ReviewStatus,
  type SceneCharacterRecord,
  type SceneRecord,
  type SceneStatus,
  type SceneVersionRecord,
} from "@flowforge/core";
import { migrateDatabase } from "./migrations.js";
import {
  createIdempotencyKey,
  decodeJson,
  decodeOptionalJson,
  encodeOptionalJson,
  requiredText,
  stableJson,
} from "./internal.js";

export class SqliteJobRepository {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    migrateDatabase(this.db);
  }

  getSchemaVersion(): number {
    return Number(this.db.pragma("user_version", { simple: true }));
  }

  /**
   * The migrated connection behind this repository. Exposed so additional repositories
   * (currently `SqlitePlanningRepository`) can compose over the *same* SQLite connection instead
   * of opening a second handle to the file. Callers must not run SQL against it directly; only the
   * repositories own writes.
   */
  get database(): Database.Database {
    return this.db;
  }

  createProject(input: CreateProjectInput): ProjectRecord {
    const id = input.id ?? randomUUID();
    const name = requiredText(input.name, "Project name");
    const now = input.now ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO projects (id, name, description, metadata_json, status, created_at, updated_at)
      VALUES (@id, @name, @description, @metadata, @status, @createdAt, @updatedAt)
    `).run({
      id,
      name,
      description: input.description ?? null,
      metadata: encodeOptionalJson(input.metadata),
      status: input.status ?? "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
    return this.getProject(id)!;
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row ? projectFromRow(row) : null;
  }

  listProjects(): ProjectRecord[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY created_at, id").all() as ProjectRow[];
    return rows.map(projectFromRow);
  }

  /** Guarded project status change; the domain transition table is the only rule source. */
  updateProjectStatus(projectId: string, to: ProjectStatus, now = new Date().toISOString()): ProjectRecord {
    const transaction = this.db.transaction(() => {
      const project = this.getProject(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      if (project.status !== to) assertProjectStatusTransition(project.status, to);
      this.db
        .prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
        .run(to, now, projectId, project.status);
      const updated = this.getProject(projectId)!;
      if (updated.status !== to) throw new Error(`Project ${projectId} status update lost ownership.`);
      return updated;
    });
    return transaction.immediate();
  }

  createScene(input: CreateSceneInput): SceneRecord {
    const id = input.id ?? randomUUID();
    const title = requiredText(input.title ?? input.name ?? "", "Scene title");
    const sceneNumber = input.sceneNumber ?? input.sequence;
    if (!Number.isSafeInteger(sceneNumber) || (sceneNumber ?? 0) < 1) {
      throw new Error("Scene number must be a positive integer.");
    }
    const now = input.now ?? new Date().toISOString();
    const transaction = this.db.transaction(() => {
      if (!this.getProject(input.projectId)) {
        throw new Error(`Project not found: ${input.projectId}`);
      }
      this.db.prepare(`
        INSERT INTO scenes (
          id, project_id, name, sequence, title, scene_number, description,
          status, metadata_json, created_at, updated_at
        ) VALUES (
          @id, @projectId, @title, @sceneNumber, @title, @sceneNumber,
          @description, @status, @metadata, @createdAt, @updatedAt
        )
      `).run({
        id,
        projectId: input.projectId,
        title,
        sceneNumber,
        description: input.description ?? null,
        status: input.status ?? "DRAFT",
        metadata: encodeOptionalJson(input.metadata),
        createdAt: now,
        updatedAt: now,
      });
      return this.getScene(id)!;
    });
    return transaction.immediate();
  }

  getScene(id: string): SceneRecord | null {
    const row = this.db.prepare("SELECT * FROM scenes WHERE id = ?").get(id) as SceneRow | undefined;
    return row ? sceneFromRow(row) : null;
  }

  listProjectScenes(projectId: string): SceneRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_number, created_at, id
    `).all(projectId) as SceneRow[];
    return rows.map(sceneFromRow);
  }

  createSceneVersion(input: CreateSceneVersionInput): SceneVersionRecord {
    if (!input.prompt.trim()) throw new Error("Scene version prompt is required.");
    const prompt = input.prompt;
    const now = input.now ?? new Date().toISOString();
    const references = input.references ?? [];
    const referencesJson = stableJson(references);
    const metadataJson = encodeOptionalJson(input.metadata);
    const transaction = this.db.transaction(() => {
      const scene = this.getScene(input.sceneId);
      if (!scene) throw new Error(`Scene not found: ${input.sceneId}`);

      if (input.id) {
        const existing = this.getSceneVersion(input.id);
        if (existing) {
          const same = existing.sceneId === input.sceneId &&
            existing.prompt === prompt &&
            stableJson(existing.references) === referencesJson &&
            stableJson(existing.metadata ?? {}) === stableJson(input.metadata ?? {}) &&
            (input.parentVersionId === undefined || existing.parentVersionId === input.parentVersionId);
          if (!same) throw new Error(`Scene version ID already exists with different content: ${input.id}`);
          return existing;
        }
      }

      const parentVersionId = input.parentVersionId ?? scene.currentVersionId ?? null;
      if (parentVersionId) {
        const parent = this.getSceneVersion(parentVersionId);
        if (!parent || parent.sceneId !== input.sceneId) {
          throw new Error("Parent scene version must belong to the same scene.");
        }
      }

      const versionNumber = (this.db.prepare(`
        SELECT COALESCE(MAX(version_number), 0) + 1 AS next_number
        FROM scene_versions WHERE scene_id = ?
      `).get(input.sceneId) as { next_number: number }).next_number;
      const id = input.id ?? randomUUID();
      this.db.prepare(`
        INSERT INTO scene_versions (
          id, scene_id, version_number, prompt, references_json,
          metadata_json, parent_version_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.sceneId, versionNumber, prompt, referencesJson, metadataJson, parentVersionId, now);
      this.setCurrentSceneVersionInTransaction(input.sceneId, id, now);
      return this.getSceneVersion(id)!;
    });
    return transaction.immediate();
  }

  getSceneVersion(id: string): SceneVersionRecord | null {
    const row = this.db.prepare("SELECT * FROM scene_versions WHERE id = ?").get(id) as SceneVersionRow | undefined;
    return row ? sceneVersionFromRow(row) : null;
  }

  getCurrentSceneVersion(sceneId: string): SceneVersionRecord | null {
    const scene = this.getScene(sceneId);
    if (!scene?.currentVersionId) return null;
    return this.getSceneVersion(scene.currentVersionId);
  }

  listSceneVersions(sceneId: string): SceneVersionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM scene_versions WHERE scene_id = ? ORDER BY version_number, id
    `).all(sceneId) as SceneVersionRow[];
    return rows.map(sceneVersionFromRow);
  }

  setCurrentSceneVersion(sceneId: string, sceneVersionId: string, now = new Date().toISOString()): SceneRecord {
    const transaction = this.db.transaction(() => {
      this.setCurrentSceneVersionInTransaction(sceneId, sceneVersionId, now);
      return this.getScene(sceneId)!;
    });
    return transaction.immediate();
  }

  /**
   * Guarded scene status change. Callers may move a scene to READY only through the
   * application service that has already validated derived production readiness; this method
   * enforces the domain transition table and refuses concurrent overwrites.
   */
  updateSceneStatus(sceneId: string, to: SceneStatus, now = new Date().toISOString()): SceneRecord {
    const transaction = this.db.transaction(() => {
      const scene = this.getScene(sceneId);
      if (!scene) throw new Error(`Scene not found: ${sceneId}`);
      if (scene.status !== to) assertSceneStatusTransition(scene.status, to);
      this.db
        .prepare("UPDATE scenes SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
        .run(to, now, sceneId, scene.status);
      const updated = this.getScene(sceneId)!;
      if (updated.status !== to) throw new Error(`Scene ${sceneId} status update lost ownership.`);
      return updated;
    });
    return transaction.immediate();
  }

  private setCurrentSceneVersionInTransaction(sceneId: string, sceneVersionId: string, now: string): void {
    const version = this.getSceneVersion(sceneVersionId);
    if (!version || version.sceneId !== sceneId) {
      throw new Error(`Scene version ${sceneVersionId} does not belong to scene ${sceneId}.`);
    }
    const result = this.db.prepare(`
      UPDATE scenes SET current_version_id = ?, updated_at = ? WHERE id = ?
    `).run(sceneVersionId, now, sceneId);
    if (result.changes !== 1) throw new Error(`Scene not found: ${sceneId}`);
  }

  createGenerationJob(input: CreateGenerationJobInput): GenerationJob {
    return this.createGenerationJobWithCreated(input).job;
  }

  /**
   * Identical durable transaction as `createGenerationJob`, additionally reporting whether
   * this call inserted the job (and its queue item) or reused the job already stored for the
   * canonical idempotency key. The application layer needs that distinction to tell an
   * operator "accepted" from "already queued/finished" without a second write.
   */
  createGenerationJobWithCreated(input: CreateGenerationJobInput): {
    job: GenerationJob;
    created: boolean;
  } {
    const now = input.now ?? new Date().toISOString();
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer.");
    }
    const provider = requiredText(input.provider, "Provider ID");
    const parameters = input.parameters ?? {};
    const parametersJson = stableJson(parameters);

    const transaction = this.db.transaction(() => {
      const scene = this.getScene(input.sceneId);
      if (!scene || scene.projectId !== input.projectId) {
        throw new Error("Scene must exist and belong to the requested project.");
      }
      const sceneVersion = this.getSceneVersion(input.sceneVersionId);
      if (!sceneVersion || sceneVersion.sceneId !== scene.id) {
        throw new Error("Scene version must belong to the requested scene.");
      }
      const identityJson = stableJson({
        projectId: input.projectId,
        sceneId: input.sceneId,
        sceneVersionId: input.sceneVersionId,
        provider,
        prompt: sceneVersion.prompt,
        references: sceneVersion.references,
        parameters,
      });
      const idempotencyKey = createIdempotencyKey(identityJson);
      const existingRow = this.db.prepare(`
        SELECT * FROM generation_jobs WHERE idempotency_key = ?
      `).get(idempotencyKey) as JobRow | undefined;
      if (existingRow) {
        if (existingRow.identity_json !== identityJson) {
          throw new Error("Idempotency key collision: stored request identity differs.");
        }
        return { job: jobFromRow(existingRow), created: false };
      }

      const id = input.id ?? randomUUID();
      const request: GenerationRequest = {
        projectId: input.projectId,
        sceneId: input.sceneId,
        sceneVersionId: input.sceneVersionId,
        prompt: sceneVersion.prompt,
        references: sceneVersion.references,
        provider,
        parameters,
        metadata: input.metadata,
      };
      this.db.prepare(`
        INSERT INTO generation_jobs (
          id, project_id, scene_id, scene_version_id, provider, prompt,
          references_json, parameters_json, metadata_json, idempotency_key,
          identity_json, status, attempt_count, max_attempts, external_id,
          error, created_at, updated_at
        ) VALUES (
          @id, @projectId, @sceneId, @sceneVersionId, @provider, @prompt,
          @references, @parameters, @metadata, @idempotencyKey,
          @identity, 'QUEUED', 0, @maxAttempts, NULL, NULL, @createdAt, @updatedAt
        )
      `).run({
        id,
        projectId: request.projectId,
        sceneId: request.sceneId,
        sceneVersionId: request.sceneVersionId,
        provider: request.provider,
        prompt: request.prompt,
        references: stableJson(request.references ?? []),
        parameters: parametersJson,
        metadata: encodeOptionalJson(input.metadata),
        idempotencyKey,
        identity: identityJson,
        maxAttempts,
        createdAt: now,
        updatedAt: now,
      });
      this.insertQueueItem(id, input.priority ?? 0, now, now);
      return { job: this.getGenerationJob(id)!, created: true };
    });
    return transaction.immediate();
  }

  getGenerationJob(id: string): GenerationJob | null {
    const row = this.db.prepare("SELECT * FROM generation_jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? jobFromRow(row) : null;
  }

  getGenerationJobByIdempotencyKey(key: string): GenerationJob | null {
    const row = this.db.prepare("SELECT * FROM generation_jobs WHERE idempotency_key = ?").get(key) as JobRow | undefined;
    return row ? jobFromRow(row) : null;
  }

  listGenerationJobs(filter: GenerationJobFilter = {}): GenerationJob[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (filter.projectId) {
      clauses.push("project_id = ?");
      args.push(filter.projectId);
    }
    if (filter.sceneId) {
      clauses.push("scene_id = ?");
      args.push(filter.sceneId);
    }
    if (filter.sceneVersionId) {
      clauses.push("scene_version_id = ?");
      args.push(filter.sceneVersionId);
    }
    if (filter.status) {
      clauses.push("status = ?");
      args.push(filter.status);
    }
    if (filter.provider) {
      clauses.push("provider = ?");
      args.push(filter.provider);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM generation_jobs${where} ORDER BY created_at, id`)
      .all(...args) as JobRow[];
    return rows.map(jobFromRow);
  }

  countGenerationJobs(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM generation_jobs").get() as { count: number }).count;
  }

  getQueueItemByJob(jobId: string): QueueItemRecord | null {
    const row = this.db.prepare("SELECT * FROM queue_items WHERE generation_job_id = ?").get(jobId) as QueueRow | undefined;
    return row ? queueItemFromRow(row) : null;
  }

  getQueueItem(id: string): QueueItemRecord | null {
    const row = this.db.prepare("SELECT * FROM queue_items WHERE id = ?").get(id) as QueueRow | undefined;
    return row ? queueItemFromRow(row) : null;
  }

  listQueueItems(filter: QueueItemFilter = {}): QueueItemRecord[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (filter.status) {
      clauses.push("status = ?");
      args.push(filter.status);
    }
    if (filter.statuses) {
      clauses.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      args.push(...filter.statuses);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM queue_items${where} ORDER BY priority DESC, enqueued_at, id`)
      .all(...args) as QueueRow[];
    return rows.map(queueItemFromRow);
  }

  queueSize(): number {
    return (this.db.prepare(`
      SELECT COUNT(*) AS count FROM queue_items WHERE status IN ('QUEUED', 'CLAIMED')
    `).get() as { count: number }).count;
  }

  hasQueueItem(jobId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 AS present FROM queue_items WHERE generation_job_id = ? AND status IN ('QUEUED', 'CLAIMED')
    `).get(jobId));
  }

  claimNext(workerId: string, leaseMs: number, now = new Date().toISOString()): ClaimedGeneration | null {
    requiredText(workerId, "Worker ID");
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be a positive integer.");
    const claimedAtMs = Date.parse(now);
    if (!Number.isFinite(claimedAtMs)) throw new Error("Invalid claim timestamp.");
    const leaseUntil = new Date(claimedAtMs + leaseMs).toISOString();

    const transaction = this.db.transaction(() => {
      const queueRow = this.db.prepare(`
        SELECT * FROM queue_items
        WHERE status = 'QUEUED' AND available_at <= ?
        ORDER BY priority DESC, enqueued_at ASC, id ASC
        LIMIT 1
      `).get(now) as QueueRow | undefined;
      if (!queueRow) return null;

      const job = this.getGenerationJob(queueRow.generation_job_id);
      if (!job) throw new Error(`Queued generation job not found: ${queueRow.generation_job_id}`);
      if (job.status !== "QUEUED") {
        throw new Error(`Queue/job status mismatch for ${job.id}: ${queueRow.status}/${job.status}`);
      }
      assertTransition(job.status, "CLAIMED");
      const updatedQueue = this.db.prepare(`
        UPDATE queue_items
        SET status = 'CLAIMED', claimed_at = ?, lease_until = ?, worker_id = ?,
            claim_count = claim_count + 1, last_error = NULL
        WHERE id = ? AND status = 'QUEUED'
      `).run(now, leaseUntil, workerId, queueRow.id);
      if (updatedQueue.changes !== 1) return null;
      this.db.prepare(`
        UPDATE generation_jobs SET status = 'CLAIMED', updated_at = ? WHERE id = ?
      `).run(now, job.id);

      let attempt = this.getActiveAttempt(job.id);
      if (!attempt) {
        if (job.attemptCount >= job.maxAttempts) {
          this.db.prepare(`
            UPDATE generation_jobs SET status = 'FAILED', error = ?, updated_at = ? WHERE id = ?
          `).run("Retry limit reached before claim.", now, job.id);
          this.db.prepare(`
            UPDATE queue_items SET status = 'FAILED', lease_until = NULL, worker_id = NULL,
              claimed_at = NULL, last_error = ? WHERE id = ?
          `).run("Retry limit reached before claim.", queueRow.id);
          return null;
        }
        const attemptNumber = job.attemptCount + 1;
        const attemptId = randomUUID();
        const providerRequestKey = `${job.idempotencyKey}:attempt:${attemptNumber}`;
        this.db.prepare(`
          INSERT INTO generation_attempts (
            id, generation_job_id, attempt_number, provider, provider_request_key,
            provider_job_id, status, started_at, completed_at, error, error_class,
            recovery_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, 'CLAIMED', NULL, NULL, NULL, NULL, 0, ?, ?)
        `).run(attemptId, job.id, attemptNumber, job.request.provider, providerRequestKey, now, now);
        this.db.prepare(`
          UPDATE generation_jobs SET attempt_count = ?, updated_at = ? WHERE id = ?
        `).run(attemptNumber, now, job.id);
        attempt = this.getAttempt(attemptId);
      }

      const claimedJob = this.getGenerationJob(job.id)!;
      const claimedQueue = this.getQueueItem(queueRow.id)!;
      if (!attempt) throw new Error(`Unable to create or resume generation attempt for ${job.id}.`);
      return { job: claimedJob, queueItem: claimedQueue, attempt };
    });
    return transaction.immediate();
  }

  recoverExpiredLeases(now = new Date().toISOString()): number {
    const transaction = this.db.transaction(() => {
      const expired = this.db.prepare(`
        SELECT * FROM queue_items
        WHERE status = 'CLAIMED' AND lease_until IS NOT NULL AND lease_until <= ?
        ORDER BY lease_until, id
      `).all(now) as QueueRow[];
      let recovered = 0;
      for (const queueItem of expired) {
        const job = this.getGenerationJob(queueItem.generation_job_id);
        if (!job) continue;
        if (job.status === "SUCCEEDED") {
          this.db.prepare(`
            UPDATE queue_items SET status = 'ACKED', acknowledged_at = ?,
              claimed_at = NULL, lease_until = NULL, worker_id = NULL
            WHERE id = ?
          `).run(now, queueItem.id);
          recovered += 1;
          continue;
        }
        if (job.status === "CANCELLED") {
          this.db.prepare(`
            UPDATE queue_items SET status = 'CANCELLED', claimed_at = NULL,
              lease_until = NULL, worker_id = NULL WHERE id = ?
          `).run(queueItem.id);
          recovered += 1;
          continue;
        }
        if (job.status === "FAILED") {
          this.db.prepare(`
            UPDATE queue_items SET status = 'FAILED', claimed_at = NULL,
              lease_until = NULL, worker_id = NULL, last_error = COALESCE(last_error, 'Generation job is failed')
            WHERE id = ?
          `).run(queueItem.id);
          recovered += 1;
          continue;
        }
        if (job.status === "CLAIMED" || job.status === "RUNNING") {
          assertTransition(job.status, "QUEUED");
          this.db.prepare(`
            UPDATE generation_jobs SET status = 'QUEUED', updated_at = ? WHERE id = ?
          `).run(now, job.id);
        }
        this.db.prepare(`
          UPDATE queue_items SET status = 'QUEUED', available_at = ?, claimed_at = NULL,
            lease_until = NULL, worker_id = NULL, last_error = ? WHERE id = ?
        `).run(now, "Previous worker lease expired; resuming the same attempt safely.", queueItem.id);
        recovered += 1;
      }
      return recovered;
    });
    return transaction.immediate();
  }

  markAttemptRunning(jobId: string, attemptId: string, workerId: string, now = new Date().toISOString()): void {
    const transaction = this.db.transaction(() => {
      this.assertWorkerOwnsLease(jobId, workerId, now);
      const job = this.getGenerationJob(jobId);
      const attempt = this.getAttempt(attemptId);
      if (!job || !attempt || attempt.generationJobId !== jobId) throw new Error("Generation attempt/job not found.");
      if (job.status === "CLAIMED") {
        assertTransition(job.status, "RUNNING");
        this.db.prepare("UPDATE generation_jobs SET status = 'RUNNING', updated_at = ? WHERE id = ?").run(now, jobId);
      } else if (job.status !== "RUNNING") {
        throw new Error(`Cannot run generation job ${jobId} from ${job.status}.`);
      }
      if (attempt.status === "CLAIMED") {
        this.db.prepare(`
          UPDATE generation_attempts SET status = 'RUNNING', started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE id = ?
        `).run(now, now, attemptId);
      } else if (attempt.status !== "RUNNING") {
        throw new Error(`Cannot resume generation attempt ${attemptId} from ${attempt.status}.`);
      }
    });
    transaction.immediate();
  }

  extendLease(jobId: string, workerId: string, leaseMs: number, now = new Date().toISOString()): boolean {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be a positive integer.");
    const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
    const result = this.db.prepare(`
      UPDATE queue_items SET lease_until = ?
      WHERE generation_job_id = ? AND status = 'CLAIMED' AND worker_id = ?
        AND lease_until IS NOT NULL AND lease_until > ?
    `).run(leaseUntil, jobId, workerId, now);
    return result.changes === 1;
  }

  setProviderJobId(
    jobId: string,
    attemptId: string,
    workerId: string,
    providerJobId: string,
    now = new Date().toISOString(),
  ): void {
    const transaction = this.db.transaction(() => {
      this.assertWorkerOwnsLease(jobId, workerId, now);
      const result = this.db.prepare(`
        UPDATE generation_attempts SET provider_job_id = ?, updated_at = ?
        WHERE id = ? AND generation_job_id = ? AND status = 'RUNNING'
          AND (provider_job_id IS NULL OR provider_job_id = ?)
      `).run(requiredText(providerJobId, "Provider job ID"), now, attemptId, jobId, providerJobId);
      if (result.changes !== 1) throw new Error(`Unable to record provider job for attempt ${attemptId}.`);
    });
    transaction.immediate();
  }

  getAttempt(id: string): GenerationAttempt | null {
    const row = this.db.prepare("SELECT * FROM generation_attempts WHERE id = ?").get(id) as AttemptRow | undefined;
    return row ? attemptFromRow(row) : null;
  }

  getActiveAttempt(jobId: string): GenerationAttempt | null {
    const row = this.db.prepare(`
      SELECT * FROM generation_attempts
      WHERE generation_job_id = ? AND status IN ('CLAIMED', 'RUNNING')
      ORDER BY attempt_number DESC LIMIT 1
    `).get(jobId) as AttemptRow | undefined;
    return row ? attemptFromRow(row) : null;
  }

  listGenerationAttempts(jobId: string): GenerationAttempt[] {
    const rows = this.db.prepare(`
      SELECT * FROM generation_attempts WHERE generation_job_id = ? ORDER BY attempt_number, id
    `).all(jobId) as AttemptRow[];
    return rows.map(attemptFromRow);
  }

  failAttemptAndScheduleRetry(input: FailAttemptInput): GenerationJob {
    const now = input.now ?? new Date().toISOString();
    const transaction = this.db.transaction(() => {
      this.assertWorkerOwnsLease(input.jobId, input.workerId, now);
      const job = this.getGenerationJob(input.jobId);
      const attempt = this.getAttempt(input.attemptId);
      if (!job || !attempt || attempt.generationJobId !== input.jobId) throw new Error("Generation attempt/job not found.");
      if (attempt.status !== "CLAIMED" && attempt.status !== "RUNNING") {
        throw new Error(`Cannot fail attempt ${attempt.id} from ${attempt.status}.`);
      }
      const queue = this.getQueueItemByJob(input.jobId);
      if (!queue) throw new Error(`Queue item not found for job ${input.jobId}.`);
      const canRetry = input.retryable && attempt.attemptNumber < job.maxAttempts;
      const retryAt = input.retryAt ?? now;

      this.db.prepare(`
        UPDATE generation_attempts
        SET status = 'FAILED', completed_at = ?, error = ?, error_class = ?, updated_at = ?
        WHERE id = ?
      `).run(now, input.error, input.errorClass, now, attempt.id);

      if (job.status !== "FAILED") {
        assertTransition(job.status, "FAILED");
        this.db.prepare(`
          UPDATE generation_jobs SET status = 'FAILED', error = ?, updated_at = ? WHERE id = ?
        `).run(input.error, now, job.id);
      }

      if (canRetry) {
        assertTransition("FAILED", "QUEUED");
        this.db.prepare(`
          UPDATE generation_jobs SET status = 'QUEUED', updated_at = ? WHERE id = ?
        `).run(now, job.id);
        this.db.prepare(`
          UPDATE queue_items SET status = 'QUEUED', available_at = ?, claimed_at = NULL,
            lease_until = NULL, worker_id = NULL, acknowledged_at = NULL, last_error = ?
          WHERE id = ?
        `).run(retryAt, input.error, queue.id);
      } else {
        this.db.prepare(`
          UPDATE queue_items SET status = 'FAILED', claimed_at = NULL, lease_until = NULL,
            worker_id = NULL, last_error = ? WHERE id = ?
        `).run(input.error, queue.id);
      }
      return this.getGenerationJob(job.id)!;
    });
    return transaction.immediate();
  }

  deferAttemptForRecovery(input: DeferAttemptInput): GenerationJob {
    const now = input.now ?? new Date().toISOString();
    const transaction = this.db.transaction(() => {
      this.assertWorkerOwnsLease(input.jobId, input.workerId, now);
      const job = this.getGenerationJob(input.jobId);
      const attempt = this.getAttempt(input.attemptId);
      const queue = this.getQueueItemByJob(input.jobId);
      if (!job || !attempt || !queue || attempt.generationJobId !== job.id) {
        throw new Error("Generation job, attempt, or queue item not found.");
      }
      if (attempt.status !== "RUNNING") throw new Error(`Cannot defer attempt ${attempt.id} from ${attempt.status}.`);
      const recoveryCount = attempt.recoveryCount + 1;
      const exhausted = recoveryCount > input.maxRecoveries;
      this.db.prepare(`
        UPDATE generation_attempts
        SET recovery_count = ?, error = ?, error_class = ?, updated_at = ?
        WHERE id = ?
      `).run(recoveryCount, input.error, input.errorClass, now, attempt.id);

      if (exhausted) {
        this.db.prepare(`
          UPDATE generation_attempts SET status = 'FAILED', completed_at = ?, updated_at = ? WHERE id = ?
        `).run(now, now, attempt.id);
        assertTransition(job.status, "FAILED");
        this.db.prepare(`
          UPDATE generation_jobs SET status = 'FAILED', error = ?, updated_at = ? WHERE id = ?
        `).run(input.error, now, job.id);
        this.db.prepare(`
          UPDATE queue_items SET status = 'FAILED', claimed_at = NULL, lease_until = NULL,
            worker_id = NULL, last_error = ? WHERE id = ?
        `).run(input.error, queue.id);
      } else {
        assertTransition(job.status, "QUEUED");
        this.db.prepare("UPDATE generation_jobs SET status = 'QUEUED', updated_at = ? WHERE id = ?").run(now, job.id);
        this.db.prepare(`
          UPDATE queue_items SET status = 'QUEUED', available_at = ?, claimed_at = NULL,
            lease_until = NULL, worker_id = NULL, acknowledged_at = NULL, last_error = ?
          WHERE id = ?
        `).run(input.retryAt ?? now, input.error, queue.id);
      }
      return this.getGenerationJob(job.id)!;
    });
    return transaction.immediate();
  }

  completeGeneration(input: CompleteGenerationInput): CompletedGeneration {
    const now = input.now ?? new Date().toISOString();
    const transaction = this.db.transaction(() => {
      this.assertWorkerOwnsLease(input.jobId, input.workerId, now);
      const job = this.getGenerationJob(input.jobId);
      const attempt = this.getAttempt(input.attemptId);
      const queue = this.getQueueItemByJob(input.jobId);
      if (!job || !attempt || !queue || attempt.generationJobId !== job.id) {
        throw new Error("Generation job, attempt, or queue item not found.");
      }
      if (job.status !== "RUNNING" || attempt.status !== "RUNNING") {
        throw new Error(`Only a running job/attempt can complete (${job.status}/${attempt.status}).`);
      }
      if (!job.request.sceneVersionId) throw new Error(`Generation job ${job.id} has no scene version.`);

      const sceneVersion = this.getSceneVersion(job.request.sceneVersionId);
      if (!sceneVersion || sceneVersion.sceneId !== job.request.sceneId) {
        throw new Error("Generation job scene version does not match its scene.");
      }
      const existingVersionRow = this.db.prepare(`
        SELECT * FROM asset_versions WHERE generation_attempt_id = ? AND output_index = ?
      `).get(attempt.id, input.asset.outputIndex) as AssetVersionRow | undefined;

      let assetVersionId = existingVersionRow?.id ?? input.asset.versionId;
      let assetId = existingVersionRow?.asset_id ?? input.asset.id;
      if (existingVersionRow) {
        const existing = assetVersionFromRow(existingVersionRow);
        if (existing.checksum !== input.asset.checksum || existing.storagePath !== input.asset.storagePath) {
          throw new Error("An attempt/output already points at different immutable asset bytes.");
        }
      } else {
        const existingAsset = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(assetId) as AssetRow | undefined;
        if (existingAsset && (existingAsset.job_id !== job.id || existingAsset.sha256 !== input.asset.checksum)) {
          throw new Error(`Asset ID collision or mismatched asset metadata: ${assetId}`);
        }
        if (!existingAsset) {
          this.db.prepare(`
            INSERT INTO assets (
              id, project_id, scene_id, job_id, kind, path, mime_type, size_bytes,
              sha256, provider, external_id, metadata_json, scene_version_id,
              generation_attempt_id, current_version_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
          `).run(
            assetId,
            job.request.projectId,
            job.request.sceneId,
            job.id,
            input.asset.kind,
            input.asset.storagePath,
            input.asset.mimeType,
            input.asset.sizeBytes,
            input.asset.checksum,
            job.request.provider,
            input.providerJobId,
            encodeOptionalJson(input.asset.metadata),
            job.request.sceneVersionId,
            attempt.id,
            now,
            now,
          );
        }
        this.db.prepare(`
          INSERT INTO asset_versions (
            id, asset_id, version_number, scene_version_id, generation_job_id,
            generation_attempt_id, provider, storage_path, mime_type, size_bytes,
            checksum, output_index, width, height, metadata_json, created_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          assetVersionId,
          assetId,
          job.request.sceneVersionId,
          job.id,
          attempt.id,
          job.request.provider,
          input.asset.storagePath,
          input.asset.mimeType,
          input.asset.sizeBytes,
          input.asset.checksum,
          input.asset.outputIndex,
          input.asset.width ?? null,
          input.asset.height ?? null,
          encodeOptionalJson(input.asset.metadata),
          now,
        );
      }

      this.db.prepare(`
        UPDATE assets SET current_version_id = ?, updated_at = ? WHERE id = ?
      `).run(assetVersionId, now, assetId);
      this.insertQCResult(assetVersionId, input.qc, now);
      this.insertPendingReview(assetVersionId, now);

      const completeAttempt = this.db.prepare(`
        UPDATE generation_attempts
        SET status = 'SUCCEEDED', provider_job_id = ?, completed_at = ?,
            error = NULL, error_class = NULL, updated_at = ?
        WHERE id = ? AND status = 'RUNNING'
      `).run(input.providerJobId, now, now, attempt.id);
      if (completeAttempt.changes !== 1) throw new Error(`Attempt completion lost ownership: ${attempt.id}`);
      assertTransition(job.status, "SUCCEEDED");
      this.db.prepare(`
        UPDATE generation_jobs SET status = 'SUCCEEDED', external_id = ?, error = NULL, updated_at = ?
        WHERE id = ?
      `).run(input.providerJobId, now, job.id);
      const ack = this.db.prepare(`
        UPDATE queue_items SET status = 'ACKED', acknowledged_at = ?, claimed_at = NULL,
          lease_until = NULL, worker_id = NULL, last_error = NULL
        WHERE id = ? AND status = 'CLAIMED' AND worker_id = ?
      `).run(now, queue.id, input.workerId);
      if (ack.changes !== 1) throw new Error(`Queue acknowledgement lost ownership for ${job.id}.`);

      return {
        job: this.getGenerationJob(job.id)!,
        asset: this.getAsset(assetId)!,
        assetVersion: this.getAssetVersion(assetVersionId)!,
        qcResult: this.getQCResult(assetVersionId)!,
        review: this.getReviewByAssetVersion(assetVersionId)!,
      };
    });
    return transaction.immediate();
  }

  getAsset(id: string): AssetRecord | null {
    const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as AssetRow | undefined;
    return row ? assetFromRow(row) : null;
  }

  getAssetVersion(id: string): AssetVersionRecord | null {
    const row = this.db.prepare("SELECT * FROM asset_versions WHERE id = ?").get(id) as AssetVersionRow | undefined;
    return row ? assetVersionFromRow(row) : null;
  }

  getAssetVersionByAttempt(attemptId: string, outputIndex = 0): AssetVersionRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM asset_versions WHERE generation_attempt_id = ? AND output_index = ?
    `).get(attemptId, outputIndex) as AssetVersionRow | undefined;
    return row ? assetVersionFromRow(row) : null;
  }

  listAssetVersionsForSceneVersion(sceneVersionId: string): AssetVersionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM asset_versions WHERE scene_version_id = ? ORDER BY created_at, id
    `).all(sceneVersionId) as AssetVersionRow[];
    return rows.map(assetVersionFromRow);
  }

  findAssetsBySha256(sha256: string): AssetRecord[] {
    const rows = this.db.prepare(`SELECT * FROM assets WHERE sha256 = ? ORDER BY created_at, id`).all(sha256) as AssetRow[];
    return rows.map(assetFromRow);
  }

  listProjectAssets(projectId: string): AssetRecord[] {
    const rows = this.db.prepare(`SELECT * FROM assets WHERE project_id = ? ORDER BY created_at, id`).all(projectId) as AssetRow[];
    return rows.map(assetFromRow);
  }

  getQCResult(assetVersionId: string, validatorVersion = "deterministic-v1"): QCResultRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM qc_results WHERE asset_version_id = ? AND validator_version = ?
    `).get(assetVersionId, validatorVersion) as QCRow | undefined;
    return row ? qcFromRow(row) : null;
  }

  getReviewByAssetVersion(assetVersionId: string): ReviewRecord | null {
    const row = this.db.prepare("SELECT * FROM reviews WHERE asset_version_id = ?").get(assetVersionId) as ReviewRow | undefined;
    return row ? reviewFromRow(row) : null;
  }

  decideReview(input: DecideReviewInput): ReviewRecord {
    const now = input.now ?? new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const version = this.getAssetVersion(input.assetVersionId);
      if (!version) throw new Error(`Asset version not found: ${input.assetVersionId}`);
      this.insertPendingReview(input.assetVersionId, now);
      const current = this.getReviewByAssetVersion(input.assetVersionId)!;
      if (current.status !== "PENDING") {
        const sameDecision = current.status === input.status &&
          current.reason === input.reason && current.comment === input.comment && current.reviewer === input.reviewer;
        if (sameDecision) return current;
        throw new Error(`Review ${current.id} already has a final decision (${current.status}).`);
      }
      this.db.prepare(`
        UPDATE reviews SET status = ?, reason = ?, comment = ?, reviewer = ?, updated_at = ?
        WHERE id = ? AND status = 'PENDING'
      `).run(input.status, input.reason ?? null, input.comment ?? null, input.reviewer ?? null, now, current.id);
      return this.getReviewByAssetVersion(input.assetVersionId)!;
    });
    return transaction.immediate();
  }

  selectApprovedAssetVersion(sceneId: string, assetVersionId: string, now = new Date().toISOString()): SceneRecord {
    const transaction = this.db.transaction(() => {
      const scene = this.getScene(sceneId);
      if (!scene) throw new Error(`Scene not found: ${sceneId}`);
      const versionRow = this.db.prepare(`
        SELECT v.id, v.scene_version_id, v.asset_id, a.scene_id
        FROM asset_versions v JOIN assets a ON a.id = v.asset_id
        WHERE v.id = ?
      `).get(assetVersionId) as { id: string; scene_version_id: string; asset_id: string; scene_id: string | null } | undefined;
      if (!versionRow || versionRow.scene_id !== sceneId) {
        throw new Error(`Asset version ${assetVersionId} does not belong to scene ${sceneId}.`);
      }
      const review = this.getReviewByAssetVersion(assetVersionId);
      if (!review || review.status !== "APPROVED") {
        throw new Error("Only an explicitly approved asset version can be selected.");
      }
      const qc = this.getQCResult(assetVersionId);
      if (!qc || qc.status !== "PASSED") {
        throw new Error("Only an asset version with passing deterministic QC can be selected.");
      }
      const sceneVersion = this.getSceneVersion(versionRow.scene_version_id);
      if (!sceneVersion || sceneVersion.sceneId !== sceneId) {
        throw new Error("Asset version has an invalid scene-version link.");
      }
      this.db.prepare(`
        UPDATE scenes SET current_version_id = ?, selected_asset_version_id = ?, updated_at = ?
        WHERE id = ?
      `).run(sceneVersion.id, assetVersionId, now, sceneId);
      this.db.prepare("UPDATE assets SET current_version_id = ?, updated_at = ? WHERE id = ?")
        .run(assetVersionId, now, versionRow.asset_id);
      return this.getScene(sceneId)!;
    });
    return transaction.immediate();
  }

  getSelectedAssetVersion(sceneId: string): AssetVersionRecord | null {
    const scene = this.getScene(sceneId);
    return scene?.selectedAssetVersionId ? this.getAssetVersion(scene.selectedAssetVersionId) : null;
  }

  cancelGenerationJob(jobId: string, now = new Date().toISOString()): GenerationJob {
    const transaction = this.db.transaction(() => {
      const job = this.getGenerationJob(jobId);
      if (!job) throw new Error(`Generation job not found: ${jobId}`);
      if (job.status === "CANCELLED") return job;
      assertTransition(job.status, "CANCELLED");
      this.db.prepare("UPDATE generation_jobs SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(now, jobId);
      this.db.prepare(`
        UPDATE queue_items SET status = 'CANCELLED', claimed_at = NULL, lease_until = NULL,
          worker_id = NULL, last_error = 'Cancelled by user'
        WHERE generation_job_id = ? AND status IN ('QUEUED', 'CLAIMED')
      `).run(jobId);
      this.db.prepare(`
        UPDATE generation_attempts SET status = 'CANCELLED', completed_at = ?, updated_at = ?
        WHERE generation_job_id = ? AND status IN ('CLAIMED', 'RUNNING')
      `).run(now, now, jobId);
      return this.getGenerationJob(jobId)!;
    });
    return transaction.immediate();
  }

  retryFailedJob(jobId: string, availableAt = new Date().toISOString()): GenerationJob {
    const transaction = this.db.transaction(() => {
      const job = this.getGenerationJob(jobId);
      if (!job) throw new Error(`Generation job not found: ${jobId}`);
      if (job.status !== "FAILED") throw new Error(`Only failed jobs can be retried (current status: ${job.status}).`);
      if (job.idempotencyKey.startsWith("legacy:")) {
        throw new Error("Legacy jobs lack safe attempt history; create a new scene-versioned request instead of retrying one.");
      }
      if (job.attemptCount >= job.maxAttempts) throw new Error(`Generation job ${jobId} exhausted its retry limit.`);
      const placeholders = UNSAFE_RETRY_ERROR_CLASSES.map(() => "?").join(", ");
      const unsafePriorResult = this.db.prepare(`
        SELECT 1 AS present FROM generation_attempts
        WHERE generation_job_id = ? AND error_class IN (${placeholders}) LIMIT 1
      `).get(jobId, ...UNSAFE_RETRY_ERROR_CLASSES);
      if (unsafePriorResult) {
        throw new Error("This generation has an uncertain or known provider result; create a new scene version instead of resubmitting it.");
      }
      assertTransition(job.status, "QUEUED");
      const queue = this.getQueueItemByJob(jobId);
      if (!queue) throw new Error(`Queue item not found for job ${jobId}.`);
      this.db.prepare("UPDATE generation_jobs SET status = 'QUEUED', updated_at = ? WHERE id = ?").run(availableAt, jobId);
      this.db.prepare(`
        UPDATE queue_items SET status = 'QUEUED', available_at = ?, claimed_at = NULL,
          lease_until = NULL, worker_id = NULL, acknowledged_at = NULL, last_error = NULL
        WHERE id = ?
      `).run(availableAt, queue.id);
      return this.getGenerationJob(jobId)!;
    });
    return transaction.immediate();
  }

  /** Legacy asset registration retained for callers of the initial storage API. */
  registerAsset(input: RegisterAssetInput): AssetRecord {
    if (!this.getProject(input.projectId)) throw new Error(`Project not found: ${input.projectId}`);
    if (input.sceneId) {
      const scene = this.getScene(input.sceneId);
      if (!scene || scene.projectId !== input.projectId) {
        throw new Error("Asset scene must belong to the requested project.");
      }
    }
    if (input.jobId) {
      const job = this.getGenerationJob(input.jobId);
      if (!job || job.request.projectId !== input.projectId || (input.sceneId && job.request.sceneId !== input.sceneId)) {
        throw new Error("Asset generation job provenance must match the requested project and scene.");
      }
    }
    if (!existsSync(input.path)) throw new Error(`Asset file does not exist: ${input.path}`);
    const stats = statSync(input.path);
    if (!stats.isFile()) throw new Error(`Asset path is not a file: ${input.path}`);
    const sha256 = hashFileSha256(input.path);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO assets (
        id, project_id, scene_id, job_id, kind, path, mime_type, size_bytes,
        sha256, provider, external_id, metadata_json, created_at, updated_at
      ) VALUES (
        @id, @projectId, @sceneId, @jobId, @kind, @path, @mimeType, @sizeBytes,
        @sha256, @provider, @externalId, @metadata, @createdAt, @updatedAt
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
      metadata: encodeOptionalJson(input.metadata),
      createdAt: now,
      updatedAt: now,
    });
    return this.getAsset(input.id)!;
  }

  createCharacter(input: CreateCharacterInput): CharacterRecord {
    const id = input.id ?? randomUUID();
    const now = input.now ?? new Date().toISOString();
    if (!this.getProject(input.projectId)) throw new Error(`Project not found: ${input.projectId}`);
    this.db.prepare(`
      INSERT INTO characters (id, project_id, name, description, metadata_json, created_at, updated_at)
      VALUES (@id, @projectId, @name, @description, @metadata, @createdAt, @updatedAt)
    `).run({
      id,
      projectId: input.projectId,
      name: requiredText(input.name, "Character name"),
      description: input.description ?? null,
      metadata: encodeOptionalJson(input.metadata),
      createdAt: now,
      updatedAt: now,
    });
    return this.getCharacter(id)!;
  }

  getCharacter(id: string): CharacterRecord | null {
    const row = this.db.prepare("SELECT * FROM characters WHERE id = ?").get(id) as CharacterRow | undefined;
    return row ? characterFromRow(row) : null;
  }

  listProjectCharacters(projectId: string): CharacterRecord[] {
    const rows = this.db.prepare("SELECT * FROM characters WHERE project_id = ? ORDER BY created_at, id").all(projectId) as CharacterRow[];
    return rows.map(characterFromRow);
  }

  attachCharacterToScene(input: AttachCharacterToSceneInput): SceneCharacterRecord {
    const scene = this.getScene(input.sceneId);
    if (!scene) throw new Error(`Scene not found: ${input.sceneId}`);
    const character = this.getCharacter(input.characterId);
    if (!character) throw new Error(`Character not found: ${input.characterId}`);
    if (scene.projectId !== character.projectId) {
      throw new Error(`Scene and character belong to different projects: ${scene.projectId} != ${character.projectId}`);
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO scene_characters (scene_id, character_id, role, created_at)
      VALUES (@sceneId, @characterId, @role, @createdAt)
      ON CONFLICT(scene_id, character_id) DO UPDATE SET role = excluded.role
    `).run({ sceneId: input.sceneId, characterId: input.characterId, role: input.role ?? null, createdAt: now });
    return this.getSceneCharacter(input.sceneId, input.characterId)!;
  }

  getSceneCharacter(sceneId: string, characterId: string): SceneCharacterRecord | null {
    const row = this.db.prepare(`
      SELECT scene_id, character_id, role, created_at FROM scene_characters
      WHERE scene_id = ? AND character_id = ?
    `).get(sceneId, characterId) as SceneCharacterRow | undefined;
    return row ? sceneCharacterFromRow(row) : null;
  }

  listSceneCharacters(sceneId: string): SceneCharacterRecord[] {
    const rows = this.db.prepare(`
      SELECT scene_id, character_id, role, created_at FROM scene_characters
      WHERE scene_id = ? ORDER BY created_at
    `).all(sceneId) as SceneCharacterRow[];
    return rows.map(sceneCharacterFromRow);
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  private insertQueueItem(jobId: string, priority: number, now: string, availableAt: string): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO queue_items (
        id, generation_job_id, status, priority, enqueued_at, available_at,
        claimed_at, lease_until, worker_id, claim_count, acknowledged_at, last_error
      ) VALUES (?, ?, 'QUEUED', ?, ?, ?, NULL, NULL, NULL, 0, NULL, NULL)
    `).run(id, jobId, priority, now, availableAt);
    return id;
  }

  private assertWorkerOwnsLease(jobId: string, workerId: string, now: string): void {
    const row = this.db.prepare(`
      SELECT lease_until FROM queue_items
      WHERE generation_job_id = ? AND status = 'CLAIMED' AND worker_id = ?
    `).get(jobId, workerId) as { lease_until: string | null } | undefined;
    if (!row) throw new Error(`Worker ${workerId} does not own the active lease for ${jobId}.`);
    if (!row.lease_until || row.lease_until <= now) throw new Error(`Worker lease expired for generation job ${jobId}.`);
  }

  private insertQCResult(assetVersionId: string, qc: QCInput, now: string): void {
    const checksJson = stableJson(qc.checks);
    this.db.prepare(`
      INSERT OR IGNORE INTO qc_results (id, asset_version_id, status, validator_version, checks_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(qc.id ?? randomUUID(), assetVersionId, qc.status, qc.validatorVersion, checksJson, now);
    const stored = this.getQCResult(assetVersionId, qc.validatorVersion);
    if (!stored || stored.status !== qc.status || stableJson(stored.checks) !== checksJson) {
      throw new Error(`Conflicting QC result already exists for asset version ${assetVersionId}.`);
    }
  }

  private insertPendingReview(assetVersionId: string, now: string): ReviewRecord {
    this.db.prepare(`
      INSERT OR IGNORE INTO reviews (
        id, asset_version_id, status, reason, comment, reviewer, created_at, updated_at
      ) VALUES (?, ?, 'PENDING', NULL, NULL, NULL, ?, ?)
    `).run(randomUUID(), assetVersionId, now, now);
    const review = this.getReviewByAssetVersion(assetVersionId);
    if (!review) throw new Error(`Failed to create review for asset version ${assetVersionId}.`);
    return review;
  }
}

export interface CreateProjectInput {
  id?: string;
  name: string;
  description?: string;
  status?: ProjectStatus;
  metadata?: Record<string, unknown>;
  now?: string;
}

export interface CreateSceneInput {
  id?: string;
  projectId: string;
  sceneNumber?: number;
  title?: string;
  /** Legacy aliases retained for the initial repository API. */
  sequence?: number;
  name?: string;
  description?: string;
  status?: SceneStatus;
  metadata?: Record<string, unknown>;
  now?: string;
}

export interface CreateSceneVersionInput {
  id?: string;
  sceneId: string;
  prompt: string;
  references?: string[];
  metadata?: Record<string, unknown>;
  parentVersionId?: string;
  now?: string;
}

/**
 * Attempt error classes that prove a prior submission may already have produced provider-side
 * work or a result the local system could not finalise. A job with any such attempt must not be
 * resubmitted by retry; it needs a new scene version. Exported so the application layer can
 * surface the same rule as a typed operator error without duplicating the list.
 */
export const UNSAFE_RETRY_ERROR_CLASSES: readonly string[] = Object.freeze([
  "UNCERTAIN_PROVIDER_STATE",
  "PROVIDER_RESULT_RECOVERY_EXHAUSTED",
  "PROVIDER_RESULT_INVALID",
  "PROVIDER_DOWNLOAD_EXHAUSTED",
  "ASSET_PERSISTENCE_EXHAUSTED",
  "FINALIZATION_RECOVERY_EXHAUSTED",
]);

/** Optional narrowing for the operator read models; omitted fields are not constrained. */
export interface GenerationJobFilter {
  projectId?: string;
  sceneId?: string;
  sceneVersionId?: string;
  status?: JobStatus;
  provider?: string;
}

export interface QueueItemFilter {
  status?: QueueItemStatus;
  statuses?: readonly QueueItemStatus[];
}

export interface CreateGenerationJobInput {
  id?: string;
  projectId: string;
  sceneId: string;
  sceneVersionId: string;
  provider: string;
  parameters?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  maxAttempts?: number;
  priority?: number;
  now?: string;
}

export interface CreateCharacterInput {
  id?: string;
  projectId: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  now?: string;
}

export interface AttachCharacterToSceneInput {
  sceneId: string;
  characterId: string;
  role?: string;
}

export interface ClaimedGeneration {
  job: GenerationJob;
  queueItem: QueueItemRecord;
  attempt: GenerationAttempt;
}

export interface FailAttemptInput {
  jobId: string;
  attemptId: string;
  workerId: string;
  error: string;
  errorClass: string;
  retryable: boolean;
  retryAt?: string;
  now?: string;
}

export interface DeferAttemptInput {
  jobId: string;
  attemptId: string;
  workerId: string;
  error: string;
  errorClass: string;
  retryAt?: string;
  maxRecoveries: number;
  now?: string;
}

export interface CompletedAssetInput {
  id: string;
  versionId: string;
  kind: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  outputIndex: number;
  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
}

export interface QCInput {
  id?: string;
  status: QCStatus;
  validatorVersion: string;
  checks: Record<string, QCCheckEvidence>;
}

export interface CompleteGenerationInput {
  jobId: string;
  attemptId: string;
  workerId: string;
  providerJobId: string;
  asset: CompletedAssetInput;
  qc: QCInput;
  now?: string;
}

export interface CompletedGeneration {
  job: GenerationJob;
  asset: AssetRecord;
  assetVersion: AssetVersionRecord;
  qcResult: QCResultRecord;
  review: ReviewRecord;
}

export interface DecideReviewInput {
  assetVersionId: string;
  status: Exclude<ReviewStatus, "PENDING">;
  reason?: string;
  comment?: string;
  reviewer?: string;
  now?: string;
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

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

interface SceneRow {
  id: string;
  project_id: string;
  name: string;
  sequence: number;
  title: string;
  scene_number: number;
  description: string | null;
  status: string;
  current_version_id: string | null;
  selected_asset_version_id: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

interface SceneVersionRow {
  id: string;
  scene_id: string;
  version_number: number;
  prompt: string;
  references_json: string;
  metadata_json: string | null;
  parent_version_id: string | null;
  created_at: string;
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

interface JobRow {
  id: string;
  project_id: string;
  scene_id: string;
  scene_version_id: string | null;
  provider: string;
  prompt: string;
  references_json: string;
  parameters_json: string;
  metadata_json: string | null;
  idempotency_key: string | null;
  identity_json: string | null;
  status: JobStatus;
  attempt_count: number;
  max_attempts: number;
  external_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface AttemptRow {
  id: string;
  generation_job_id: string;
  attempt_number: number;
  provider: string;
  provider_request_key: string;
  provider_job_id: string | null;
  status: GenerationAttemptStatus;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  error_class: string | null;
  recovery_count: number;
}

interface QueueRow {
  id: string;
  generation_job_id: string;
  status: QueueItemStatus;
  priority: number;
  enqueued_at: string;
  available_at: string;
  claimed_at: string | null;
  lease_until: string | null;
  worker_id: string | null;
  claim_count: number;
  acknowledged_at: string | null;
  last_error: string | null;
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
  scene_version_id: string | null;
  generation_attempt_id: string | null;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
}

interface AssetVersionRow {
  id: string;
  asset_id: string;
  version_number: number;
  scene_version_id: string;
  generation_job_id: string;
  generation_attempt_id: string;
  provider: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  checksum: string;
  output_index: number;
  width: number | null;
  height: number | null;
  metadata_json: string | null;
  created_at: string;
}

interface QCRow {
  id: string;
  asset_version_id: string;
  status: QCStatus;
  validator_version: string;
  checks_json: string;
  created_at: string;
}

interface ReviewRow {
  id: string;
  asset_version_id: string;
  status: ReviewStatus;
  reason: string | null;
  comment: string | null;
  reviewer: string | null;
  created_at: string;
  updated_at: string;
}

function projectFromRow(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    status: row.status as ProjectStatus,
    metadata: decodeOptionalJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sceneFromRow(row: SceneRow): SceneRecord {
  const title = row.title || row.name;
  const sceneNumber = row.scene_number || row.sequence;
  return {
    id: row.id,
    projectId: row.project_id,
    sceneNumber,
    title,
    name: title,
    sequence: sceneNumber,
    description: row.description ?? undefined,
    status: row.status as SceneStatus,
    currentVersionId: row.current_version_id ?? undefined,
    selectedAssetVersionId: row.selected_asset_version_id ?? undefined,
    metadata: decodeOptionalJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sceneVersionFromRow(row: SceneVersionRow): SceneVersionRecord {
  return {
    id: row.id,
    sceneId: row.scene_id,
    versionNumber: row.version_number,
    prompt: row.prompt,
    references: decodeJson<string[]>(row.references_json, []),
    metadata: decodeOptionalJson(row.metadata_json),
    parentVersionId: row.parent_version_id ?? undefined,
    createdAt: row.created_at,
  };
}

function characterFromRow(row: CharacterRow): CharacterRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description ?? undefined,
    metadata: decodeOptionalJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sceneCharacterFromRow(row: SceneCharacterRow): SceneCharacterRecord {
  return { sceneId: row.scene_id, characterId: row.character_id, role: row.role ?? undefined, createdAt: row.created_at };
}

function jobFromRow(row: JobRow): GenerationJob {
  const request: GenerationRequest = {
    projectId: row.project_id,
    sceneId: row.scene_id,
    sceneVersionId: row.scene_version_id ?? undefined,
    prompt: row.prompt,
    references: decodeJson<string[]>(row.references_json, []),
    provider: row.provider,
    parameters: decodeJson<Record<string, unknown>>(row.parameters_json, {}),
    metadata: decodeOptionalJson(row.metadata_json),
  };
  return {
    id: row.id,
    request,
    idempotencyKey: row.idempotency_key ?? `legacy:${row.id}`,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    externalId: row.external_id ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attemptFromRow(row: AttemptRow): GenerationAttempt {
  return {
    id: row.id,
    generationJobId: row.generation_job_id,
    attemptNumber: row.attempt_number,
    provider: row.provider,
    providerRequestKey: row.provider_request_key,
    providerJobId: row.provider_job_id ?? undefined,
    status: row.status,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
    errorClass: row.error_class ?? undefined,
    recoveryCount: row.recovery_count,
  };
}

function queueItemFromRow(row: QueueRow): QueueItemRecord {
  return {
    id: row.id,
    generationJobId: row.generation_job_id,
    status: row.status,
    priority: row.priority,
    enqueuedAt: row.enqueued_at,
    availableAt: row.available_at,
    claimedAt: row.claimed_at ?? undefined,
    leaseUntil: row.lease_until ?? undefined,
    workerId: row.worker_id ?? undefined,
    claimCount: row.claim_count,
    acknowledgedAt: row.acknowledged_at ?? undefined,
    lastError: row.last_error ?? undefined,
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
    metadata: decodeOptionalJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assetVersionFromRow(row: AssetVersionRow): AssetVersionRecord {
  return {
    id: row.id,
    assetId: row.asset_id,
    versionNumber: row.version_number,
    sceneVersionId: row.scene_version_id,
    generationJobId: row.generation_job_id,
    generationAttemptId: row.generation_attempt_id,
    provider: row.provider,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    checksum: row.checksum,
    outputIndex: row.output_index,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    metadata: decodeOptionalJson(row.metadata_json),
    createdAt: row.created_at,
  };
}

function qcFromRow(row: QCRow): QCResultRecord {
  return {
    id: row.id,
    assetVersionId: row.asset_version_id,
    status: row.status,
    validatorVersion: row.validator_version,
    checks: decodeJson<Record<string, QCCheckEvidence>>(row.checks_json, {}),
    createdAt: row.created_at,
  };
}

function reviewFromRow(row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    assetVersionId: row.asset_version_id,
    status: row.status,
    reason: row.reason ?? undefined,
    comment: row.comment ?? undefined,
    reviewer: row.reviewer ?? undefined,
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
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

export * from "./planning.js";
