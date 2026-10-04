import type { SceneRecord } from "@flowforge/core";
import { ApplicationError } from "./errors.js";
import { identifier } from "./validation.js";
import { isoNow, type ServiceDeps } from "./deps.js";
import type { ProductionReadiness, ProjectProductionSummary, SceneSummaryRow } from "./read-models.js";
import { blockerCodes, sceneReadiness } from "./projections.js";
import type { SceneService } from "./scene-service.js";

/**
 * The production gate. Readiness is **derived** from persisted evidence on every call — there is
 * no stored "production ready" flag to fall out of sync with the QC, review, and selection rows
 * that justify it. Setting the scene's `READY` status is the only write, and it is refused until
 * the derived gate passes.
 */
export class ProductionService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly scenes: SceneService,
  ) {}

  readiness(sceneIdInput: string): ProductionReadiness {
    return sceneReadiness(this.deps.repository, this.scenes.getScene(sceneIdInput));
  }

  /** Guards the `DRAFT -> READY` transition with the derived readiness gate. */
  markReady(sceneIdInput: string, options: { now?: string } = {}): ProductionReadiness {
    const scene = this.scenes.getScene(sceneIdInput);
    const readiness = sceneReadiness(this.deps.repository, scene);
    if (readiness.productionReady && scene.status === "READY") return readiness;
    if (!readiness.productionReady) {
      throw new ApplicationError(
        "READINESS_NOT_SATISFIED",
        `Scene ${scene.id} is not production ready: ${readiness.blockers.map((blocker) => blocker.code).join(", ")}.`,
        {
          sceneId: scene.id,
          blockers: readiness.blockers,
        },
      );
    }
    const updated = this.deps.repository.updateSceneStatus(scene.id, "READY", isoNow(this.deps, options.now));
    return sceneReadiness(this.deps.repository, updated);
  }

  /** Reopens a ready scene (for example after a new scene version is added). */
  reopen(sceneIdInput: string, options: { now?: string } = {}): SceneRecord {
    const scene = this.scenes.getScene(sceneIdInput);
    if (scene.status !== "READY") {
      throw new ApplicationError("INVALID_STATE_TRANSITION", `Only a READY scene can be reopened (status: ${scene.status}).`, {
        sceneId: scene.id,
        status: scene.status,
      });
    }
    return this.deps.repository.updateSceneStatus(scene.id, "DRAFT", isoNow(this.deps, options.now));
  }

  projectSummary(projectIdInput: string): ProjectProductionSummary {
    const projectId = identifier(projectIdInput, "projectId");
    const project = this.deps.repository.getProject(projectId);
    if (!project) {
      throw new ApplicationError("NOT_FOUND", `Project not found: ${projectId}`, { projectId });
    }
    const scenes = this.deps.repository.listProjectScenes(projectId);
    const rows: SceneSummaryRow[] = [];
    for (const scene of scenes) {
      const readiness = sceneReadiness(this.deps.repository, scene);
      const selected = scene.selectedAssetVersionId
        ? this.deps.repository.getAssetVersion(scene.selectedAssetVersionId)
        : null;
      rows.push({
        sceneId: scene.id,
        title: scene.title,
        status: scene.status,
        productionReady: readiness.productionReady,
        blockers: blockerCodes(readiness),
        selectedAssetVersionId: scene.selectedAssetVersionId,
        checksum: selected?.checksum,
      });
    }
    const producible = rows.filter((row) => row.status !== "ARCHIVED");
    const blockingReasons = [
      ...(producible.length === 0 ? ["PROJECT_HAS_NO_ACTIVE_SCENES"] : []),
      ...producible
        .filter((row) => !row.productionReady)
        .flatMap((row) => row.blockers.map((blocker) => `${row.sceneId}:${blocker}`)),
      ...(project.status === "ARCHIVED" ? ["PROJECT_ARCHIVED"] : []),
    ];
    return {
      projectId,
      projectName: project.name,
      projectStatus: project.status,
      productionReady: blockingReasons.length === 0,
      blockingReasons,
      counts: {
        scenes: rows.length,
        productionReady: rows.filter((row) => row.productionReady).length,
        draft: rows.filter((row) => row.status === "DRAFT").length,
        ready: rows.filter((row) => row.status === "READY").length,
        archived: rows.filter((row) => row.status === "ARCHIVED").length,
      },
      scenes: rows,
      assets: { count: this.deps.repository.listProjectAssets(projectId).length },
    };
  }
}
