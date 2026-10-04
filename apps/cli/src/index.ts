#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FileSystemAssetStore } from "@flowforge/assets";
import type { ProjectRecord, SceneRecord } from "@flowforge/core";
import { MockGenerationProvider, type MockArtifactMode, type MockProviderMode } from "@flowforge/provider-mock";
import { LocalQueueWorker, SqliteJobQueue } from "@flowforge/queue";
import { SqliteJobRepository } from "@flowforge/storage";

const PROJECT_ID = "phase1-vertical-slice-project";
const SCENE_ID = "phase1-vertical-slice-scene-001";
const SCENE_VERSION_ID = "phase1-vertical-slice-scene-001-v1";
const DEMO_PROMPT = "A small glass greenhouse at sunrise, soft golden light, a gentle breeze moving the leaves.";

interface CliOptions {
  dataDir: string;
  mode: MockProviderMode;
  artifact: MockArtifactMode;
  review: "approve" | "reject";
  reviewer: string;
  help: boolean;
}

export async function runVerticalSlice(options: CliOptions): Promise<void> {
  const dataDir = path.resolve(options.dataDir);
  await mkdir(dataDir, { recursive: true });
  const databasePath = path.join(dataDir, "flowforge.sqlite");
  const assetRoot = path.join(dataDir, "assets");
  const providerRoot = path.join(dataDir, "mock-provider");
  const repository = new SqliteJobRepository(databasePath);

  try {
    const project = getOrCreateProject(repository);
    const scene = getOrCreateScene(repository, project);
    const sceneVersion = repository.createSceneVersion({
      id: SCENE_VERSION_ID,
      sceneId: scene.id,
      prompt: DEMO_PROMPT,
      references: [],
      metadata: { createdBy: "phase1-vertical-slice" },
    });
    const job = repository.createGenerationJob({
      projectId: project.id,
      sceneId: scene.id,
      sceneVersionId: sceneVersion.id,
      provider: "mock",
      parameters: { aspectRatio: "1:1", outputCount: 1 },
      maxAttempts: 3,
      priority: 10,
    });

    const provider = new MockGenerationProvider({
      rootDir: providerRoot,
      mode: options.mode,
      artifact: options.artifact,
      failAttempts: options.mode === "TRANSIENT_FAILURE" ? 1 : 0,
    });
    const worker = new LocalQueueWorker(
      repository,
      new SqliteJobQueue(repository),
      provider,
      new FileSystemAssetStore(assetRoot),
      {
        workerId: "phase1-vertical-slice-cli",
        retryDelayMs: 0,
        maxRecoveries: 3,
      },
    );
    const workerRuns = await worker.runUntilIdle(20);
    let finalJob = repository.getGenerationJob(job.id)!;
    const attempts = repository.listGenerationAttempts(job.id);
    const queueItem = repository.getQueueItemByJob(job.id);
    const assetVersion = repository.listAssetVersionsForSceneVersion(sceneVersion.id)
      .find((candidate) => candidate.generationJobId === job.id);

    let qcStatus: string | undefined;
    let reviewStatus: string | undefined;
    let selectedAssetVersionId: string | undefined;
    if (assetVersion) {
      const qc = repository.getQCResult(assetVersion.id);
      let review = repository.getReviewByAssetVersion(assetVersion.id);
      qcStatus = qc?.status;
      if (review?.status === "PENDING" && qc?.status === "PASSED") {
        review = repository.decideReview({
          assetVersionId: assetVersion.id,
          status: options.review === "approve" ? "APPROVED" : "REJECTED",
          reviewer: options.reviewer,
          comment: `Explicit ${options.review} decision from the vertical-slice CLI.`,
        });
      }
      reviewStatus = review?.status;
      if (review?.status === "APPROVED" && qc?.status === "PASSED") {
        const currentSelection = repository.getScene(scene.id)?.selectedAssetVersionId;
        if (!currentSelection) {
          selectedAssetVersionId = repository.selectApprovedAssetVersion(scene.id, assetVersion.id).selectedAssetVersionId;
        } else {
          // The demo is idempotent and never overwrites a later explicit user selection.
          selectedAssetVersionId = currentSelection;
        }
      }
    }
    finalJob = repository.getGenerationJob(job.id)!;

    const report = {
      workflow: "Project -> Scene Version -> Idempotent Job -> Durable Queue -> MockProvider -> Asset -> QC -> Review -> Version Selection",
      dataDir,
      projectId: project.id,
      sceneId: scene.id,
      sceneVersionId: sceneVersion.id,
      jobId: finalJob.id,
      jobStatus: finalJob.status,
      queueStatus: queueItem?.status,
      attemptCount: finalJob.attemptCount,
      attemptHistory: attempts.map((attempt) => ({ number: attempt.attemptNumber, status: attempt.status, errorClass: attempt.errorClass })),
      providerMode: options.mode,
      workerRuns: workerRuns.length,
      assetVersionId: assetVersion?.id,
      assetPath: assetVersion?.storagePath,
      assetBytes: assetVersion?.sizeBytes,
      assetSha256: assetVersion?.checksum,
      qcStatus,
      reviewStatus,
      selectedAssetVersionId,
    };
    console.log("FlowForge Phase 1 vertical slice");
    console.log(JSON.stringify(report, null, 2));
    if (finalJob.status !== "SUCCEEDED" || !assetVersion || qcStatus !== "PASSED") process.exitCode = 1;
  } finally {
    repository.close();
  }
}

