import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { SqliteJobRepository } from "../dist/index.js";

const LEGACY_SCHEMA = `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, metadata_json TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE scenes (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, sequence INTEGER NOT NULL,
    description TEXT, metadata_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(project_id, sequence)
  );
  CREATE TABLE characters (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
    metadata_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE scene_characters (
    scene_id TEXT NOT NULL, character_id TEXT NOT NULL, role TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY(scene_id, character_id)
  );
  CREATE TABLE generation_jobs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, scene_id TEXT NOT NULL, provider TEXT NOT NULL,
    prompt TEXT NOT NULL, references_json TEXT NOT NULL, metadata_json TEXT, status TEXT NOT NULL,
    external_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE queue_entries (job_id TEXT PRIMARY KEY, enqueued_at TEXT NOT NULL);
  CREATE TABLE assets (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, scene_id TEXT, job_id TEXT, kind TEXT NOT NULL,
    path TEXT NOT NULL, mime_type TEXT, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
    provider TEXT, external_id TEXT, metadata_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
`;

test("legacy database migrates safely without replaying ambiguous active work", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-legacy-db-"));
  const dbPath = path.join(directory, "legacy.sqlite");
  const legacy = new Database(dbPath);
  legacy.exec(LEGACY_SCHEMA);
  legacy.prepare("INSERT INTO projects VALUES (?, ?, NULL, NULL, ?, ?)")
    .run("legacy-project", "Legacy project", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO scenes VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)")
    .run("legacy-scene", "legacy-project", "Legacy scene", 1, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
  const insertJob = legacy.prepare(`
    INSERT INTO generation_jobs (
      id, project_id, scene_id, provider, prompt, references_json, metadata_json,
      status, external_id, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, NULL, NULL, ?, ?)
  `);
  insertJob.run("legacy-completed", "legacy-project", "legacy-scene", "mock", "completed prompt", "COMPLETED", "2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z");
  insertJob.run("legacy-running", "legacy-project", "legacy-scene", "mock", "running prompt", "RUNNING", "2025-01-01T00:00:00.000Z", "2025-01-01T00:02:00.000Z");
  legacy.prepare("INSERT INTO queue_entries VALUES (?, ?)").run("legacy-running", "2025-01-01T00:00:00.000Z");
  legacy.close();

  let repository;
  try {
    repository = new SqliteJobRepository(dbPath);
    assert.equal(repository.getSchemaVersion(), 3);
    const completed = repository.getGenerationJob("legacy-completed");
    const active = repository.getGenerationJob("legacy-running");
    assert.equal(completed.status, "SUCCEEDED");
    assert.equal(completed.idempotencyKey, "legacy:legacy-completed");
    assert.equal(active.status, "FAILED");
    assert.match(active.error, /not automatically replayed/);
    assert.ok(active.request.sceneVersionId);
    assert.equal(repository.getQueueItemByJob("legacy-running"), null);
    assert.throws(
      () => repository.retryFailedJob("legacy-running", "2026-10-04T12:00:00.000Z"),
      /Legacy jobs lack safe attempt history/,
    );

    const scene = repository.getScene("legacy-scene");
    assert.ok(scene.currentVersionId);
    assert.equal(repository.listSceneVersions(scene.id).length, 2);

    repository.close();
    repository = undefined;
    const raw = new Database(dbPath);
    raw.pragma("foreign_keys = ON");
    assert.throws(
      () => raw.prepare("UPDATE scene_versions SET prompt = 'mutated' WHERE id = ?").run(scene.currentVersionId),
      /scene versions are immutable/,
    );
    assert.throws(
      () => raw.prepare("DELETE FROM scene_versions WHERE id = ?").run(scene.currentVersionId),
      /scene versions are immutable/,
    );
    raw.close();
  } finally {
    repository?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("schema version 2 receives the late integrity triggers in forward migration 3", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-v2-db-"));
  const dbPath = path.join(directory, "version-2.sqlite");
  let repository;
  let raw;
  try {
    repository = new SqliteJobRepository(dbPath);
    repository.close();
    repository = undefined;

    raw = new Database(dbPath);
    raw.exec(`
      DROP TRIGGER IF EXISTS asset_current_version_must_match_asset;
      DROP TRIGGER IF EXISTS selected_asset_requires_approval_and_qc;
    `);
    raw.pragma("user_version = 2");
    raw.close();
    raw = undefined;

    repository = new SqliteJobRepository(dbPath);
    assert.equal(repository.getSchemaVersion(), 3);
    repository.close();
    repository = undefined;

    raw = new Database(dbPath);
    const triggers = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((row) => row.name);
    assert.ok(triggers.includes("asset_current_version_must_match_asset"));
    assert.ok(triggers.includes("selected_asset_requires_approval_and_qc"));
  } finally {
    repository?.close();
    raw?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
