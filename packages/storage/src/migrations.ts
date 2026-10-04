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

export const CURRENT_SCHEMA_VERSION = 3;

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
  }
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

function addColumn(db: Database.Database, table: string, definition: string): void {
  const columnName = definition.trim().split(/\s+/, 1)[0];
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}
