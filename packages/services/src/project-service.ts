import { ApplicationError } from "./errors.js";
import { identifier, metadataRecord, optionalText, requiredText } from "./validation.js";
import { isoNow, type ServiceDeps } from "./deps.js";
import type { CreateProjectCommand, ProjectIdCommand } from "./commands.js";
import type { ProjectOverview } from "./read-models.js";
import { jobCounts, sceneListItem } from "./projections.js";
import type { ProjectRecord } from "@flowforge/core";

/**
 * Project-scoped commands. The service validates, delegates to the repository, and projects
 * reads; it never touches scenes, jobs, or assets directly beyond composing their read models.
 */
export class ProjectService {
  constructor(private readonly deps: ServiceDeps) {}

  createProject(input: CreateProjectCommand): ProjectRecord {
    const now = isoNow(this.deps, input.now);
    return this.deps.repository.createProject({
      id: input.projectId === undefined ? undefined : identifier(input.projectId, "projectId"),
      name: requiredText(input.name, "project name"),
      description: optionalText(input.description, "description"),
      metadata: metadataRecord(input.metadata, "metadata"),
      now,
    });
  }

  getProject(projectId: string): ProjectRecord {
    return this.requireProject(projectId);
  }

  listProjects(): ProjectRecord[] {
    return this.deps.repository.listProjects();
  }

  /** Archive is a guarded transition; it refuses while generation work is still open. */
  archiveProject(input: ProjectIdCommand): ProjectRecord {
    const projectId = identifier(input.projectId, "projectId");
    const project = this.requireProject(projectId);
    if (project.status === "ARCHIVED") return project;
    const now = isoNow(this.deps, input.now);
    const open = this.deps.repository
      .listGenerationJobs({ projectId })
      .filter((job) => job.status === "QUEUED" || job.status === "CLAIMED" || job.status === "RUNNING");
    if (open.length > 0) {
      throw new ApplicationError("ACTIVE_WORK_PRESENT", "Cancel queued or running generation work before archiving the project.", {
        openJobIds: open.map((job) => job.id),
      });
    }
    return this.deps.repository.updateProjectStatus(projectId, "ARCHIVED", now);
  }

  overview(projectIdInput: string): ProjectOverview {
    const projectId = identifier(projectIdInput, "projectId");
    const project = this.requireProject(projectId);
    const scenes = this.deps.repository.listProjectScenes(projectId).map((scene) => sceneListItem(this.deps.repository, scene));
    const jobs = this.deps.repository.listGenerationJobs({ projectId });
    const pendingReviews = scenes.reduce((total, scene) => total + scene.pendingReviewCount, 0);
    const projectJobIds = new Set(jobs.map((job) => job.id));
    const openQueued = this.deps.repository
      .listQueueItems({ statuses: ["QUEUED", "CLAIMED"] })
      .filter((item) => projectJobIds.has(item.generationJobId)).length;
    return {
      project,
      scenes,
      totals: {
        scenes: scenes.length,
        readyScenes: scenes.filter((scene) => scene.productionReady).length,
        jobs: jobs.length,
        jobsByStatus: jobCounts(jobs),
        pendingReviews,
        queuedWork: openQueued,
        assets: this.deps.repository.listProjectAssets(projectId).length,
      },
    };
  }

  private requireProject(projectIdInput: string): ProjectRecord {
    const projectId = identifier(projectIdInput, "projectId");
    const project = this.deps.repository.getProject(projectId);
    if (!project) {
      throw new ApplicationError("NOT_FOUND", `Project not found: ${projectId}`, { projectId });
    }
    return project;
  }
}
