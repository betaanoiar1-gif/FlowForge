import type Database from "better-sqlite3";

const LEGACY_SCHEMA_SQL = `
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

  CREATE INDEX IF NOT EXISTS idx_scenes_project ON scenes(project_id);
  CREATE INDEX IF NOT EXISTS idx_characters_project ON characters(project_id);
  CREATE INDEX IF NOT EXISTS idx_scene_characters_character ON scene_characters(character_id);

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

  CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);
  CREATE INDEX IF NOT EXISTS idx_assets_scene ON assets(scene_id);
  CREATE INDEX IF NOT EXISTS idx_assets_job ON assets(job_id);
  CREATE INDEX IF NOT EXISTS idx_assets_sha256 ON assets(sha256);
`;

export const CURRENT_SCHEMA_VERSION = 6;

export function migrateDatabase(db: Database.Database): void {
  let version = Number(db.pragma("user_version", { simple: true }));
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${version} is newer than this FlowForge build (${CURRENT_SCHEMA_VERSION}).`,
    );
  }

  if (version < 1) {
    db.transaction(() => {
      db.exec(LEGACY_SCHEMA_SQL);
      db.pragma("user_version = 1");
    }).immediate();
    version = 1;
  }

  if (version < 2) {
    db.transaction(() => {
      migrateToVersionTwo(db);
      db.pragma("user_version = 2");
    }).immediate();
    version = 2;
  }

  if (version < 3) {
    db.transaction(() => {
      migrateToVersionThree(db);
      db.pragma("user_version = 3");
    }).immediate();
    version = 3;
  }

  if (version < 4) {
    db.transaction(() => {
      migrateToVersionFour(db);
      db.pragma("user_version = 4");
    }).immediate();
    version = 4;
  }

  if (version < 5) {
    db.transaction(() => {
      migrateToVersionFive(db);
      db.pragma("user_version = 5");
    }).immediate();
    version = 5;
  }

  if (version < 6) {
    db.transaction(() => {
      migrateToVersionSix(db);
      db.pragma("user_version = 6");
    }).immediate();
  }
}

/**
 * v6 — AI proposal provenance (Phase 4C).
 *
 * Additive only, and deliberately the same shape as v5: nullable columns on `production_plan_versions`
 * with a complete-set rule and a write-once rule enforced in the database. A version planned without an
 * AI adapter keeps `ai_adapter IS NULL`, which is how the read models say "proposed by the operator's
 * own input" — an ordinary state, never an error.
 *
 * What is recorded is identity and digests: which adapter and model produced the proposal, which schema
 * it claimed, whether an explicit fallback to the deterministic planner was used, and fingerprints of
 * the request and of the validated proposal. What is never recorded is anything that could be replayed
 * or leaked — no prompt, no response body, no endpoint, no credential, no header. `ai_response_fingerprint`
 * is a digest of the response body for audit only, and it is NULL when there was no response.
 */
function migrateToVersionSix(db: Database.Database): void {
  addColumn(db, "production_plan_versions", "ai_adapter TEXT");
  addColumn(db, "production_plan_versions", "ai_adapter_version TEXT");
  addColumn(db, "production_plan_versions", "ai_provider TEXT");
  addColumn(db, "production_plan_versions", "ai_model TEXT");
  addColumn(db, "production_plan_versions", "ai_schema_version TEXT");
  addColumn(db, "production_plan_versions", "ai_path TEXT");
  addColumn(db, "production_plan_versions", "ai_request_fingerprint TEXT");
  addColumn(db, "production_plan_versions", "ai_proposal_fingerprint TEXT");
  addColumn(db, "production_plan_versions", "ai_response_fingerprint TEXT");
  addColumn(db, "production_plan_versions", "ai_fallback INTEGER");

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS production_plan_version_ai_provenance_is_write_once
      BEFORE UPDATE ON production_plan_versions
      WHEN OLD.ai_adapter IS NOT NULL AND (
        NEW.ai_adapter IS NOT OLD.ai_adapter
        OR NEW.ai_adapter_version IS NOT OLD.ai_adapter_version
        OR NEW.ai_provider IS NOT OLD.ai_provider
        OR NEW.ai_model IS NOT OLD.ai_model
        OR NEW.ai_schema_version IS NOT OLD.ai_schema_version
        OR NEW.ai_path IS NOT OLD.ai_path
        OR NEW.ai_request_fingerprint IS NOT OLD.ai_request_fingerprint
        OR NEW.ai_proposal_fingerprint IS NOT OLD.ai_proposal_fingerprint
        OR NEW.ai_fallback IS NOT OLD.ai_fallback
      )
      BEGIN
        SELECT RAISE(ABORT, 'ai proposal provenance is recorded once and never rewritten');
      END;

    /*
     * Half an AI provenance tuple is worse than none: "proposed by model X" without the schema version or
     * the proposal digest cannot be re-derived later, and "fallback used" without an adapter would let a
     * run look auditable when it is not. So the same complete-set rule as planner provenance, on INSERT
     * and on UPDATE, with ai_response_fingerprint free to be NULL because a failed or fallback attempt
     * legitimately has no response to digest.
     */
    CREATE TRIGGER IF NOT EXISTS production_plan_version_ai_provenance_must_be_complete
      BEFORE INSERT ON production_plan_versions
      WHEN (NEW.ai_adapter IS NULL) <> (NEW.ai_adapter_version IS NULL)
        OR (NEW.ai_adapter IS NULL) <> (NEW.ai_provider IS NULL)
        OR (NEW.ai_adapter IS NULL) <> (NEW.ai_model IS NULL)
        OR (NEW.ai_adapter IS NULL) <> (NEW.ai_schema_version IS NULL)
        OR (NEW.ai_adapter IS NULL) <> (NEW.ai_path IS NULL)
        OR (NEW.ai_adapter IS NULL) <> (NEW.ai_request_fingerprint IS NULL)
        OR (NEW.ai_adapter IS NULL) <> (NEW.ai_proposal_fingerprint IS NULL)
        OR (NEW.ai_adapter IS NULL) <> (NEW.ai_fallback IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'ai proposal provenance must be recorded as a complete set');
      END;

    CREATE TRIGGER IF NOT EXISTS production_plan_version_ai_provenance_must_be_complete_on_update
      BEFORE UPDATE ON production_plan_versions
      WHEN (NEW.ai_adapter IS NULL) <> (NEW.ai_adapter_version IS NULL)
        OR (NEW.ai_adapter IS NULL) <> (NEW.ai_provider IS NULL)
        OR (NEW.ai_adapter IS NULL) <> (NEW.ai_model IS NULL)
        OR (NEW.ai_adapter IS NULL) <> (NEW.ai_schema_version IS NULL)
        OR (NEW.ai_adapter IS NULL) <> (NEW.ai_path IS NULL)
        OR (NEW.ai_adapter IS NULL) <> (NEW.ai_request_fingerprint IS NULL)
        OR (NEW.ai_adapter IS NULL) <> (NEW.ai_proposal_fingerprint IS NULL)
        OR (NEW.ai_adapter IS NULL) <> (NEW.ai_fallback IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'ai proposal provenance must be recorded as a complete set');
      END;
  `);
}