function getOrCreateProject(repository: SqliteJobRepository): ProjectRecord {
  const existing = repository.getProject(PROJECT_ID);
  return existing ?? repository.createProject({
    id: PROJECT_ID,
    name: "FlowForge Phase 1 Demonstration",
    description: "Deterministic mock-backed durable production workflow.",
  });
}

function getOrCreateScene(repository: SqliteJobRepository, project: ProjectRecord): SceneRecord {
  const existing = repository.getScene(SCENE_ID);
  if (existing) {
    if (existing.projectId !== project.id) throw new Error("The seeded vertical-slice scene belongs to a different project.");
    return existing;
  }
  return repository.createScene({
    id: SCENE_ID,
    projectId: project.id,
    sceneNumber: 1,
    title: "Sunrise greenhouse",
    description: "A concise sample scene for the Phase 1 CLI.",
  });
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    dataDir: path.resolve(".flowforge/vertical-slice"),
    mode: "SUCCESS",
    artifact: "VALID_PNG",
    review: "approve",
    reviewer: "phase1-cli-operator",
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--data-dir") {
      options.dataDir = requireValue(args, ++index, arg);
    } else if (arg === "--mode") {
      const value = requireValue(args, ++index, arg).toUpperCase();
      if (!["SUCCESS", "TRANSIENT_FAILURE", "PERMANENT_FAILURE", "TIMEOUT", "DUPLICATE_RESULT"].includes(value)) {
        throw new Error(`Unsupported mock mode: ${value}`);
      }
      options.mode = value as MockProviderMode;
    } else if (arg === "--artifact") {
      const value = requireValue(args, ++index, arg).toUpperCase();
      if (!["VALID_PNG", "INVALID_PNG"].includes(value)) throw new Error(`Unsupported artifact mode: ${value}`);
      options.artifact = value as MockArtifactMode;
    } else if (arg === "--review") {
      const value = requireValue(args, ++index, arg).toLowerCase();
      if (value !== "approve" && value !== "reject") throw new Error("--review must be approve or reject.");
      options.review = value;
    } else if (arg === "--reviewer") {
      options.reviewer = requireValue(args, ++index, arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function printHelp(): void {
  console.log(`FlowForge Phase 1 mock-backed vertical slice\n\nUsage:\n  flowforge [--data-dir PATH] [--mode MODE] [--artifact VALID_PNG|INVALID_PNG]\n           [--review approve|reject] [--reviewer NAME]\n\nModes: SUCCESS, TRANSIENT_FAILURE, PERMANENT_FAILURE, TIMEOUT, DUPLICATE_RESULT\nThe default success demo records an explicit CLI review decision and selects the approved version.`);
}

async function main(): Promise<void> {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) return printHelp();
    await runVerticalSlice(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
