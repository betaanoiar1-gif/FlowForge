import type { ReviewRecord } from "@flowforge/core";
import { ApplicationError, translateRepositoryError } from "./errors.js";
import { identifier, optionalText, requiredText } from "./validation.js";
import { isoNow, type ServiceDeps } from "./deps.js";
import type { DecideReviewCommand, SelectAssetVersionCommand } from "./commands.js";
import type { OutputSummary, ReviewDecisionResult, ReviewQueueItem, SelectionResult } from "./read-models.js";
import { reviewQueueItem, sceneReadiness, toOutputSummary } from "./projections.js";

/**
 * Human review and explicit selection. A decision is recorded only when an operator supplies it:
 * this service never infers approval from passing QC, and never selects a "best" asset.
 */
export class ReviewService {
  constructor(private readonly deps: ServiceDeps) {}

  /** Every asset version awaiting a decision, optionally narrowed to one scene or project. */
  listPending(filter: { projectId?: string; sceneId?: string } = {}): ReviewQueueItem[] {
    return this.collect(filter, (item) => item.reviewStatus === "PENDING");
  }

  listForScene(sceneIdInput: string): ReviewQueueItem[] {
    const sceneId = identifier(sceneIdInput, "sceneId");
    if (!this.deps.repository.getScene(sceneId)) {
      throw new ApplicationError("NOT_FOUND", `Scene not found: ${sceneId}`, { sceneId });
    }
    return this.collect({ sceneId }, () => true);
  }

  get(assetVersionIdInput: string): ReviewQueueItem {
    const assetVersionId = identifier(assetVersionIdInput, "assetVersionId");
    const assetVersion = this.deps.repository.getAssetVersion(assetVersionId);
    if (!assetVersion) {
      throw new ApplicationError("NOT_FOUND", `Asset version not found: ${assetVersionId}`, { assetVersionId });
    }
    const item = reviewQueueItem(this.deps.repository, assetVersion);
    if (!item) {
      throw new ApplicationError("NOT_FOUND", `Asset version ${assetVersionId} is not linked to a reviewable scene output.`, {
        assetVersionId,
      });
    }
    return item;
  }

  /**
   * Records APPROVE or REJECT. Re-sending an identical decision is idempotent (the CLI may be
   * re-run); sending a different decision is refused, because the durable review is final.
   */
  decide(input: DecideReviewCommand): ReviewDecisionResult {
    const assetVersionId = identifier(input.assetVersionId, "assetVersionId");
    const assetVersion = this.deps.repository.getAssetVersion(assetVersionId);
    if (!assetVersion) {
      throw new ApplicationError("NOT_FOUND", `Asset version not found: ${assetVersionId}`, { assetVersionId });
    }
    if (!this.deps.repository.getQCResult(assetVersionId)) {
      throw new ApplicationError(
        "QC_NOT_RECORDED",
        "Deterministic QC has not been recorded for this asset version, so it is not reviewable yet.",
        { assetVersionId },
      );
    }
    const review = this.deps.repository.getReviewByAssetVersion(assetVersionId);
    if (!review) {
      throw new ApplicationError(
        "QC_NOT_RECORDED",
        "No review row exists for this asset version; reviews are created when a generation completes.",
        { assetVersionId },
      );
    }
    const decision = input.decision;
    if (decision !== "APPROVED" && decision !== "REJECTED") {
      throw new ApplicationError("VALIDATION_FAILED", 'decision must be "APPROVED" or "REJECTED".', {
        field: "decision",
      });
    }
    const reason = optionalText(input.reason, "reason", 500);
    const comment = optionalText(input.comment, "comment", 2_000);
    const reviewer = requiredText(input.reviewer ?? "operator", "reviewer", 200);

    if (review.status !== "PENDING") {
      if (review.status === decision && review.reason === reason && review.comment === comment) {
        return { review, idempotent: true, item: this.get(assetVersionId) };
      }
      throw new ApplicationError(
        "REVIEW_ALREADY_DECIDED",
        `Review ${review.id} already holds a final ${review.status} decision; a new asset version is required to change it.`,
        { assetVersionId, currentStatus: review.status, attempted: decision },
      );
    }

    let decided: ReviewRecord;
    try {
      decided = this.deps.repository.decideReview({
        assetVersionId,
        status: decision,
        reason,
        comment,
        reviewer,
        now: isoNow(this.deps, input.now),
      });
    } catch (error) {
      throw translateRepositoryError(error, "PERSISTENCE_REJECTED", { assetVersionId });
    }
    return { review: decided, idempotent: false, item: this.get(assetVersionId) };
  }