/**
 * v5 — deterministic planner provenance (Phase 4B).
 *
 * Additive only: seven nullable columns on `production_plan_versions`, plus two triggers. Versions
 * authored before Phase 4B keep `planner_version IS NULL`, which is how an operator (and the read
 * models) tell a planned version from a hand-authored one. Nothing is recreated or rewritten.
 *
 * Provenance is written once and never amended: a plan must remain attributable to the exact engine,
 * rule set, seed, and input that produced it, so a future planner version cannot silently
 * reinterpret an old plan. `planner_content_hash` records the version's content hash as the planner
 * left it, which is what lets a later run distinguish "same plan, unchanged" from "someone edited
 * it afterwards".
 */
function migrateToVersionFive(db: Database.Database): void {
  addColumn(db, "production_plan_versions", "planner_version TEXT");
  addColumn(db, "production_plan_versions", "planner_rules_version TEXT");
  addColumn(db, "production_plan_versions", "planner_seed INTEGER");
  addColumn(db, "production_plan_versions", "planner_input_fingerprint TEXT");
  addColumn(db, "production_plan_versions", "planner_output_fingerprint TEXT");
  addColumn(db, "production_plan_versions", "planner_content_hash TEXT");
  addColumn(db, "production_plan_versions", "planner_trace_json TEXT");

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS production_plan_version_provenance_is_write_once
      BEFORE UPDATE ON production_plan_versions
      WHEN OLD.planner_version IS NOT NULL AND (
        NEW.planner_version IS NOT OLD.planner_version
        OR NEW.planner_rules_version IS NOT OLD.planner_rules_version
        OR NEW.planner_seed IS NOT OLD.planner_seed
        OR NEW.planner_input_fingerprint IS NOT OLD.planner_input_fingerprint
        OR NEW.planner_output_fingerprint IS NOT OLD.planner_output_fingerprint
        OR NEW.planner_content_hash IS NOT OLD.planner_content_hash
      )
      BEGIN
        SELECT RAISE(ABORT, 'planner provenance is recorded once and never rewritten');
      END;

    /*
     * Provenance is meaningful only as a complete identity tuple, never as a fragment. The same rule is
     * enforced on INSERT and on UPDATE: without the update variant, a caller that bypassed the repository
     * could attach half a tuple to a version that had none, and "planned by v1 with seed 4" would be
     * recoverable only from whichever columns happened to be set.
     */
    CREATE TRIGGER IF NOT EXISTS production_plan_version_provenance_must_be_complete
      BEFORE INSERT ON production_plan_versions
      WHEN (NEW.planner_version IS NULL) <> (NEW.planner_rules_version IS NULL)
        OR (NEW.planner_version IS NULL) <> (NEW.planner_seed IS NULL)
        OR (NEW.planner_version IS NULL) <> (NEW.planner_input_fingerprint IS NULL)
        OR (NEW.planner_version IS NULL) <> (NEW.planner_output_fingerprint IS NULL)
        OR (NEW.planner_version IS NULL) <> (NEW.planner_content_hash IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'planner provenance must be recorded as a complete set');
      END;

    CREATE TRIGGER IF NOT EXISTS production_plan_version_provenance_must_be_complete_on_update
      BEFORE UPDATE ON production_plan_versions
      WHEN (NEW.planner_version IS NULL) <> (NEW.planner_rules_version IS NULL)
        OR (NEW.planner_version IS NULL) <> (NEW.planner_seed IS NULL)
        OR (NEW.planner_version IS NULL) <> (NEW.planner_input_fingerprint IS NULL)
        OR (NEW.planner_version IS NULL) <> (NEW.planner_output_fingerprint IS NULL)
        OR (NEW.planner_version IS NULL) <> (NEW.planner_content_hash IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'planner provenance must be recorded as a complete set');
      END;
  `);
}

function migrateToVersionTwo(db: Database.Database): void {
  addColumn(db, "projects", "status TEXT NOT NULL DEFAULT 'ACTIVE'");
  addColumn(db, "scenes", "title TEXT NOT NULL DEFAULT ''");
  addColumn(db, "scenes", "scene_number INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "scenes", "status TEXT NOT NULL DEFAULT 'DRAFT'");

  db.exec(`
    UPDATE scenes SET title = name WHERE title = '';
    UPDATE scenes SET scene_number = sequence WHERE scene_number = 1 AND sequence <> 1;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_scenes_project_scene_number
      ON scenes(project_id, scene_number);

    CREATE TABLE IF NOT EXISTS scene_versions (
      id TEXT PRIMARY KEY,
      scene_id TEXT NOT NULL,
      version_number INTEGER NOT NULL CHECK (version_number > 0),
      prompt TEXT NOT NULL,
      references_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT,
      parent_version_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (scene_id, version_number),
      FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_version_id) REFERENCES scene_versions(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_scene_versions_scene
      ON scene_versions(scene_id, version_number);

    CREATE TABLE IF NOT EXISTS generation_attempts (
      id TEXT PRIMARY KEY,
      generation_job_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      provider TEXT NOT NULL,
      provider_request_key TEXT NOT NULL,
      provider_job_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('CLAIMED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      error_class TEXT,
      recovery_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_count >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (generation_job_id, attempt_number),
      UNIQUE (provider, provider_request_key),
      FOREIGN KEY (generation_job_id) REFERENCES generation_jobs(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_attempt_open_job
      ON generation_attempts(generation_job_id)
      WHERE status IN ('CLAIMED', 'RUNNING');

    CREATE INDEX IF NOT EXISTS idx_generation_attempt_job
      ON generation_attempts(generation_job_id, attempt_number);

    CREATE TABLE IF NOT EXISTS queue_items (
      id TEXT PRIMARY KEY,
      generation_job_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('QUEUED', 'CLAIMED', 'ACKED', 'FAILED', 'CANCELLED')),
      priority INTEGER NOT NULL DEFAULT 0,
      enqueued_at TEXT NOT NULL,
      available_at TEXT NOT NULL,
      claimed_at TEXT,
      lease_until TEXT,
      worker_id TEXT,
      claim_count INTEGER NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
      acknowledged_at TEXT,
      last_error TEXT,
      FOREIGN KEY (generation_job_id) REFERENCES generation_jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_queue_items_ready
      ON queue_items(status, available_at, priority DESC, enqueued_at);

    CREATE TABLE IF NOT EXISTS asset_versions (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      version_number INTEGER NOT NULL CHECK (version_number > 0),
      scene_version_id TEXT NOT NULL,
      generation_job_id TEXT NOT NULL,
      generation_attempt_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      checksum TEXT NOT NULL,
      output_index INTEGER NOT NULL DEFAULT 0 CHECK (output_index >= 0),
      width INTEGER,
      height INTEGER,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (asset_id, version_number),
      UNIQUE (generation_attempt_id, output_index),
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
      FOREIGN KEY (scene_version_id) REFERENCES scene_versions(id) ON DELETE RESTRICT,
      FOREIGN KEY (generation_job_id) REFERENCES generation_jobs(id) ON DELETE RESTRICT,
      FOREIGN KEY (generation_attempt_id) REFERENCES generation_attempts(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_asset_versions_scene_version
      ON asset_versions(scene_version_id);
    CREATE INDEX IF NOT EXISTS idx_asset_versions_generation_job
      ON asset_versions(generation_job_id);
  `);

  addColumn(db, "scenes", "current_version_id TEXT REFERENCES scene_versions(id) ON DELETE SET NULL");
  addColumn(db, "scenes", "selected_asset_version_id TEXT REFERENCES asset_versions(id) ON DELETE SET NULL");

  addColumn(db, "generation_jobs", "scene_version_id TEXT REFERENCES scene_versions(id) ON DELETE RESTRICT");
  addColumn(db, "generation_jobs", "idempotency_key TEXT");
  addColumn(db, "generation_jobs", "identity_json TEXT");
  addColumn(db, "generation_jobs", "parameters_json TEXT NOT NULL DEFAULT '{}'");
  addColumn(db, "generation_jobs", "attempt_count INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "generation_jobs", "max_attempts INTEGER NOT NULL DEFAULT 3");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_jobs_idempotency
      ON generation_jobs(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_generation_jobs_scene_version
      ON generation_jobs(scene_version_id);
  `);

  addColumn(db, "assets", "scene_version_id TEXT REFERENCES scene_versions(id) ON DELETE RESTRICT");
  addColumn(db, "assets", "generation_attempt_id TEXT REFERENCES generation_attempts(id) ON DELETE RESTRICT");
  addColumn(db, "assets", "current_version_id TEXT REFERENCES asset_versions(id) ON DELETE SET NULL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS qc_results (
      id TEXT PRIMARY KEY,
      asset_version_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PASSED', 'FAILED', 'NOT_EVALUATED')),
      validator_version TEXT NOT NULL,
      checks_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (asset_version_id, validator_version),
      FOREIGN KEY (asset_version_id) REFERENCES asset_versions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_qc_results_asset_version
      ON qc_results(asset_version_id, created_at);

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      asset_version_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
      reason TEXT,
      comment TEXT,
      reviewer TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (asset_version_id) REFERENCES asset_versions(id) ON DELETE CASCADE
    );

    CREATE TRIGGER IF NOT EXISTS scene_versions_are_immutable
      BEFORE UPDATE ON scene_versions
      BEGIN
        SELECT RAISE(ABORT, 'scene versions are immutable');
      END;

    CREATE TRIGGER IF NOT EXISTS scene_versions_cannot_be_deleted
      BEFORE DELETE ON scene_versions
      BEGIN
        SELECT RAISE(ABORT, 'scene versions are immutable');
      END;

    CREATE TRIGGER IF NOT EXISTS asset_versions_are_immutable
      BEFORE UPDATE ON asset_versions
      BEGIN
        SELECT RAISE(ABORT, 'asset versions are immutable');
      END;

    CREATE TRIGGER IF NOT EXISTS asset_versions_cannot_be_deleted
      BEFORE DELETE ON asset_versions
      BEGIN
        SELECT RAISE(ABORT, 'asset versions are immutable');
      END;

    CREATE TRIGGER IF NOT EXISTS qc_results_are_immutable
      BEFORE UPDATE ON qc_results
      BEGIN
        SELECT RAISE(ABORT, 'QC results are immutable');
      END;

    CREATE TRIGGER IF NOT EXISTS qc_results_cannot_be_deleted
      BEFORE DELETE ON qc_results
      BEGIN
        SELECT RAISE(ABORT, 'QC results are immutable');
      END;

    CREATE TRIGGER IF NOT EXISTS review_decision_is_terminal
      BEFORE UPDATE ON reviews
      WHEN OLD.status <> 'PENDING'
        OR NEW.status NOT IN ('APPROVED', 'REJECTED')
        OR NEW.id <> OLD.id
        OR NEW.asset_version_id <> OLD.asset_version_id
        OR NEW.created_at <> OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'review decision is terminal and immutable');
      END;

    CREATE TRIGGER IF NOT EXISTS asset_version_provenance_must_match
      BEFORE INSERT ON asset_versions
      WHEN NOT EXISTS (
        SELECT 1
        FROM assets asset
        JOIN generation_jobs job ON job.id = NEW.generation_job_id
        JOIN generation_attempts attempt ON attempt.id = NEW.generation_attempt_id
        JOIN scene_versions scene_version ON scene_version.id = NEW.scene_version_id
        WHERE asset.id = NEW.asset_id
          AND asset.project_id = job.project_id
          AND asset.scene_id = job.scene_id
          AND asset.job_id = job.id
          AND asset.scene_version_id = scene_version.id
          AND job.scene_version_id = scene_version.id
          AND scene_version.scene_id = job.scene_id
          AND attempt.generation_job_id = job.id
          AND attempt.provider = job.provider
          AND NEW.provider = job.provider
      )
      BEGIN
        SELECT RAISE(ABORT, 'asset version provenance does not match its generation');
      END;

    CREATE TRIGGER IF NOT EXISTS scene_version_parent_must_match_scene
      BEFORE INSERT ON scene_versions
      WHEN NEW.parent_version_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM scene_versions parent
        WHERE parent.id = NEW.parent_version_id AND parent.scene_id = NEW.scene_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'parent scene version must belong to the same scene');
      END;

    CREATE TRIGGER IF NOT EXISTS generation_job_project_scene_must_match_insert
      BEFORE INSERT ON generation_jobs
      WHEN NOT EXISTS (
        SELECT 1 FROM scenes scene
        WHERE scene.id = NEW.scene_id AND scene.project_id = NEW.project_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'generation job scene must belong to the requested project');
      END;

    CREATE TRIGGER IF NOT EXISTS generation_job_project_scene_must_match_update
      BEFORE UPDATE OF project_id, scene_id ON generation_jobs
      WHEN NOT EXISTS (
        SELECT 1 FROM scenes scene
        WHERE scene.id = NEW.scene_id AND scene.project_id = NEW.project_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'generation job scene must belong to the requested project');
      END;

    CREATE TRIGGER IF NOT EXISTS asset_project_scene_job_must_match_insert
      BEFORE INSERT ON assets
      WHEN NOT (
        EXISTS (SELECT 1 FROM projects project WHERE project.id = NEW.project_id)
        AND (NEW.scene_id IS NULL OR EXISTS (
          SELECT 1 FROM scenes scene WHERE scene.id = NEW.scene_id AND scene.project_id = NEW.project_id
        ))
        AND (NEW.job_id IS NULL OR EXISTS (
          SELECT 1 FROM generation_jobs job
          WHERE job.id = NEW.job_id AND job.project_id = NEW.project_id
            AND (NEW.scene_id IS NULL OR job.scene_id = NEW.scene_id)
        ))
      )
      BEGIN
        SELECT RAISE(ABORT, 'asset project, scene, and job provenance must match');
      END;

    CREATE TRIGGER IF NOT EXISTS asset_project_scene_job_must_match_update
      BEFORE UPDATE OF project_id, scene_id, job_id ON assets
      WHEN NOT (
        EXISTS (SELECT 1 FROM projects project WHERE project.id = NEW.project_id)
        AND (NEW.scene_id IS NULL OR EXISTS (
          SELECT 1 FROM scenes scene WHERE scene.id = NEW.scene_id AND scene.project_id = NEW.project_id
        ))
        AND (NEW.job_id IS NULL OR EXISTS (
          SELECT 1 FROM generation_jobs job
          WHERE job.id = NEW.job_id AND job.project_id = NEW.project_id
            AND (NEW.scene_id IS NULL OR job.scene_id = NEW.scene_id)
        ))
      )
      BEGIN
        SELECT RAISE(ABORT, 'asset project, scene, and job provenance must match');
      END;

    CREATE TRIGGER IF NOT EXISTS scene_current_version_must_match_scene
      BEFORE UPDATE OF current_version_id ON scenes
      WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM scene_versions version
        WHERE version.id = NEW.current_version_id AND version.scene_id = NEW.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'current scene version must belong to the scene');
      END;

    CREATE TRIGGER IF NOT EXISTS scene_selected_asset_must_match_scene
      BEFORE UPDATE OF selected_asset_version_id ON scenes
      WHEN NEW.selected_asset_version_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM asset_versions asset_version
        JOIN scene_versions scene_version ON scene_version.id = asset_version.scene_version_id
        WHERE asset_version.id = NEW.selected_asset_version_id
          AND scene_version.scene_id = NEW.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'selected asset version must belong to the scene');
      END;

  `);

  migrateLegacyJobs(db);
}

function migrateToVersionThree(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS asset_current_version_must_match_asset
      BEFORE UPDATE OF current_version_id ON assets
      WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM asset_versions version
        WHERE version.id = NEW.current_version_id AND version.asset_id = NEW.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'current asset version must belong to the asset');
      END;

    CREATE TRIGGER IF NOT EXISTS selected_asset_requires_approval_and_qc
      BEFORE UPDATE OF selected_asset_version_id ON scenes
      WHEN NEW.selected_asset_version_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM reviews review
        JOIN qc_results qc ON qc.asset_version_id = review.asset_version_id
        WHERE review.asset_version_id = NEW.selected_asset_version_id
          AND review.status = 'APPROVED'
          AND qc.status = 'PASSED'
          AND qc.validator_version = 'deterministic-v1'
      )
      BEGIN
        SELECT RAISE(ABORT, 'selected asset version requires approval and passing QC');
      END;
  `);
}

