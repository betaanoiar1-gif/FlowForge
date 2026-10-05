import type { SceneRecord, SceneStatus, SceneVersionRecord } from "@flowforge/core";
import { ApplicationError } from "./errors.js";
import {
  identifier,
  integerRange,
  metadataRecord,
  optionalIdentifier,
  optionalText,
  referenceList,
  requiredText,
} from "./validation.js";
import { isoNow, type ServiceDeps } from "./deps.js";
import type {
  AddSceneVersionCommand,
  CreateSceneCommand,
  SetCurrentSceneVersionCommand,
  SetSceneStatusCommand,
} from "./commands.js";
import type { SceneDetail, SceneListItem, SceneVersionSummary } from "./read-models.js";
import {
  sceneListItem,
  sceneReadiness,
  toJobSummary,
  toOutputSummary,
  toSceneVersionSummary,
} from "./projections.js";

/**
 * Scene and scene-version commands plus the scene detail projection. Prompt text is created
 * here and nowhere else: a generation request inherits it from the pinned scene version, so an
 * operator cannot submit a prompt that was never persisted.
 */
export class SceneService {
  constructor(private readonly deps: ServiceDeps) {}

  createScene(input: CreateSceneCommand): SceneRecord {
    const projectId = identifier(input.projectId, "projectId");
    this.requireProject(projectId);
    const now = isoNow(this.deps, input.now);
    const sceneNumber = integerRange(input.sceneNumber, "sceneNumber", { min: 1, max: 100_000, fallback: nextSceneNumber(this.deps.repository.listProjectScenes(projectId)) });
    return this.deps.repository.createScene({
      id: optionalIdentifier(input.sceneId, "sceneId"),
      projectId,
      sceneNumber,
      title: requiredText(input.title, "scene title", 200),
      description: optionalText(input.description, "scene description"),
      metadata: metadataRecord(input.metadata, "metadata"),
      now,
    });
  }

  getScene(sceneIdInput: string): SceneRecord {
    return this.requireScene(sceneIdInput);
  }

  listScenes(projectIdInput: string): SceneListItem[] {
    const projectId = identifier(projectIdInput, "projectId");
    this.requireProject(projectId);
    return this.deps.repository.listProjectScenes(projectId).map((scene) => sceneListItem(this.deps.repository, scene));
  }

  /** Creates an immutable scene version and moves the current pointer onto it (repository rule). */
  addSceneVersion(input: AddSceneVersionCommand): SceneVersionRecord {
    const scene = this.requireScene(input.sceneId);
    const now = isoNow(this.deps, input.now);
    return this.deps.repository.createSceneVersion({
      id: optionalIdentifier(input.sceneVersionId, "sceneVersionId"),
      sceneId: scene.id,
      prompt: requiredText(input.prompt, "prompt"),
      references: referenceList(input.references),
      metadata: metadataRecord(input.metadata, "metadata"),
      parentVersionId: optionalIdentifier(input.parentVersionId, "parentVersionId"),
      // Recorded by Phase 5 materialization only; the repository requires a complete tuple or none.
      ...(input.planLink ? { planLink: input.planLink } : {}),
      now,
    });
  }

  listSceneVersions(sceneIdInput: string): SceneVersionSummary[] {
    const scene = this.requireScene(sceneIdInput);
    return this.deps.repository
      .listSceneVersions(scene.id)
      .map((version) => toSceneVersionSummary(version, scene.currentVersionId));
  }

  getCurrentVersion(sceneIdInput: string): SceneVersionRecord | null {
    const scene = this.requireScene(sceneIdInput);
    return scene.currentVersionId ? this.deps.repository.getSceneVersion(scene.currentVersionId) : null;
  }

  /**
   * Moves the current pointer explicitly. Switching to an older version is a supported way to
   * re-run earlier work; readiness recomputes against whatever version is current.
   */
  setCurrentVersion(input: SetCurrentSceneVersionCommand): SceneRecord {
    const scene = this.requireScene(input.sceneId);
    const sceneVersionId = identifier(input.sceneVersionId, "sceneVersionId");
    const version = this.deps.repository.getSceneVersion(sceneVersionId);
    if (!version || version.sceneId !== scene.id) {
      throw new ApplicationError("NOT_FOUND", `Scene version ${sceneVersionId} does not belong to scene ${scene.id}.`, {
        sceneId: scene.id,
        sceneVersionId,
      });
    }
    return this.deps.repository.setCurrentSceneVersion(scene.id, sceneVersionId, isoNow(this.deps, input.now));
  }

  /**
   * Operator lifecycle changes that need no production evidence. `READY` is intentionally not
   * accepted here; only `ProductionService.markReady` may set it, after the gate passes.
   */
  setStatus(input: SetSceneStatusCommand): SceneRecord {
    const scene = this.requireScene(input.sceneId);
    const requested = input.status as SceneStatus | undefined;
    if (requested === "READY") {
      throw new ApplicationError(
        "READINESS_NOT_SATISFIED",
        "READY is set by ProductionService.markReady after the readiness gate passes, not by a status command.",
        { sceneId: scene.id },
      );
    }
    if (requested !== "DRAFT" && requested !== "ARCHIVED") {
      throw new ApplicationError("VALIDATION_FAILED", `Unsupported scene status: ${String(requested)}`, {
        sceneId: scene.id,
        status: requested,
      });
    }
    if (scene.status === "ARCHIVED") {
      throw new ApplicationError("INVALID_STATE_TRANSITION", `Scene ${scene.id} is archived; archived scenes are terminal.`, {
        sceneId: scene.id,
        status: scene.status,
      });
    }
    return this.deps.repository.updateSceneStatus(scene.id, requested, isoNow(this.deps, input.now));
  }

  detail(sceneIdInput: string): SceneDetail {
    const scene = this.requireScene(sceneIdInput);
    const versions = this.deps.repository
      .listSceneVersions(scene.id)
      .map((version) => toSceneVersionSummary(version, scene.currentVersionId));
    const jobs = this.deps.repository.listGenerationJobs({ sceneId: scene.id });
    const outputs = scene.currentVersionId
      ? this.deps.repository
          .listAssetVersionsForSceneVersion(scene.currentVersionId)
          .map((assetVersion) => toOutputSummary(this.deps.repository, assetVersion, scene.selectedAssetVersionId))
      : [];
    return {
      scene,
      versions,
      jobs: jobs.map(toJobSummary),
      outputs,
      readiness: sceneReadiness(this.deps.repository, scene),
    };
  }

  private requireScene(sceneIdInput: string): SceneRecord {
    const sceneId = identifier(sceneIdInput, "sceneId");
    const scene = this.deps.repository.getScene(sceneId);
    if (!scene) {
      throw new ApplicationError("NOT_FOUND", `Scene not found: ${sceneId}`, { sceneId });
    }
    return scene;
  }

  private requireProject(projectId: string) {
    const project = this.deps.repository.getProject(projectId);
    if (!project) {
      throw new ApplicationError("NOT_FOUND", `Project not found: ${projectId}`, { projectId });
    }
    return project;
  }
}

function nextSceneNumber(scenes: readonly SceneRecord[]): number {
  return scenes.reduce((max, scene) => Math.max(max, scene.sceneNumber), 0) + 1;
}