  /**
   * Moves the scene's current-version and selected-asset pointers in the repository's single
   * transaction. The approval-plus-passing-QC rule stays enforced there; the pre-checks here only
   * convert it into typed operator errors before any write is attempted.
   */
  select(input: SelectAssetVersionCommand): SelectionResult {
    const sceneId = identifier(input.sceneId, "sceneId");
    const assetVersionId = identifier(input.assetVersionId, "assetVersionId");
    const scene = this.deps.repository.getScene(sceneId);
    if (!scene) {
      throw new ApplicationError("NOT_FOUND", `Scene not found: ${sceneId}`, { sceneId });
    }
    const assetVersion = this.deps.repository.getAssetVersion(assetVersionId);
    if (!assetVersion) {
      throw new ApplicationError("NOT_FOUND", `Asset version not found: ${assetVersionId}`, { assetVersionId });
    }
    const review = this.deps.repository.getReviewByAssetVersion(assetVersionId);
    if (!review || review.status !== "APPROVED") {
      throw new ApplicationError("SELECTION_NOT_ALLOWED", "Only an explicitly approved asset version can be selected.", {
        assetVersionId,
        reviewStatus: review?.status ?? "MISSING",
      });
    }
    const qc = this.deps.repository.getQCResult(assetVersionId);
    if (!qc) {
      throw new ApplicationError("QC_NOT_RECORDED", "No deterministic QC result exists for this asset version.", {
        assetVersionId,
      });
    }
    if (qc.status !== "PASSED") {
      throw new ApplicationError("QC_NOT_PASSED", `Deterministic QC ${qc.status} blocks selection.`, {
        assetVersionId,
        qcStatus: qc.status,
      });
    }

    let selected;
    try {
      selected = this.deps.repository.selectApprovedAssetVersion(sceneId, assetVersionId, isoNow(this.deps, input.now));
    } catch (error) {
      throw translateRepositoryError(error, "SELECTION_NOT_ALLOWED", { sceneId, assetVersionId });
    }
    return { scene: selected, assetVersion, readiness: sceneReadiness(this.deps.repository, selected) };
  }

  selected(sceneIdInput: string): OutputSummary | null {
    const sceneId = identifier(sceneIdInput, "sceneId");
    const scene = this.deps.repository.getScene(sceneId);
    if (!scene) {
      throw new ApplicationError("NOT_FOUND", `Scene not found: ${sceneId}`, { sceneId });
    }
    const assetVersion = this.deps.repository.getSelectedAssetVersion(sceneId);
    return assetVersion ? toOutputSummary(this.deps.repository, assetVersion, scene.selectedAssetVersionId) : null;
  }

  private collect(
    filter: { projectId?: string; sceneId?: string },
    accept: (item: ReviewQueueItem) => boolean,
  ): ReviewQueueItem[] {
    const sceneIds = filter.sceneId
      ? [filter.sceneId]
      : (filter.projectId
          ? this.deps.repository.listProjectScenes(filter.projectId)
          : this.deps.repository.listProjects().flatMap((project) => this.deps.repository.listProjectScenes(project.id))
        ).map((scene) => scene.id);

    const items: ReviewQueueItem[] = [];
    for (const sceneId of sceneIds) {
      for (const version of this.deps.repository.listSceneVersions(sceneId)) {
        for (const assetVersion of this.deps.repository.listAssetVersionsForSceneVersion(version.id)) {
          const item = reviewQueueItem(this.deps.repository, assetVersion);
          if (item && accept(item)) items.push(item);
        }
      }
    }
    return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}