function migrateLegacyJobs(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT id, project_id, scene_id, provider, prompt, references_json, metadata_json,
           status, error, created_at, updated_at, scene_version_id
    FROM generation_jobs
    WHERE scene_version_id IS NULL
  `).all() as Array<{
    id: string;
    project_id: string;
    scene_id: string;
    provider: string;
    prompt: string;
    references_json: string;
    metadata_json: string | null;
    status: string;
    error: string | null;
    created_at: string;
    updated_at: string;
    scene_version_id: string | null;
  }>;

  const getScene = db.prepare("SELECT id, current_version_id FROM scenes WHERE id = ? AND project_id = ?");
  const nextNumber = db.prepare("SELECT COALESCE(MAX(version_number), 0) + 1 AS next_number FROM scene_versions WHERE scene_id = ?");
  const insertVersion = db.prepare(`
    INSERT INTO scene_versions
      (id, scene_id, version_number, prompt, references_json, metadata_json, parent_version_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const setSceneVersion = db.prepare(`
    UPDATE scenes SET current_version_id = COALESCE(current_version_id, ?)
    WHERE id = ?
  `);
  const updateJob = db.prepare(`
    UPDATE generation_jobs
    SET scene_version_id = ?, idempotency_key = ?, identity_json = ?, parameters_json = '{}',
        status = ?, error = ?, updated_at = ?
    WHERE id = ?
  `);

  for (const row of rows) {
    const scene = getScene.get(row.scene_id, row.project_id) as
      | { id: string; current_version_id: string | null }
      | undefined;
    let sceneVersionId: string | null = null;

    if (scene) {
      const versionNumber = (nextNumber.get(row.scene_id) as { next_number: number }).next_number;
      sceneVersionId = `legacy-scene-version-${row.id}`;
      insertVersion.run(
        sceneVersionId,
        row.scene_id,
        versionNumber,
        row.prompt,
        row.references_json || "[]",
        row.metadata_json,
        scene.current_version_id,
        row.created_at,
      );
      setSceneVersion.run(sceneVersionId, row.scene_id);
    }

    const legacyStatus = row.status.toUpperCase();
    const mappedStatus = legacyStatus === "COMPLETED" || legacyStatus === "SUCCEEDED"
      ? "SUCCEEDED"
      : legacyStatus === "CANCELLED"
        ? "CANCELLED"
        : "FAILED";
    const error = row.error ?? (mappedStatus === "FAILED"
      ? "Legacy pre-Phase-1 generation was not automatically replayed; create a new versioned job after review."
      : null);
    const identity = JSON.stringify({ legacyJobId: row.id });

    updateJob.run(
      sceneVersionId,
      `legacy:${row.id}`,
      identity,
      mappedStatus,
      error,
      row.updated_at,
      row.id,
    );
  }
}

/**
 * Children of a plan version that may only change while the version is being authored (`DRAFT`) or
 * after a passing validation that has not been approved yet (`VALIDATED`). `statusSql` resolves the
 * owning version's status for a row of `table`, either directly or through its scene plan.
 */
const PLAN_CHILD_GUARDS: ReadonlyArray<{
  table: string;
  parentColumn: string;
  statusSql: (alias: string) => string;
}> = [
  {
    table: "plan_stories",
    parentColumn: "plan_version_id",
    statusSql: (alias) => `(SELECT status FROM production_plan_versions WHERE id = ${alias}.plan_version_id)`,
  },
  {
    table: "plan_version_characters",
    parentColumn: "plan_version_id",
    statusSql: (alias) => `(SELECT status FROM production_plan_versions WHERE id = ${alias}.plan_version_id)`,
  },
  {
    table: "scene_plans",
    parentColumn: "plan_version_id",
    statusSql: (alias) => `(SELECT status FROM production_plan_versions WHERE id = ${alias}.plan_version_id)`,
  },
  {
    table: "scene_plan_characters",
    parentColumn: "scene_plan_id",
    statusSql: (alias) =>
      `(SELECT v.status FROM scene_plans sp JOIN production_plan_versions v ON v.id = sp.plan_version_id
         WHERE sp.id = ${alias}.scene_plan_id)`,
  },
  {
    table: "generation_specs",
    parentColumn: "scene_plan_id",
    statusSql: (alias) =>
      `(SELECT v.status FROM scene_plans sp JOIN production_plan_versions v ON v.id = sp.plan_version_id
         WHERE sp.id = ${alias}.scene_plan_id)`,
  },
];

/**
 * Version 4 - the creative planning domain (Phase 4A).
 *
 * Strictly additive: no Phase 0-3 table is altered beyond two new optional `characters` columns, no
 * row is rewritten or deleted, and nothing is dropped or recreated. Planning state lives in normalized
 * relational tables (not opaque JSON blobs) so version semantics, reference integrity, and per-entity
 * idempotency are enforced by SQLite.
 */
function migrateToVersionFour(db: Database.Database): void {
  addColumn(db, "characters", "traits_json TEXT");
  addColumn(db, "characters", "visual_identity_json TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS creative_briefs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      supersedes_brief_id TEXT REFERENCES creative_briefs(id) ON DELETE RESTRICT,
      title TEXT NOT NULL,
      concept TEXT NOT NULL DEFAULT '',
      objective TEXT NOT NULL DEFAULT '',
      audience TEXT NOT NULL DEFAULT '',
      tone TEXT NOT NULL DEFAULT '',
      style TEXT NOT NULL DEFAULT '',
      constraints_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
      content_hash TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (project_id, version_number),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS worlds (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      environment TEXT NOT NULL DEFAULT '',
      rules_json TEXT NOT NULL DEFAULT '[]',
      visual_identity_json TEXT NOT NULL DEFAULT '{}',
      version_number INTEGER NOT NULL,
      supersedes_world_id TEXT REFERENCES worlds(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
      content_hash TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (project_id, name, version_number),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS visual_dna (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      style TEXT NOT NULL DEFAULT '',
      palette_json TEXT NOT NULL DEFAULT '[]',
      lighting TEXT NOT NULL DEFAULT '',
      composition TEXT NOT NULL DEFAULT '',
      camera_language TEXT NOT NULL DEFAULT '',
      rendering_style TEXT NOT NULL DEFAULT '',
      atmosphere TEXT NOT NULL DEFAULT '',
      consistency_rules_json TEXT NOT NULL DEFAULT '[]',
      version_number INTEGER NOT NULL,
      supersedes_dna_id TEXT REFERENCES visual_dna(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
      content_hash TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (project_id, name, version_number),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    /* production_plans.current_version_id deliberately has no foreign key: production_plan_versions
       references this table, so the reverse edge would be a forward reference at create time. The
       membership trigger below enforces the same invariant. */
    CREATE TABLE IF NOT EXISTS production_plans (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL REFERENCES creative_briefs(id) ON DELETE RESTRICT,
      title TEXT NOT NULL,
      current_version_id TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS production_plan_versions (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES production_plans(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'VALIDATED', 'APPROVED', 'EXECUTABLE', 'ARCHIVED')),
      content_hash TEXT NOT NULL,
      visual_dna_id TEXT REFERENCES visual_dna(id) ON DELETE RESTRICT,
      predecessor_version_id TEXT REFERENCES production_plan_versions(id) ON DELETE RESTRICT,
      revision_note TEXT NOT NULL DEFAULT '',
      approved_by TEXT,
      approved_at TEXT,
      approved_validation_id TEXT,
      executable_at TEXT,
      executable_providers_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (plan_id, version_number)
    );

    CREATE TABLE IF NOT EXISTS plan_stories (
      id TEXT PRIMARY KEY,
      plan_version_id TEXT NOT NULL REFERENCES production_plan_versions(id) ON DELETE CASCADE,
      premise TEXT NOT NULL DEFAULT '',
      structure TEXT NOT NULL DEFAULT '',
      themes_json TEXT NOT NULL DEFAULT '[]',
      beginning TEXT NOT NULL DEFAULT '',
      development TEXT NOT NULL DEFAULT '',
      ending TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (plan_version_id)
    );

    CREATE TABLE IF NOT EXISTS plan_version_characters (
      plan_version_id TEXT NOT NULL REFERENCES production_plan_versions(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
      role TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (plan_version_id, character_id)
    );

    CREATE TABLE IF NOT EXISTS scene_plans (
      id TEXT PRIMARY KEY,
      plan_version_id TEXT NOT NULL REFERENCES production_plan_versions(id) ON DELETE CASCADE,
      scene_key TEXT NOT NULL,
      scene_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      narrative_purpose TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      duration_target_ms INTEGER,
      world_id TEXT REFERENCES worlds(id) ON DELETE RESTRICT,
      visual_dna_id TEXT REFERENCES visual_dna(id) ON DELETE RESTRICT,
      continuity_json TEXT NOT NULL DEFAULT '[]',
      references_json TEXT NOT NULL DEFAULT '[]',
      planned_outputs_json TEXT NOT NULL DEFAULT '[]',
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (plan_version_id, scene_number),
      UNIQUE (plan_version_id, scene_key)
    );

    CREATE TABLE IF NOT EXISTS scene_plan_characters (
      scene_plan_id TEXT NOT NULL REFERENCES scene_plans(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
      role TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (scene_plan_id, character_id),
      UNIQUE (scene_plan_id, position)
    );

    CREATE TABLE IF NOT EXISTS generation_specs (
      id TEXT PRIMARY KEY,
      scene_plan_id TEXT NOT NULL REFERENCES scene_plans(id) ON DELETE CASCADE,
      spec_number INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'text')),
      instructions TEXT NOT NULL DEFAULT '',
      output_count INTEGER NOT NULL DEFAULT 1,
      aspect_ratio TEXT,
      duration_ms INTEGER,
      references_json TEXT NOT NULL DEFAULT '[]',
      constraints_json TEXT NOT NULL DEFAULT '[]',
      required_capabilities_json TEXT NOT NULL DEFAULT '[]',
      requirement_notes TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (scene_plan_id, spec_number)
    );

    CREATE TABLE IF NOT EXISTS plan_validations (
      id TEXT PRIMARY KEY,
      plan_version_id TEXT NOT NULL REFERENCES production_plan_versions(id) ON DELETE CASCADE,
      validator_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PASSED', 'FAILED')),
      content_hash TEXT NOT NULL,
      findings_json TEXT NOT NULL DEFAULT '[]',
      error_count INTEGER NOT NULL DEFAULT 0,
      warning_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (plan_version_id, validator_version, content_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_creative_briefs_project
      ON creative_briefs(project_id, status, version_number);
    CREATE INDEX IF NOT EXISTS idx_worlds_project ON worlds(project_id, status, name);
    CREATE INDEX IF NOT EXISTS idx_visual_dna_project ON visual_dna(project_id, status, name);
    CREATE INDEX IF NOT EXISTS idx_production_plans_project
      ON production_plans(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_production_plan_versions_plan
      ON production_plan_versions(plan_id, version_number);
    CREATE INDEX IF NOT EXISTS idx_plan_stories_version ON plan_stories(plan_version_id);
    CREATE INDEX IF NOT EXISTS idx_plan_version_characters_character
      ON plan_version_characters(character_id);
    CREATE INDEX IF NOT EXISTS idx_scene_plans_version
      ON scene_plans(plan_version_id, scene_number);
    CREATE INDEX IF NOT EXISTS idx_scene_plan_characters_character
      ON scene_plan_characters(character_id);
    CREATE INDEX IF NOT EXISTS idx_generation_specs_scene_plan
      ON generation_specs(scene_plan_id, spec_number);
    CREATE INDEX IF NOT EXISTS idx_plan_validations_version
      ON plan_validations(plan_version_id, created_at);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_creative_briefs_idempotency
      ON creative_briefs(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worlds_idempotency
      ON worlds(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_visual_dna_idempotency
      ON visual_dna(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_production_plans_idempotency
      ON production_plans(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scene_plans_idempotency
      ON scene_plans(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_specs_idempotency
      ON generation_specs(idempotency_key) WHERE idempotency_key IS NOT NULL;
  `);

  db.exec(`
    -- Brief, world, and visual DNA snapshots are immutable records. Only the ACTIVE -> SUPERSEDED
    -- pointer moves, and never backwards.
    CREATE TRIGGER IF NOT EXISTS creative_briefs_content_is_immutable
      BEFORE UPDATE ON creative_briefs
      WHEN OLD.id <> NEW.id
        OR OLD.project_id <> NEW.project_id
        OR OLD.version_number <> NEW.version_number
        OR OLD.supersedes_brief_id IS NOT NEW.supersedes_brief_id
        OR OLD.title <> NEW.title
        OR OLD.concept <> NEW.concept
        OR OLD.objective <> NEW.objective
        OR OLD.audience <> NEW.audience
        OR OLD.tone <> NEW.tone
        OR OLD.style <> NEW.style
        OR OLD.constraints_json <> NEW.constraints_json
        OR OLD.content_hash <> NEW.content_hash
        OR OLD.created_at <> NEW.created_at
        OR OLD.idempotency_key IS NOT NEW.idempotency_key
        OR OLD.status = 'SUPERSEDED'
      BEGIN
        SELECT RAISE(ABORT, 'creative brief snapshots are immutable');
      END;

    CREATE TRIGGER IF NOT EXISTS worlds_content_is_immutable
      BEFORE UPDATE ON worlds
      WHEN OLD.id <> NEW.id
        OR OLD.project_id <> NEW.project_id
        OR OLD.name <> NEW.name
        OR OLD.version_number <> NEW.version_number
        OR OLD.supersedes_world_id IS NOT NEW.supersedes_world_id
        OR OLD.description <> NEW.description
        OR OLD.environment <> NEW.environment
        OR OLD.rules_json <> NEW.rules_json
        OR OLD.visual_identity_json <> NEW.visual_identity_json
        OR OLD.content_hash <> NEW.content_hash
        OR OLD.created_at <> NEW.created_at
        OR OLD.idempotency_key IS NOT NEW.idempotency_key
        OR OLD.status = 'SUPERSEDED'
      BEGIN
        SELECT RAISE(ABORT, 'world definitions are immutable');
      END;

    CREATE TRIGGER IF NOT EXISTS visual_dna_content_is_immutable
      BEFORE UPDATE ON visual_dna
      WHEN OLD.id <> NEW.id
        OR OLD.project_id <> NEW.project_id
        OR OLD.name <> NEW.name
        OR OLD.version_number <> NEW.version_number
        OR OLD.supersedes_dna_id IS NOT NEW.supersedes_dna_id
        OR OLD.description <> NEW.description
        OR OLD.style <> NEW.style
        OR OLD.palette_json <> NEW.palette_json
        OR OLD.lighting <> NEW.lighting
        OR OLD.composition <> NEW.composition
        OR OLD.camera_language <> NEW.camera_language
        OR OLD.rendering_style <> NEW.rendering_style
        OR OLD.atmosphere <> NEW.atmosphere
        OR OLD.consistency_rules_json <> NEW.consistency_rules_json
        OR OLD.content_hash <> NEW.content_hash
        OR OLD.created_at <> NEW.created_at
        OR OLD.idempotency_key IS NOT NEW.idempotency_key
        OR OLD.status = 'SUPERSEDED'
      BEGIN
        SELECT RAISE(ABORT, 'visual DNA definitions are immutable');
      END;

    CREATE TRIGGER IF NOT EXISTS creative_briefs_cannot_be_deleted
      BEFORE DELETE ON creative_briefs
      BEGIN
        SELECT RAISE(ABORT, 'creative brief snapshots cannot be deleted');
      END;

    CREATE TRIGGER IF NOT EXISTS worlds_cannot_be_deleted
      BEFORE DELETE ON worlds
      BEGIN
        SELECT RAISE(ABORT, 'world definitions cannot be deleted');
      END;

    CREATE TRIGGER IF NOT EXISTS visual_dna_cannot_be_deleted
      BEFORE DELETE ON visual_dna
      BEGIN
        SELECT RAISE(ABORT, 'visual DNA definitions cannot be deleted');
      END;

    -- A plan belongs to the same project as its pinned brief, and its current pointer must be one of
    -- its own versions.
    CREATE TRIGGER IF NOT EXISTS production_plan_brief_must_match_project
      BEFORE INSERT ON production_plans
      WHEN (SELECT project_id FROM creative_briefs WHERE id = NEW.brief_id) IS NOT NEW.project_id
      BEGIN
        SELECT RAISE(ABORT, 'production plan brief must belong to the same project');
      END;

    CREATE TRIGGER IF NOT EXISTS production_plan_brief_must_match_project_update
      BEFORE UPDATE ON production_plans
      WHEN (SELECT project_id FROM creative_briefs WHERE id = NEW.brief_id) IS NOT NEW.project_id
      BEGIN
        SELECT RAISE(ABORT, 'production plan brief must belong to the same project');
      END;

    CREATE TRIGGER IF NOT EXISTS production_plan_current_version_must_match_plan
      BEFORE UPDATE ON production_plans
      WHEN NEW.current_version_id IS NOT NULL AND (
        SELECT plan_id FROM production_plan_versions WHERE id = NEW.current_version_id
      ) IS NOT NEW.id
      BEGIN
        SELECT RAISE(ABORT, 'production plan current version must belong to the plan');
      END;

    CREATE TRIGGER IF NOT EXISTS production_plan_current_version_must_match_plan_insert
      BEFORE INSERT ON production_plans
      WHEN NEW.current_version_id IS NOT NULL AND (
        SELECT plan_id FROM production_plan_versions WHERE id = NEW.current_version_id
      ) IS NOT NEW.id
      BEGIN
        SELECT RAISE(ABORT, 'production plan current version must belong to the plan');
      END;

    -- Version lineage: a predecessor must be an earlier version of the same plan.
    CREATE TRIGGER IF NOT EXISTS production_plan_version_lineage_must_match_plan
      BEFORE INSERT ON production_plan_versions
      WHEN NEW.predecessor_version_id IS NOT NULL AND (
        (SELECT plan_id FROM production_plan_versions WHERE id = NEW.predecessor_version_id)
          IS NOT NEW.plan_id
        OR (SELECT version_number FROM production_plan_versions
              WHERE id = NEW.predecessor_version_id) >= NEW.version_number
      )
      BEGIN
        SELECT RAISE(ABORT, 'plan version predecessor must be an earlier version of the same plan');
      END;

    CREATE TRIGGER IF NOT EXISTS plan_version_visual_dna_must_match_project
      BEFORE INSERT ON production_plan_versions
      WHEN NEW.visual_dna_id IS NOT NULL AND (
        SELECT project_id FROM production_plans WHERE id = NEW.plan_id
      ) IS NOT (SELECT project_id FROM visual_dna WHERE id = NEW.visual_dna_id)
      BEGIN
        SELECT RAISE(ABORT, 'plan version visual DNA must belong to the plan project');
      END;

    CREATE TRIGGER IF NOT EXISTS plan_version_visual_dna_must_match_project_update
      BEFORE UPDATE ON production_plan_versions
      WHEN NEW.visual_dna_id IS NOT NULL AND (
        SELECT project_id FROM production_plans WHERE id = NEW.plan_id
      ) IS NOT (SELECT project_id FROM visual_dna WHERE id = NEW.visual_dna_id)
      BEGIN
        SELECT RAISE(ABORT, 'plan version visual DNA must belong to the plan project');
      END;

    -- Frozen content: once a version is approved (or archived) its content may not move. Lifecycle
    -- status and audit columns may still change, which is how EXECUTABLE and ARCHIVED are recorded.
    CREATE TRIGGER IF NOT EXISTS production_plan_version_content_is_immutable_once_frozen
      BEFORE UPDATE ON production_plan_versions
      WHEN OLD.status IN ('APPROVED', 'EXECUTABLE', 'ARCHIVED')
        AND (
          OLD.plan_id <> NEW.plan_id
          OR OLD.version_number <> NEW.version_number
          OR OLD.content_hash <> NEW.content_hash
          OR OLD.visual_dna_id IS NOT NEW.visual_dna_id
          OR OLD.predecessor_version_id IS NOT NEW.predecessor_version_id
          OR OLD.created_at <> NEW.created_at
        )
      BEGIN
        SELECT RAISE(ABORT, 'approved plan versions cannot be edited; create a new version');
      END;

    CREATE TRIGGER IF NOT EXISTS production_plan_version_cannot_be_deleted_when_frozen
      BEFORE DELETE ON production_plan_versions
      WHEN OLD.status IN ('APPROVED', 'EXECUTABLE', 'ARCHIVED')
      BEGIN
        SELECT RAISE(ABORT, 'approved plan versions cannot be deleted');
      END;

    -- A character used by a plan version must be an identity in that plan's project.
    CREATE TRIGGER IF NOT EXISTS plan_version_character_must_match_project
      BEFORE INSERT ON plan_version_characters
      WHEN (
        SELECT p.project_id FROM production_plan_versions v JOIN production_plans p ON p.id = v.plan_id
         WHERE v.id = NEW.plan_version_id
      ) IS NOT (SELECT project_id FROM characters WHERE id = NEW.character_id)
      BEGIN
        SELECT RAISE(ABORT, 'plan cast character must belong to the plan project');
      END;

    -- Required planning references must resolve inside the plan's project.
    CREATE TRIGGER IF NOT EXISTS scene_plan_world_must_match_project
      BEFORE INSERT ON scene_plans
      WHEN NEW.world_id IS NOT NULL AND (
        SELECT p.project_id FROM production_plan_versions v JOIN production_plans p ON p.id = v.plan_id
         WHERE v.id = NEW.plan_version_id
      ) IS NOT (SELECT project_id FROM worlds WHERE id = NEW.world_id)
      BEGIN
        SELECT RAISE(ABORT, 'scene plan world must belong to the plan project');
      END;

    CREATE TRIGGER IF NOT EXISTS scene_plan_world_must_match_project_update
      BEFORE UPDATE ON scene_plans
      WHEN NEW.world_id IS NOT NULL AND (
        SELECT p.project_id FROM production_plan_versions v JOIN production_plans p ON p.id = v.plan_id
         WHERE v.id = NEW.plan_version_id
      ) IS NOT (SELECT project_id FROM worlds WHERE id = NEW.world_id)
      BEGIN
        SELECT RAISE(ABORT, 'scene plan world must belong to the plan project');
      END;

    CREATE TRIGGER IF NOT EXISTS scene_plan_visual_dna_must_match_project
      BEFORE INSERT ON scene_plans
      WHEN NEW.visual_dna_id IS NOT NULL AND (
        SELECT p.project_id FROM production_plan_versions v JOIN production_plans p ON p.id = v.plan_id
         WHERE v.id = NEW.plan_version_id
      ) IS NOT (SELECT project_id FROM visual_dna WHERE id = NEW.visual_dna_id)
      BEGIN
        SELECT RAISE(ABORT, 'scene plan visual DNA must belong to the plan project');
      END;

    CREATE TRIGGER IF NOT EXISTS scene_plan_visual_dna_must_match_project_update
      BEFORE UPDATE ON scene_plans
      WHEN NEW.visual_dna_id IS NOT NULL AND (
        SELECT p.project_id FROM production_plan_versions v JOIN production_plans p ON p.id = v.plan_id
         WHERE v.id = NEW.plan_version_id
      ) IS NOT (SELECT project_id FROM visual_dna WHERE id = NEW.visual_dna_id)
      BEGIN
        SELECT RAISE(ABORT, 'scene plan visual DNA must belong to the plan project');
      END;

    CREATE TRIGGER IF NOT EXISTS scene_plan_character_must_match_project
      BEFORE INSERT ON scene_plan_characters
      WHEN (
        SELECT pp.project_id FROM scene_plans sp
          JOIN production_plan_versions v ON v.id = sp.plan_version_id
          JOIN production_plans pp ON pp.id = v.plan_id
         WHERE sp.id = NEW.scene_plan_id
      ) IS NOT (SELECT project_id FROM characters WHERE id = NEW.character_id)
      BEGIN
        SELECT RAISE(ABORT, 'scene plan cast character must belong to the plan project');
      END;

    -- Validation evidence is append-only, like QC results and review decisions.
    CREATE TRIGGER IF NOT EXISTS plan_validations_are_immutable
      BEFORE UPDATE ON plan_validations
      BEGIN
        SELECT RAISE(ABORT, 'plan validation evidence is immutable');
      END;

    CREATE TRIGGER IF NOT EXISTS plan_validations_cannot_be_deleted
      BEFORE DELETE ON plan_validations
      BEGIN
        SELECT RAISE(ABORT, 'plan validation evidence is immutable');
      END;
  `);

  for (const guard of PLAN_CHILD_GUARDS) {
    const operations = [
      ["insert", "INSERT", "NEW", "add"],
      ["update", "UPDATE", "NEW", "edit"],
      ["delete", "DELETE", "OLD", "remove"],
    ] as const;
    const sql = operations
      .map(([suffix, operation, alias, verb]) => {
        const checks = [`${guard.statusSql(alias)} NOT IN ('DRAFT', 'VALIDATED')`];
        if (operation === "UPDATE") {
          checks.unshift(`${guard.statusSql("OLD")} NOT IN ('DRAFT', 'VALIDATED')`);
          checks.push(`OLD.${guard.parentColumn} <> NEW.${guard.parentColumn}`);
        }
        return `
    CREATE TRIGGER IF NOT EXISTS ${guard.table}_requires_editable_plan_version_${suffix}
      BEFORE ${operation} ON ${guard.table}
      WHEN ${checks.join("\n        OR ")}
      BEGIN
        SELECT RAISE(ABORT, 'cannot ${verb} ${guard.table.replace(/_/g, " ")} of a non-draft plan version');
      END;`;
      })
      .join("\n");
    db.exec(sql);
  }
}

function addColumn(db: Database.Database, table: string, definition: string): void {
  const columnName = definition.trim().split(/\s+/, 1)[0];
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}
