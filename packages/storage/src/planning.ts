import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  assertPlanVersionStatusTransition,
  type CreativeBrief,
  type CreativeBriefConstraint,
  type CharacterTraits,
  type CharacterVisualIdentity,
  type GenerationSpec,
  type GenerationSpecKind,
  type PlanCastLink,
  type PlanStory,
  type PlanValidationRecord,
  type PlanValidationStatus,
  type PlanVersionSnapshot,
  type PlanningCharacterRecord,
  type PlanningFinding,
  type PlanningReference,
  type PlannedOutput,
  type ProductionPlan,
  type ProductionPlanVersion,
  type ProviderCapabilityKey,
  type ScenePlan,
  type ScenePlanCastLink,
  type ScenePlanContinuity,
  type VisualDnaDefinition,
  type WorldDefinition,
  type WorldVisualIdentity,
  type PlanVersionStatus,
  type PlanProvenance,
  type PlannerTraceStep,
} from "@flowforge/core";
import {
  createPlanningContentHash,
  createPlanningIdempotencyKey,
  decodeJson,
  encodeJson,
  optionalText,
  requiredText,
  stableJson,
} from "./internal.js";

/**
 * Durable persistence for the creative planning domain (Phase 4A).
 *
 * One repository owns the whole aggregate because a plan version and its children must be written
 * atomically: `revise`, cast replacement, and validation-plus-transition are each a single
 * `BEGIN IMMEDIATE` transaction. The services never see SQL; they see these methods.
 *
 * The connection is shared with `SqliteJobRepository` (see `database` getter) so planning state and
 * execution state live in one SQLite file with one migration history and one WAL journal.
 */
export class SqlitePlanningRepository {
  private readonly db: Database.Database;

  constructor(source: Database.Database | { readonly database: Database.Database }) {
    this.db = "database" in source ? source.database : source;
  }

  /* ---------------------------------- briefs --------------------------------- */

  /**
   * Inserts an immutable brief snapshot. A snapshot identical to an existing one is reused, and any
   * other snapshot for the project supersedes the previous `ACTIVE` row.
   */
  createBrief(input: CreateBriefInput): { brief: CreativeBrief; created: boolean } {
    const transaction = this.db.transaction((): { brief: CreativeBrief; created: boolean } => {
      const now = input.now ?? new Date().toISOString();
      assertProjectExists(this.db, input.projectId);

      const fields = {
        title: requiredText(input.title, "Brief title"),
        concept: optionalText(input.concept) ?? "",
        objective: optionalText(input.objective) ?? "",
        audience: optionalText(input.audience) ?? "",
        tone: optionalText(input.tone) ?? "",
        style: optionalText(input.style) ?? "",
        constraints: input.constraints ?? [],
      };
      const identity = stableJson({ projectId: input.projectId, ...fields });
      const idempotencyKey = createPlanningIdempotencyKey(identity);
      const existing = this.db.prepare(
        "SELECT id FROM creative_briefs WHERE idempotency_key = ?",
      ).get(idempotencyKey) as { id: string } | undefined;
      if (existing) return { brief: this.requireBrief(existing.id), created: false };

      const previous = this.db.prepare(
        "SELECT id, version_number FROM creative_briefs WHERE project_id = ? AND status = 'ACTIVE' ORDER BY version_number DESC LIMIT 1",
      ).get(input.projectId) as { id: string; version_number: number } | undefined;
      const versionNumber = previous ? previous.version_number + 1 : 1;
      const id = input.id ?? randomUUID();
      if (previous) {
        this.db
          .prepare("UPDATE creative_briefs SET status = 'SUPERSEDED' WHERE id = ?")
          .run(previous.id);
      }
      this.db.prepare(
        `INSERT INTO creative_briefs (
           id, project_id, version_number, supersedes_brief_id, title, concept, objective,
           audience, tone, style, constraints_json, status, content_hash, idempotency_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      ).run(
        id,
        input.projectId,
        versionNumber,
        previous?.id ?? null,
        fields.title,
        fields.concept,
        fields.objective,
        fields.audience,
        fields.tone,
        fields.style,
        encodeJson(fields.constraints),
        createPlanningContentHash(fields),
        idempotencyKey,
        now,
      );
      return { brief: this.requireBrief(id), created: true };
    });
    return transaction.immediate();
  }

  getBrief(id: string): CreativeBrief | null {
    const row = this.db.prepare("SELECT * FROM creative_briefs WHERE id = ?").get(id) as
      | BriefRow
      | undefined;
    return row ? briefFromRow(row) : null;
  }

  listBriefs(projectId: string): CreativeBrief[] {
    const rows = this.db.prepare(
      "SELECT * FROM creative_briefs WHERE project_id = ? ORDER BY version_number DESC",
    ).all(projectId) as BriefRow[];
    return rows.map(briefFromRow);
  }

  currentBrief(projectId: string): CreativeBrief | null {
    const row = this.db.prepare(
      "SELECT * FROM creative_briefs WHERE project_id = ? AND status = 'ACTIVE' ORDER BY version_number DESC LIMIT 1",
    ).get(projectId) as BriefRow | undefined;
    return row ? briefFromRow(row) : null;
  }

  /* ---------------------------- project definitions ---------------------------- */

  createWorld(input: CreateWorldInput): { world: WorldDefinition; created: boolean } {
    const transaction = this.db.transaction((): { world: WorldDefinition; created: boolean } => {
      const now = input.now ?? new Date().toISOString();
      assertProjectExists(this.db, input.projectId);
      const fields = {
        name: requiredText(input.name, "World name"),
        description: optionalText(input.description) ?? "",
        environment: optionalText(input.environment) ?? "",
        rules: input.rules ?? [],
        visualIdentity: input.visualIdentity ?? { description: "", palette: [], lighting: "" },
      };
      const identity = stableJson({ projectId: input.projectId, ...fields });
      const idempotencyKey = createPlanningIdempotencyKey(identity);
      const existing = this.db.prepare(
        "SELECT id FROM worlds WHERE idempotency_key = ?",
      ).get(idempotencyKey) as { id: string } | undefined;
      if (existing) return { world: this.requireWorld(existing.id), created: false };

      const sameName = this.db.prepare(
        "SELECT version_number FROM worlds WHERE project_id = ? AND name = ? AND status = 'ACTIVE' ORDER BY version_number DESC LIMIT 1",
      ).get(input.projectId, fields.name) as { version_number: number } | undefined;
      const id = input.id ?? randomUUID();
      const supersededId = sameName ? this.activeWorldId(input.projectId, fields.name) : null;
      if (sameName) {
        this.db.prepare(
          "UPDATE worlds SET status = 'SUPERSEDED' WHERE project_id = ? AND name = ? AND status = 'ACTIVE'",
        ).run(input.projectId, fields.name);
      }
      this.db.prepare(
        `INSERT INTO worlds (
           id, project_id, name, description, environment, rules_json, visual_identity_json,
           version_number, supersedes_world_id, status, content_hash, idempotency_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      ).run(
        id,
        input.projectId,
        fields.name,
        fields.description,
        fields.environment,
        encodeJson(fields.rules),
        encodeJson(fields.visualIdentity),
        sameName ? sameName.version_number + 1 : 1,
        supersededId,
        createPlanningContentHash(fields),
        idempotencyKey,
        now,
      );
      return { world: this.requireWorld(id), created: true };
    });
    return transaction.immediate();
  }

  getWorld(id: string): WorldDefinition | null {
    const row = this.db.prepare("SELECT * FROM worlds WHERE id = ?").get(id) as WorldRow | undefined;
    return row ? worldFromRow(row) : null;
  }

  listWorlds(projectId: string): WorldDefinition[] {
    const rows = this.db.prepare(
      "SELECT * FROM worlds WHERE project_id = ? ORDER BY name, version_number",
    ).all(projectId) as WorldRow[];
    return rows.map(worldFromRow);
  }

  createVisualDna(input: CreateVisualDnaInput): {
    visualDna: VisualDnaDefinition;
    created: boolean;
  } {
    const transaction = this.db.transaction((): {
      visualDna: VisualDnaDefinition;
      created: boolean;
    } => {
      const now = input.now ?? new Date().toISOString();
      assertProjectExists(this.db, input.projectId);
      const fields = {
        name: requiredText(input.name, "Visual DNA name"),
        description: optionalText(input.description) ?? "",
        style: requiredText(input.style, "Visual DNA style"),
        palette: input.palette ?? [],
        lighting: optionalText(input.lighting) ?? "",
        composition: optionalText(input.composition) ?? "",
        cameraLanguage: optionalText(input.cameraLanguage) ?? "",
        renderingStyle: optionalText(input.renderingStyle) ?? "",
        atmosphere: optionalText(input.atmosphere) ?? "",
        consistencyRules: input.consistencyRules ?? [],
      };
      const identity = stableJson({ projectId: input.projectId, ...fields });
      const idempotencyKey = createPlanningIdempotencyKey(identity);
      const existing = this.db.prepare(
        "SELECT id FROM visual_dna WHERE idempotency_key = ?",
      ).get(idempotencyKey) as { id: string } | undefined;
      if (existing) return { visualDna: this.requireVisualDna(existing.id), created: false };

      const sameName = this.db.prepare(
        "SELECT version_number FROM visual_dna WHERE project_id = ? AND name = ? AND status = 'ACTIVE' ORDER BY version_number DESC LIMIT 1",
      ).get(input.projectId, fields.name) as { version_number: number } | undefined;
      const supersededId = sameName
        ? this.activeVisualDnaId(input.projectId, fields.name)
        : null;
      if (sameName) {
        this.db.prepare(
          "UPDATE visual_dna SET status = 'SUPERSEDED' WHERE project_id = ? AND name = ? AND status = 'ACTIVE'",
        ).run(input.projectId, fields.name);
      }
      const id = input.id ?? randomUUID();
      this.db.prepare(
        `INSERT INTO visual_dna (
           id, project_id, name, description, style, palette_json, lighting, composition,
           camera_language, rendering_style, atmosphere, consistency_rules_json, version_number,
           supersedes_dna_id, status, content_hash, idempotency_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      ).run(
        id,
        input.projectId,
        fields.name,
        fields.description,
        fields.style,
        encodeJson(fields.palette),
        fields.lighting,
        fields.composition,
        fields.cameraLanguage,
        fields.renderingStyle,
        fields.atmosphere,
        encodeJson(fields.consistencyRules),
        sameName ? sameName.version_number + 1 : 1,
        supersededId,
        createPlanningContentHash(fields),
        idempotencyKey,
        now,
      );
      return { visualDna: this.requireVisualDna(id), created: true };
    });
    return transaction.immediate();
  }

  getVisualDna(id: string): VisualDnaDefinition | null {
    const row = this.db.prepare("SELECT * FROM visual_dna WHERE id = ?").get(id) as
      | VisualDnaRow
      | undefined;
    return row ? visualDnaFromRow(row) : null;
  }

  listVisualDna(projectId: string): VisualDnaDefinition[] {
    const rows = this.db.prepare(
      "SELECT * FROM visual_dna WHERE project_id = ? ORDER BY name, version_number",
    ).all(projectId) as VisualDnaRow[];
    return rows.map(visualDnaFromRow);
  }

  /**
   * Attaches planning identity traits to an existing project character. The identity row itself is
   * never re-created, so scene/plan references keep pointing at the same stable ID.
   */
  setCharacterIdentity(input: SetCharacterIdentityInput): PlanningCharacterRecord {
    const transaction = this.db.transaction((): PlanningCharacterRecord => {
      const now = input.now ?? new Date().toISOString();
      const existing = this.db
        .prepare("SELECT id FROM characters WHERE id = ?")
        .get(input.characterId) as { id: string } | undefined;
      if (!existing) throw new Error(`Character not found: ${input.characterId}`);
      this.db.prepare(
        "UPDATE characters SET traits_json = ?, visual_identity_json = ?, updated_at = ? WHERE id = ?",
      ).run(
        input.traits === undefined ? null : encodeJson(input.traits),
        input.visualIdentity === undefined ? null : encodeJson(input.visualIdentity),
        now,
        input.characterId,
      );
      return this.requireCharacter(input.characterId);
    });
    return transaction.immediate();
  }

  getCharacter(id: string): PlanningCharacterRecord | null {
    const row = this.db.prepare("SELECT * FROM characters WHERE id = ?").get(id) as
      | PlanningCharacterRow
      | undefined;
    return row ? characterFromRow(row) : null;
  }

  listProjectCharacters(projectId: string): PlanningCharacterRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM characters WHERE project_id = ? ORDER BY created_at, id",
    ).all(projectId) as PlanningCharacterRow[];
    return rows.map(characterFromRow);
  }

  /* ------------------------------ plans & versions ----------------------------- */

  /** Creates the plan and its first `DRAFT` version in one transaction. */
  createPlanWithInitialVersion(input: CreatePlanInput): {
    plan: ProductionPlan;
    version: ProductionPlanVersion;
    created: boolean;
  } {
    const transaction = this.db.transaction((): {
      plan: ProductionPlan;
      version: ProductionPlanVersion;
      created: boolean;
    } => {
      const now = input.now ?? new Date().toISOString();
      assertProjectExists(this.db, input.projectId);
      const brief = this.getBrief(input.briefId);
      if (!brief) throw new Error(`Creative brief not found: ${input.briefId}`);
      if (brief.projectId !== input.projectId) {
        throw new Error("Creative brief belongs to another project.");
      }
      const title = requiredText(input.title, "Plan title");
      const idempotencyKey = createPlanningIdempotencyKey(
        stableJson({ projectId: input.projectId, briefId: input.briefId, title }),
      );
      const existing = this.db.prepare(
        "SELECT id FROM production_plans WHERE idempotency_key = ?",
      ).get(idempotencyKey) as { id: string } | undefined;
      if (existing) {
        const plan = this.requirePlan(existing.id);
        return {
          plan,
          version: this.requirePlanVersion(
            plan.currentVersionId ?? this.firstVersionId(plan.id),
          ),
          created: false,
        };
      }

      const planId = input.id ?? randomUUID();
      const versionId = input.versionId ?? randomUUID();
      // The current pointer is set only after the version row exists, so the membership trigger can
      // verify it instead of being bypassed.
      this.db.prepare(
        `INSERT INTO production_plans (id, project_id, brief_id, title, current_version_id, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
      ).run(planId, input.projectId, input.briefId, title, idempotencyKey, now, now);
      this.db.prepare(
        `INSERT INTO production_plan_versions (
           id, plan_id, version_number, status, content_hash, visual_dna_id, predecessor_version_id,
           revision_note, created_at, updated_at
         ) VALUES (?, ?, 1, 'DRAFT', '', ?, NULL, '', ?, ?)`,
      ).run(
        versionId,
        planId,
        input.visualDnaId ?? null,
        now,
        now,
      );
      this.db
        .prepare("UPDATE production_plans SET current_version_id = ? WHERE id = ?")
        .run(versionId, planId);
      this.refreshContentHash(versionId, now);
      return { plan: this.requirePlan(planId), version: this.requirePlanVersion(versionId), created: true };
    });
    return transaction.immediate();
  }

  /**
   * Starts an empty DRAFT version of an existing plan and points the plan at it (Phase 4B).
   *
   * A re-plan must never edit the version it replaces. `copyPlanVersion` exists for revisions that
   * *preserve* content; this primitive exists for the planner authoring a fresh version from new
   * input. The previous version keeps its content, evidence, and lifecycle status untouched, and
   * lineage is recorded so the new version is traceable to its predecessor. Provenance is not
   * carried over: it identifies the run that produced a specific content, and this content is new.
   */
  createPlanVersion(input: CreatePlanVersionInput): {
    plan: ProductionPlan;
    version: ProductionPlanVersion;
  } {
    const transaction = this.db.transaction((): {
      plan: ProductionPlan;
      version: ProductionPlanVersion;
    } => {
      const now = input.now ?? new Date().toISOString();
      const plan = this.requirePlan(input.planId);
      const versionId = input.id ?? randomUUID();
      const predecessor =
        input.predecessorVersionId === undefined ? undefined : this.requirePlanVersion(input.predecessorVersionId);
      if (predecessor && predecessor.planId !== plan.id) {
        throw new Error(`Plan version ${predecessor.id} is not a version of ${plan.id}.`);
      }
      const nextNumber = (this.db
        .prepare("SELECT MAX(version_number) AS max FROM production_plan_versions WHERE plan_id = ?")
        .get(plan.id) as { max: number | null }).max! + 1;
      if (predecessor && predecessor.versionNumber >= nextNumber) {
        throw new Error("Plan version predecessor must be an earlier version of the same plan.");
      }
      this.db.prepare(
        `INSERT INTO production_plan_versions (
           id, plan_id, version_number, status, content_hash, visual_dna_id, predecessor_version_id,
           revision_note, created_at, updated_at
         ) VALUES (?, ?, ?, 'DRAFT', '', ?, ?, ?, ?, ?)`,
      ).run(
        versionId,
        plan.id,
        nextNumber,
        input.visualDnaId ?? predecessor?.visualDnaId ?? null,
        predecessor?.id ?? null,
        optionalText(input.note) ?? "",
        now,
        now,
      );
      // Last write, as in `createPlanWithInitialVersion`: the membership trigger can only verify a
      // pointer whose target row already exists.
      this.db
        .prepare("UPDATE production_plans SET current_version_id = ?, updated_at = ? WHERE id = ?")
        .run(versionId, now, plan.id);
      this.refreshContentHash(versionId, now);
      return { plan: this.requirePlan(plan.id), version: this.requirePlanVersion(versionId) };
    });
    return transaction.immediate();
  }

  /**
   * Records planner provenance for a version once. Provenance identifies the engine, rule set, seed,
   * and fingerprints that produced the content, so it is written when a planning run finishes and
   * never amended afterwards (a v5 trigger enforces write-once at the database level too). An
   * identical repeat is a no-op rather than a rewrite, so an idempotent re-plan does not churn rows.
   */
  setPlanVersionProvenance(input: SetPlanProvenanceInput): {
    version: ProductionPlanVersion;
    created: boolean;
  } {
    const transaction = this.db.transaction((): { version: ProductionPlanVersion; created: boolean } => {
      const now = input.now ?? new Date().toISOString();
      const version = this.requireEditableVersion(input.planVersionId);
      const provenance = input.provenance;
      if (version.plannerVersion !== undefined) {
        if (
          version.plannerVersion !== provenance.plannerVersion ||
          version.plannerRulesVersion !== provenance.rulesVersion ||
          version.plannerSeed !== provenance.seed ||
          version.plannerInputFingerprint !== provenance.inputFingerprint ||
          version.plannerOutputFingerprint !== provenance.outputFingerprint
        ) {
          throw new Error(
            `Plan version ${version.id} already carries provenance from ${version.plannerVersion}; ` +
              "create a new version to re-plan it.",
          );
        }
        return { version, created: false };
      }
      this.db
        .prepare(
          `UPDATE production_plan_versions
           SET planner_version = ?, planner_rules_version = ?, planner_seed = ?,
               planner_input_fingerprint = ?, planner_output_fingerprint = ?, planner_content_hash = ?,
               planner_trace_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          provenance.plannerVersion,
          provenance.rulesVersion,
          provenance.seed,
          provenance.inputFingerprint,
          provenance.outputFingerprint,
          provenance.contentHash,
          provenance.trace.length > 0 ? encodeJson(provenance.trace) : null,
          now,
          version.id,
        );
      return { version: this.requirePlanVersion(version.id), created: true };
    });
    return transaction.immediate();
  }

  getPlan(id: string): ProductionPlan | null {
    const row = this.db.prepare("SELECT * FROM production_plans WHERE id = ?").get(id) as
      | PlanRow
      | undefined;
    return row ? planFromRow(row) : null;
  }

  listPlans(projectId: string): ProductionPlan[] {
    const rows = this.db.prepare(
      "SELECT * FROM production_plans WHERE project_id = ? ORDER BY created_at, id",
    ).all(projectId) as PlanRow[];
    return rows.map(planFromRow);
  }

  getPlanVersion(id: string): ProductionPlanVersion | null {
    const row = this.db.prepare(
      "SELECT * FROM production_plan_versions WHERE id = ?",
    ).get(id) as PlanVersionRow | undefined;
    return row ? planVersionFromRow(row) : null;
  }

  getPlanVersionByNumber(planId: string, versionNumber: number): ProductionPlanVersion | null {
    const row = this.db.prepare(
      "SELECT * FROM production_plan_versions WHERE plan_id = ? AND version_number = ?",
    ).get(planId, versionNumber) as PlanVersionRow | undefined;
    return row ? planVersionFromRow(row) : null;
  }

  listPlanVersions(planId: string): ProductionPlanVersion[] {
    const rows = this.db.prepare(
      "SELECT * FROM production_plan_versions WHERE plan_id = ? ORDER BY version_number",
    ).all(planId) as PlanVersionRow[];
    return rows.map(planVersionFromRow);
  }

  /** Moves the plan's current pointer. Approved content is never edited, only re-pointed. */
  setPlanCurrentVersion(planId: string, versionId: string, now = new Date().toISOString()): ProductionPlan {
    const transaction = this.db.transaction((): ProductionPlan => {
      const version = this.getPlanVersion(versionId);
      if (!version) throw new Error(`Plan version not found: ${versionId}`);
      if (version.planId !== planId) throw new Error(`Plan version ${versionId} is not a version of ${planId}.`);
      this.db
        .prepare("UPDATE production_plans SET current_version_id = ?, updated_at = ? WHERE id = ?")
        .run(versionId, now, planId);
      return this.requirePlan(planId);
    });
    return transaction.immediate();
  }

  /**
   * Guards the lifecycle edge in core, then applies it with a compare-and-set write so a concurrent
   * transition cannot be silently overwritten (same ownership check as scene/project status).
   */
  transitionPlanVersionStatus(input: {
    planVersionId: string;
    to: PlanVersionStatus;
    now?: string;
    approvedBy?: string;
    approvedValidationId?: string;
    executableProviders?: string[];
  }): ProductionPlanVersion {
    const transaction = this.db.transaction((): ProductionPlanVersion => {
      const now = input.now ?? new Date().toISOString();
      const current = this.getPlanVersion(input.planVersionId);
      if (!current) throw new Error(`Plan version not found: ${input.planVersionId}`);
      if (current.status !== input.to) {
        assertPlanVersionStatusTransition(current.status, input.to, input.planVersionId);
      }
      const patch: string[] = [];
      const values: unknown[] = [];
      patch.push("status = ?", "updated_at = ?");
      values.push(input.to, now);
      if (input.to === "APPROVED") {
        patch.push("approved_by = ?", "approved_at = ?", "approved_validation_id = ?");
        values.push(input.approvedBy ?? null, now, input.approvedValidationId ?? null);
      }
      if (input.to === "EXECUTABLE") {
        patch.push("executable_at = ?", "executable_providers_json = ?");
        values.push(now, encodeJson(input.executableProviders ?? []));
      }
      if (input.to === "DRAFT") {
        // Reopening or revising must not leave a stale approval riding on changed content.
        patch.push(
          "approved_by = NULL",
          "approved_at = NULL",
          "approved_validation_id = NULL",
          "executable_at = NULL",
          "executable_providers_json = NULL",
        );
      }
      values.push(input.planVersionId, current.status);
      const result = this.db
        .prepare(
          `UPDATE production_plan_versions SET ${patch.join(", ")} WHERE id = ? AND status = ?`,
        )
        .run(...values);
      if (result.changes !== 1) {
        throw new Error(`Plan version ${input.planVersionId} status update lost ownership.`);
      }
      return this.requirePlanVersion(input.planVersionId);
    });
    return transaction.immediate();
  }

  /**
   * Copies every child of `sourceVersionId` into a new version of the same plan, atomically. The
   * source keeps its exact content, findings, and hash; `sceneKey` is what links the copies back to
   * their originals across versions.
   */
  copyPlanVersion(input: {
    sourceVersionId: string;
    newVersionId?: string;
    revisionNote?: string;
    now?: string;
  }): { version: ProductionPlanVersion; copiedScenePlans: number; copiedSpecs: number } {
    const transaction = this.db.transaction((): {
      version: ProductionPlanVersion;
      copiedScenePlans: number;
      copiedSpecs: number;
    } => {
      const now = input.now ?? new Date().toISOString();
      const source = this.requirePlanVersion(input.sourceVersionId);
      const nextNumber = (this.db
        .prepare("SELECT MAX(version_number) AS max FROM production_plan_versions WHERE plan_id = ?")
        .get(source.planId) as { max: number | null }).max! + 1;
      const newId = input.newVersionId ?? randomUUID();
      this.db.prepare(
        `INSERT INTO production_plan_versions (
           id, plan_id, version_number, status, content_hash, visual_dna_id, predecessor_version_id,
           revision_note, created_at, updated_at
         ) VALUES (?, ?, ?, 'DRAFT', '', ?, ?, ?, ?, ?)`,
      ).run(
        newId,
        source.planId,
        nextNumber,
        source.visualDnaId ?? null,
        source.id,
        optionalText(input.revisionNote) ?? "",
        now,
        now,
      );

      const story = this.db
        .prepare("SELECT * FROM plan_stories WHERE plan_version_id = ?")
        .get(source.id) as StoryRow | undefined;
      if (story) {
        this.db.prepare(
          `INSERT INTO plan_stories (id, plan_version_id, premise, structure, themes_json, beginning, development, ending, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          newId,
          story.premise,
          story.structure,
          story.themes_json,
          story.beginning,
          story.development,
          story.ending,
          now,
          now,
        );
      }

      const cast = this.db.prepare(
        "SELECT character_id, role FROM plan_version_characters WHERE plan_version_id = ? ORDER BY character_id",
      ).all(source.id) as Array<{ character_id: string; role: string }>;
      for (const link of cast) {
        this.db.prepare(
          "INSERT INTO plan_version_characters (plan_version_id, character_id, role, created_at) VALUES (?, ?, ?, ?)",
        ).run(newId, link.character_id, link.role, now);
      }

      let copiedScenePlans = 0;
      let copiedSpecs = 0;
      const scenePlans = this.db.prepare(
        "SELECT * FROM scene_plans WHERE plan_version_id = ? ORDER BY scene_number, id",
      ).all(source.id) as ScenePlanRow[];
      for (const scenePlan of scenePlans) {
        const newScenePlanId = randomUUID();
        this.db.prepare(
          `INSERT INTO scene_plans (
             id, plan_version_id, scene_key, scene_number, title, narrative_purpose, description,
             duration_target_ms, world_id, visual_dna_id, continuity_json, references_json,
             planned_outputs_json, idempotency_key, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        ).run(
          newScenePlanId,
          newId,
          scenePlan.scene_key,
          scenePlan.scene_number,
          scenePlan.title,
          scenePlan.narrative_purpose,
          scenePlan.description,
          scenePlan.duration_target_ms,
          scenePlan.world_id,
          scenePlan.visual_dna_id,
          scenePlan.continuity_json,
          scenePlan.references_json,
          scenePlan.planned_outputs_json,
          now,
          now,
        );
        copiedScenePlans += 1;

        const sceneCast = this.db.prepare(
          "SELECT character_id, role, position FROM scene_plan_characters WHERE scene_plan_id = ? ORDER BY position, character_id",
        ).all(scenePlan.id) as Array<{ character_id: string; role: string; position: number }>;
        for (const link of sceneCast) {
          this.db.prepare(
            "INSERT INTO scene_plan_characters (scene_plan_id, character_id, role, position, created_at) VALUES (?, ?, ?, ?, ?)",
          ).run(newScenePlanId, link.character_id, link.role, link.position, now);
        }

        const specs = this.db.prepare(
          "SELECT * FROM generation_specs WHERE scene_plan_id = ? ORDER BY spec_number, id",
        ).all(scenePlan.id) as SpecRow[];
        for (const spec of specs) {
          this.db.prepare(
            `INSERT INTO generation_specs (
               id, scene_plan_id, spec_number, kind, instructions, output_count, aspect_ratio,
               duration_ms, references_json, constraints_json, required_capabilities_json,
               requirement_notes, idempotency_key, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          ).run(
            randomUUID(),
            newScenePlanId,
            spec.spec_number,
            spec.kind,
            spec.instructions,
            spec.output_count,
            spec.aspect_ratio,
            spec.duration_ms,
            spec.references_json,
            spec.constraints_json,
            spec.required_capabilities_json,
            spec.requirement_notes,
            now,
          );
          copiedSpecs += 1;
        }
      }

      this.refreshContentHash(newId, now);
      this.db
        .prepare("UPDATE production_plans SET current_version_id = ?, updated_at = ? WHERE id = ?")
        .run(newId, now, source.planId);
      return { version: this.requirePlanVersion(newId), copiedScenePlans, copiedSpecs };
    });
    return transaction.immediate();
  }

  /* --------------------------------- children --------------------------------- */

  upsertStory(input: UpsertStoryInput): PlanStory {
    const transaction = this.db.transaction((): PlanStory => {
      const now = input.now ?? new Date().toISOString();
      const version = this.requireEditableVersion(input.planVersionId);
      const fields = {
        premise: requiredText(input.premise, "Story premise"),
        structure: optionalText(input.structure) ?? "",
        themes: input.themes ?? [],
        beginning: optionalText(input.beginning) ?? "",
        development: optionalText(input.development) ?? "",
        ending: optionalText(input.ending) ?? "",
      };
      const existing = this.db
        .prepare("SELECT id FROM plan_stories WHERE plan_version_id = ?")
        .get(version.id) as { id: string } | undefined;
      if (existing) {
        this.db.prepare(
          "UPDATE plan_stories SET premise = ?, structure = ?, themes_json = ?, beginning = ?, development = ?, ending = ?, updated_at = ? WHERE id = ?",
        ).run(
          fields.premise,
          fields.structure,
          encodeJson(fields.themes),
          fields.beginning,
          fields.development,
          fields.ending,
          now,
          existing.id,
        );
      } else {
        this.db.prepare(
          `INSERT INTO plan_stories (id, plan_version_id, premise, structure, themes_json, beginning, development, ending, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          version.id,
          fields.premise,
          fields.structure,
          encodeJson(fields.themes),
          fields.beginning,
          fields.development,
          fields.ending,
          now,
          now,
        );
      }
      this.refreshContentHash(version.id, now);
      return this.requireStory(version.id);
    });
    return transaction.immediate();
  }

  /** Replaces the version's declared cast. Allowed only while the version is editable. */
  replacePlanCast(input: {
    planVersionId: string;
    cast: readonly PlanCastLink[];
    now?: string;
  }): PlanCastLink[] {
    const transaction = this.db.transaction((): PlanCastLink[] => {
      const now = input.now ?? new Date().toISOString();
      const version = this.requireEditableVersion(input.planVersionId);
      this.db
        .prepare("DELETE FROM plan_version_characters WHERE plan_version_id = ?")
        .run(version.id);
      for (const link of dedupeCast(input.cast)) {
        this.db.prepare(
          "INSERT INTO plan_version_characters (plan_version_id, character_id, role, created_at) VALUES (?, ?, ?, ?)",
        ).run(version.id, link.characterId, link.role, now);
      }
      this.refreshContentHash(version.id, now);
      return this.listPlanCast(version.id);
    });
    return transaction.immediate();
  }

  addScenePlan(input: AddScenePlanInput): { scenePlan: ScenePlan; created: boolean } {
    const transaction = this.db.transaction((): { scenePlan: ScenePlan; created: boolean } => {
      const now = input.now ?? new Date().toISOString();
      const version = this.requireEditableVersion(input.planVersionId);
      const sceneKey = requiredText(input.sceneKey, "Scene key");
      const content = {
        sceneKey,
        sceneNumber: input.sceneNumber,
        title: requiredText(input.title, "Scene plan title"),
        narrativePurpose: optionalText(input.narrativePurpose) ?? "",
        description: optionalText(input.description) ?? "",
        durationTargetMs: input.durationTargetMs ?? null,
        worldId: input.worldId ?? null,
        visualDnaId: input.visualDnaId ?? null,
        continuity: input.continuity ?? [],
        requiredReferences: input.requiredReferences ?? [],
        plannedOutputs: input.plannedOutputs ?? [],
      };
      const idempotencyKey = createPlanningIdempotencyKey(
        stableJson({ planVersionId: version.id, ...content }),
      );
      const duplicate = this.db
        .prepare("SELECT id FROM scene_plans WHERE idempotency_key = ?")
        .get(idempotencyKey) as { id: string } | undefined;
      if (duplicate) return { scenePlan: this.requireScenePlan(duplicate.id), created: false };

      const conflict = this.db.prepare(
        "SELECT id FROM scene_plans WHERE plan_version_id = ? AND (scene_key = ? OR scene_number = ?)",
      ).get(version.id, sceneKey, input.sceneNumber) as { id: string } | undefined;
      if (conflict) {
        throw new ScenePlanConflictError(version.id, sceneKey, input.sceneNumber);
      }

      const id = input.id ?? randomUUID();
      this.db.prepare(
        `INSERT INTO scene_plans (
           id, plan_version_id, scene_key, scene_number, title, narrative_purpose, description,
           duration_target_ms, world_id, visual_dna_id, continuity_json, references_json,
           planned_outputs_json, idempotency_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        version.id,
        sceneKey,
        input.sceneNumber,
        content.title,
        content.narrativePurpose,
        content.description,
        content.durationTargetMs,
        content.worldId,
        content.visualDnaId,
        encodeJson(content.continuity),
        encodeJson(content.requiredReferences),
        encodeJson(content.plannedOutputs),
        idempotencyKey,
        now,
        now,
      );
      if (input.cast && input.cast.length > 0) {
        this.applyScenePlanCast(id, input.cast, now);
      }
      this.refreshContentHash(version.id, now);
      return { scenePlan: this.requireScenePlan(id), created: true };
    });
    return transaction.immediate();
  }

  updateScenePlan(input: UpdateScenePlanInput): ScenePlan {
    const transaction = this.db.transaction((): ScenePlan => {
      const now = input.now ?? new Date().toISOString();
      const current = this.requireScenePlan(input.scenePlanId);
      const version = this.requireEditableVersion(current.planVersionId);
      const patch = input.patch ?? {};
      const next = {
        sceneNumber: patch.sceneNumber ?? current.sceneNumber,
        title: patch.title === undefined ? current.title : requiredText(patch.title, "Scene plan title"),
        narrativePurpose:
          patch.narrativePurpose === undefined ? current.narrativePurpose : patch.narrativePurpose,
        description: patch.description === undefined ? current.description : patch.description,
        durationTargetMs:
          patch.durationTargetMs === undefined ? current.durationTargetMs : patch.durationTargetMs,
        worldId: patch.worldId === undefined ? current.worldId : patch.worldId,
        visualDnaId:
          patch.visualDnaId === undefined ? current.visualDnaId : patch.visualDnaId,
        continuity: patch.continuity ?? current.continuity,
        requiredReferences: patch.requiredReferences ?? current.requiredReferences,
        plannedOutputs: patch.plannedOutputs ?? current.plannedOutputs,
      };
      if (next.sceneNumber !== current.sceneNumber) {
        const clash = this.db.prepare(
          "SELECT id FROM scene_plans WHERE plan_version_id = ? AND scene_number = ? AND id <> ?",
        ).get(version.id, next.sceneNumber, current.id) as { id: string } | undefined;
        if (clash) {
          throw new Error(
            `Scene number ${next.sceneNumber} is already used by scene plan ${clash.id} in this version.`,
          );
        }
      }
      this.db.prepare(
        `UPDATE scene_plans SET scene_number = ?, title = ?, narrative_purpose = ?, description = ?,
           duration_target_ms = ?, world_id = ?, visual_dna_id = ?, continuity_json = ?,
           references_json = ?, planned_outputs_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        next.sceneNumber,
        next.title,
        next.narrativePurpose,
        next.description,
        next.durationTargetMs ?? null,
        next.worldId ?? null,
        next.visualDnaId ?? null,
        encodeJson(next.continuity),
        encodeJson(next.requiredReferences),
        encodeJson(next.plannedOutputs),
        now,
        current.id,
      );
      if (input.cast !== undefined) this.applyScenePlanCast(current.id, input.cast, now);
      this.refreshContentHash(version.id, now);
      return this.requireScenePlan(current.id);
    });
    return transaction.immediate();
  }

  deleteScenePlan(input: { scenePlanId: string; now?: string }): void {
    const transaction = this.db.transaction((): void => {
      const now = input.now ?? new Date().toISOString();
      const scenePlan = this.requireScenePlan(input.scenePlanId);
      const version = this.requireEditableVersion(scenePlan.planVersionId);
      // Only the row being retracted is removed; specs and cast links follow via ON DELETE CASCADE.
      this.db.prepare("DELETE FROM scene_plans WHERE id = ?").run(scenePlan.id);
      this.refreshContentHash(version.id, now);
    });
    transaction.immediate();
  }

  replaceScenePlanCast(input: {
    scenePlanId: string;
    cast: readonly ScenePlanCastInput[];
    now?: string;
  }): ScenePlanCastLink[] {
    const transaction = this.db.transaction((): ScenePlanCastLink[] => {
      const now = input.now ?? new Date().toISOString();
      const scenePlan = this.requireScenePlan(input.scenePlanId);
      const version = this.requireEditableVersion(scenePlan.planVersionId);
      this.applyScenePlanCast(scenePlan.id, input.cast, now);
      this.refreshContentHash(version.id, now);
      return this.listScenePlanCast(scenePlan.id);
    });
    return transaction.immediate();
  }

  addGenerationSpec(input: AddGenerationSpecInput): { spec: GenerationSpec; created: boolean } {
    const transaction = this.db.transaction((): { spec: GenerationSpec; created: boolean } => {
      const now = input.now ?? new Date().toISOString();
      const scenePlan = this.requireScenePlan(input.scenePlanId);
      const version = this.requireEditableVersion(scenePlan.planVersionId);
      const content = {
        kind: input.kind,
        instructions: requiredText(input.instructions, "Generation spec instructions"),
        outputCount: input.outputCount ?? 1,
        aspectRatio: optionalText(input.aspectRatio) ?? null,
        durationMs: input.durationMs ?? null,
        references: input.references ?? [],
        constraints: input.constraints ?? [],
        capabilities: input.requiredCapabilities ?? [],
        requirementNotes: optionalText(input.requirementNotes) ?? "",
      };
      const idempotencyKey = createPlanningIdempotencyKey(
        stableJson({ scenePlanId: scenePlan.id, ...content }),
      );
      const duplicate = this.db
        .prepare("SELECT id FROM generation_specs WHERE idempotency_key = ?")
        .get(idempotencyKey) as { id: string } | undefined;
      if (duplicate) {
        return { spec: this.requireGenerationSpec(duplicate.id), created: false };
      }
      const specNumber =
        input.specNumber ??
        ((this.db
          .prepare(
            "SELECT MAX(spec_number) AS max FROM generation_specs WHERE scene_plan_id = ?",
          )
          .get(scenePlan.id) as { max: number | null }).max ?? 0) + 1;

      const id = input.id ?? randomUUID();
      this.db.prepare(
        `INSERT INTO generation_specs (
           id, scene_plan_id, spec_number, kind, instructions, output_count, aspect_ratio, duration_ms,
           references_json, constraints_json, required_capabilities_json, requirement_notes,
           idempotency_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        scenePlan.id,
        specNumber,
        content.kind,
        content.instructions,
        content.outputCount,
        content.aspectRatio,
        content.durationMs,
        encodeJson(content.references),
        encodeJson(content.constraints),
        encodeJson(content.capabilities),
        content.requirementNotes,
        idempotencyKey,
        now,
      );
      this.refreshContentHash(version.id, now);
      return { spec: this.requireGenerationSpec(id), created: true };
    });
    return transaction.immediate();
  }

  deleteGenerationSpec(input: { specId: string; now?: string }): void {
    const transaction = this.db.transaction((): void => {
      const now = input.now ?? new Date().toISOString();
      const spec = this.requireGenerationSpec(input.specId);
      const scenePlan = this.requireScenePlan(spec.scenePlanId);
      const version = this.requireEditableVersion(scenePlan.planVersionId);
      this.db.prepare("DELETE FROM generation_specs WHERE id = ?").run(spec.id);
      this.refreshContentHash(version.id, now);
    });
    transaction.immediate();
  }

  /* -------------------------------- validation -------------------------------- */

  /**
   * Appends validation evidence for the version's current content. Re-validating unchanged content
   * reuses the recorded row, so repeated `plan validate` calls are idempotent.
   */
  recordPlanValidation(input: RecordPlanValidationInput): {
    validation: PlanValidationRecord;
    created: boolean;
  } {
    const transaction = this.db.transaction((): {
      validation: PlanValidationRecord;
      created: boolean;
    } => {
      const now = input.now ?? new Date().toISOString();
      const version = this.requirePlanVersion(input.planVersionId);
      const errorCount = input.findings.filter((finding) => finding.severity === "ERROR").length;
      const warningCount = input.findings.length - errorCount;
      const identity = stableJson({
        planVersionId: version.id,
        validatorVersion: input.validatorVersion,
        contentHash: input.contentHash,
      });
      void identity;
      const existing = this.db
        .prepare("SELECT id FROM plan_validations WHERE plan_version_id = ? AND validator_version = ? AND content_hash = ?")
        .get(version.id, input.validatorVersion, input.contentHash) as { id: string } | undefined;
      if (existing) return { validation: this.requireValidation(existing.id), created: false };

      const id = input.id ?? randomUUID();
      this.db.prepare(
        `INSERT INTO plan_validations (
           id, plan_version_id, validator_version, status, content_hash, findings_json,
           error_count, warning_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        version.id,
        input.validatorVersion,
        input.status,
        input.contentHash,
        encodeJson(input.findings),
        errorCount,
        warningCount,
        now,
      );
      return { validation: this.requireValidation(id), created: true };
    });
    return transaction.immediate();
  }

  /**
   * Evidence rows are append-only, so recency is insertion order (`rowid`), never the random id:
   * two validations recorded in the same millisecond — or under a fixed test clock — must still rank
   * deterministically, because approval and staleness are decided by the row this query returns.
   */
  getLatestPlanValidation(planVersionId: string): PlanValidationRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM plan_validations WHERE plan_version_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(planVersionId) as ValidationRow | undefined;
    return row ? validationFromRow(row) : null;
  }

  getPlanValidation(id: string): PlanValidationRecord | null {
    const row = this.db.prepare("SELECT * FROM plan_validations WHERE id = ?").get(id) as
      | ValidationRow
      | undefined;
    return row ? validationFromRow(row) : null;
  }

  listPlanValidations(planVersionId: string): PlanValidationRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM plan_validations WHERE plan_version_id = ? ORDER BY created_at, rowid",
    ).all(planVersionId) as ValidationRow[];
    return rows.map(validationFromRow);
  }

  /* ------------------------------ aggregate reads ------------------------------ */

  /** One read of the whole version aggregate; the deterministic validator works from this value. */
  loadPlanVersionSnapshot(planVersionId: string): PlanVersionSnapshot | null {
    const versionRow = this.db
      .prepare("SELECT * FROM production_plan_versions WHERE id = ?")
      .get(planVersionId) as PlanVersionRow | undefined;
    if (!versionRow) return null;
    const version = planVersionFromRow(versionRow);
    const plan = this.requirePlan(version.planId);
    const storyRow = this.db
      .prepare("SELECT * FROM plan_stories WHERE plan_version_id = ?")
      .get(version.id) as StoryRow | undefined;
    const scenePlanRows = this.db.prepare(
      "SELECT * FROM scene_plans WHERE plan_version_id = ? ORDER BY scene_number, id",
    ).all(version.id) as ScenePlanRow[];
    const castStatement = this.db.prepare(
      "SELECT character_id, role, position FROM scene_plan_characters WHERE scene_plan_id = ? ORDER BY position, character_id",
    );
    const specStatement = this.db.prepare(
      "SELECT * FROM generation_specs WHERE scene_plan_id = ? ORDER BY spec_number, id",
    );
    const versionSpecs = this.db.prepare(
      `SELECT gs.* FROM generation_specs gs
         JOIN scene_plans sp ON sp.id = gs.scene_plan_id
        WHERE sp.plan_version_id = ?
        ORDER BY gs.id`,
    ).all(version.id) as SpecRow[];
    return {
      projectId: plan.projectId,
      plan,
      version,
      brief: this.getBrief(plan.briefId),
      story: storyRow ? storyFromRow(storyRow) : null,
      cast: this.listPlanCast(version.id),
      characters: this.listProjectCharacters(plan.projectId),
      worlds: this.listWorlds(plan.projectId),
      visualDna: this.listVisualDna(plan.projectId),
      scenePlans: scenePlanRows.map((row) => ({
        scenePlan: scenePlanFromRow(row),
        cast: (castStatement.all(row.id) as Array<{
          character_id: string;
          role: string;
          position: number;
        }>).map((link) => ({
          characterId: link.character_id,
          role: link.role,
          position: link.position,
        })),
        specs: (specStatement.all(row.id) as SpecRow[]).map(specFromRow),
      })),
      specs: versionSpecs.map(specFromRow),
    };
  }

  /** Single-row lookups used when a command addresses a child directly instead of by plan. */
  getScenePlan(id: string): ScenePlan | null {
    const row = this.db.prepare("SELECT * FROM scene_plans WHERE id = ?").get(id) as
      | ScenePlanRow
      | undefined;
    return row ? scenePlanFromRow(row) : null;
  }

  getGenerationSpec(id: string): GenerationSpec | null {
    const row = this.db.prepare("SELECT * FROM generation_specs WHERE id = ?").get(id) as
      | SpecRow
      | undefined;
    return row ? specFromRow(row) : null;
  }

  /** Canonical hash of everything a version contains, used for staleness detection. */
  planVersionContentHash(planVersionId: string): string {
    return computeContentHash(this.readContent(planVersionId));
  }

  /* -------------------------------- internals -------------------------------- */

  private refreshContentHash(planVersionId: string, now: string): void {
    this.db
      .prepare("UPDATE production_plan_versions SET content_hash = ?, updated_at = ? WHERE id = ?")
      .run(this.planVersionContentHash(planVersionId), now, planVersionId);
  }

  private readContent(planVersionId: string): unknown {
    const version = this.requirePlanVersion(planVersionId);
    const storyRow = this.db
      .prepare("SELECT * FROM plan_stories WHERE plan_version_id = ?")
      .get(version.id) as StoryRow | undefined;
    const scenePlanRows = this.db.prepare(
      "SELECT * FROM scene_plans WHERE plan_version_id = ? ORDER BY scene_number, id",
    ).all(version.id) as ScenePlanRow[];
    return {
      visualDnaId: version.visualDnaId ?? null,
      story: storyRow
        ? {
            premise: storyRow.premise,
            structure: storyRow.structure,
            themes: decodeJson<string[]>(storyRow.themes_json, []),
            beginning: storyRow.beginning,
            development: storyRow.development,
            ending: storyRow.ending,
          }
        : null,
      cast: this.db
        .prepare(
          "SELECT character_id, role FROM plan_version_characters WHERE plan_version_id = ? ORDER BY character_id",
        )
        .all(version.id)
        .map((raw) => {
          const row = raw as { character_id: string; role: string };
          return { characterId: row.character_id, role: row.role };
        }),
      scenePlans: scenePlanRows.map((row) => ({
        sceneKey: row.scene_key,
        sceneNumber: row.scene_number,
        title: row.title,
        narrativePurpose: row.narrative_purpose,
        description: row.description,
        durationTargetMs: row.duration_target_ms,
        worldId: row.world_id,
        visualDnaId: row.visual_dna_id,
        continuity: decodeJson<ScenePlanContinuity[]>(row.continuity_json, []),
        requiredReferences: decodeJson<PlanningReference[]>(row.references_json, []),
        plannedOutputs: decodeJson<PlannedOutput[]>(row.planned_outputs_json, []),
        cast: this.db
          .prepare(
            "SELECT character_id, role, position FROM scene_plan_characters WHERE scene_plan_id = ? ORDER BY position, character_id",
          )
          .all(row.id)
          .map((raw) => {
            const link = raw as { character_id: string; role: string; position: number };
            return { characterId: link.character_id, role: link.role, position: link.position };
          }),
        specs: this.db
          .prepare(
            "SELECT * FROM generation_specs WHERE scene_plan_id = ? ORDER BY spec_number, id",
          )
          .all(row.id)
          .map((raw) => hashableSpec(raw as SpecRow)),
      })),
    };
  }

  private requireEditableVersion(planVersionId: string): ProductionPlanVersion {
    const version = this.requirePlanVersion(planVersionId);
    if (version.status !== "DRAFT" && version.status !== "VALIDATED") {
      throw new PlanVersionNotEditableError(planVersionId, version.status);
    }
    return version;
  }

  private applyScenePlanCast(
    scenePlanId: string,
    cast: readonly ScenePlanCastInput[],
    now: string,
  ): void {
    this.db
      .prepare("DELETE FROM scene_plan_characters WHERE scene_plan_id = ?")
      .run(scenePlanId);
    // Positions are renumbered sequentially after ordering by any caller-supplied position, so the
    // UNIQUE(scene_plan_id, position) constraint can never collide on a legitimate cast edit.
    let position = 0;
    for (const link of dedupeSceneCast(cast)) {
      this.db.prepare(
        "INSERT INTO scene_plan_characters (scene_plan_id, character_id, role, position, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(scenePlanId, link.characterId, link.role, position, now);
      position += 1;
    }
  }

  private listPlanCast(planVersionId: string): PlanCastLink[] {
    const rows = this.db.prepare(
      "SELECT character_id, role FROM plan_version_characters WHERE plan_version_id = ? ORDER BY character_id",
    ).all(planVersionId) as Array<{ character_id: string; role: string }>;
    return rows.map((row) => ({ characterId: row.character_id, role: row.role }));
  }

  private listScenePlanCast(scenePlanId: string): ScenePlanCastLink[] {
    const rows = this.db.prepare(
      "SELECT character_id, role, position FROM scene_plan_characters WHERE scene_plan_id = ? ORDER BY position, character_id",
    ).all(scenePlanId) as Array<{ character_id: string; role: string; position: number }>;
    return rows.map((row) => ({
      characterId: row.character_id,
      role: row.role,
      position: row.position,
    }));
  }

  private activeWorldId(projectId: string, name: string): string | null {
    const row = this.db
      .prepare("SELECT id FROM worlds WHERE project_id = ? AND name = ? AND status = 'ACTIVE' ORDER BY version_number DESC LIMIT 1")
      .get(projectId, name) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private activeVisualDnaId(projectId: string, name: string): string | null {
    const row = this.db
      .prepare("SELECT id FROM visual_dna WHERE project_id = ? AND name = ? AND status = 'ACTIVE' ORDER BY version_number DESC LIMIT 1")
      .get(projectId, name) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private firstVersionId(planId: string): string {
    const row = this.db
      .prepare("SELECT id FROM production_plan_versions WHERE plan_id = ? ORDER BY version_number LIMIT 1")
      .get(planId) as { id: string } | undefined;
    if (!row) throw new Error(`Production plan ${planId} has no versions.`);
    return row.id;
  }

  private requireBrief(id: string): CreativeBrief {
    const brief = this.getBrief(id);
    if (!brief) throw new Error(`Creative brief not found: ${id}`);
    return brief;
  }

  private requireWorld(id: string): WorldDefinition {
    const world = this.getWorld(id);
    if (!world) throw new Error(`World definition not found: ${id}`);
    return world;
  }

  private requireVisualDna(id: string): VisualDnaDefinition {
    const dna = this.getVisualDna(id);
    if (!dna) throw new Error(`Visual DNA definition not found: ${id}`);
    return dna;
  }

  private requireCharacter(id: string): PlanningCharacterRecord {
    const character = this.getCharacter(id);
    if (!character) throw new Error(`Character not found: ${id}`);
    return character;
  }

  private requirePlan(id: string): ProductionPlan {
    const plan = this.getPlan(id);
    if (!plan) throw new Error(`Production plan not found: ${id}`);
    return plan;
  }

  private requirePlanVersion(id: string): ProductionPlanVersion {
    const version = this.getPlanVersion(id);
    if (!version) throw new Error(`Plan version not found: ${id}`);
    return version;
  }

  private requireStory(planVersionId: string): PlanStory {
    const row = this.db
      .prepare("SELECT * FROM plan_stories WHERE plan_version_id = ?")
      .get(planVersionId) as StoryRow | undefined;
    if (!row) throw new Error(`Plan story not found for version: ${planVersionId}`);
    return storyFromRow(row);
  }

  private requireScenePlan(id: string): ScenePlan {
    const row = this.db.prepare("SELECT * FROM scene_plans WHERE id = ?").get(id) as
      | ScenePlanRow
      | undefined;
    if (!row) throw new Error(`Scene plan not found: ${id}`);
    return scenePlanFromRow(row);
  }

  private requireGenerationSpec(id: string): GenerationSpec {
    const row = this.db.prepare("SELECT * FROM generation_specs WHERE id = ?").get(id) as
      | SpecRow
      | undefined;
    if (!row) throw new Error(`Generation spec not found: ${id}`);
    return specFromRow(row);
  }

  private requireValidation(id: string): PlanValidationRecord {
    const row = this.db.prepare("SELECT * FROM plan_validations WHERE id = ?").get(id) as
      | ValidationRow
      | undefined;
    if (!row) throw new Error(`Plan validation not found: ${id}`);
    return validationFromRow(row);
  }
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreateBriefInput {
  id?: string;
  projectId: string;
  title: string;
  concept?: string;
  objective?: string;
  audience?: string;
  tone?: string;
  style?: string;
  constraints?: CreativeBriefConstraint[];
  now?: string;
}

export interface CreateWorldInput {
  id?: string;
  projectId: string;
  name: string;
  description?: string;
  environment?: string;
  rules?: string[];
  visualIdentity?: WorldVisualIdentity;
  now?: string;
}

export interface CreateVisualDnaInput {
  id?: string;
  projectId: string;
  name: string;
  description?: string;
  style: string;
  palette?: string[];
  lighting?: string;
  composition?: string;
  cameraLanguage?: string;
  renderingStyle?: string;
  atmosphere?: string;
  consistencyRules?: string[];
  now?: string;
}

export interface SetCharacterIdentityInput {
  characterId: string;
  traits?: CharacterTraits;
  visualIdentity?: CharacterVisualIdentity;
  now?: string;
}

export interface CreatePlanInput {
  id?: string;
  versionId?: string;
  projectId: string;
  briefId: string;
  title: string;
  visualDnaId?: string;
  now?: string;
}

export interface CreatePlanVersionInput {
  id?: string;
  planId: string;
  /** Lineage for a re-plan; the version content is authored fresh, not copied. */
  predecessorVersionId?: string;
  visualDnaId?: string;
  note?: string;
  now?: string;
}

export interface SetPlanProvenanceInput {
  planVersionId: string;
  provenance: PlanProvenance;
  now?: string;
}

export interface UpsertStoryInput {
  planVersionId: string;
  premise: string;
  structure?: string;
  themes?: string[];
  beginning?: string;
  development?: string;
  ending?: string;
  now?: string;
}

export interface AddScenePlanInput {
  id?: string;
  planVersionId: string;
  sceneKey: string;
  sceneNumber: number;
  title: string;
  narrativePurpose?: string;
  description?: string;
  durationTargetMs?: number;
  worldId?: string;
  visualDnaId?: string;
  continuity?: ScenePlanContinuity[];
  requiredReferences?: PlanningReference[];
  plannedOutputs?: PlannedOutput[];
  cast?: ScenePlanCastInput[];
  now?: string;
}

export interface UpdateScenePlanInput {
  scenePlanId: string;
  patch?: {
    sceneNumber?: number;
    title?: string;
    narrativePurpose?: string;
    description?: string;
    durationTargetMs?: number | null;
    worldId?: string | null;
    visualDnaId?: string | null;
    continuity?: ScenePlanContinuity[];
    requiredReferences?: PlanningReference[];
    plannedOutputs?: PlannedOutput[];
  };
  cast?: ScenePlanCastInput[];
  now?: string;
}

export interface AddGenerationSpecInput {
  id?: string;
  scenePlanId: string;
  specNumber?: number;
  kind: GenerationSpecKind;
  instructions: string;
  outputCount?: number;
  aspectRatio?: string;
  durationMs?: number;
  references?: PlanningReference[];
  constraints?: string[];
  requiredCapabilities?: ProviderCapabilityKey[];
  requirementNotes?: string;
  now?: string;
}

export interface RecordPlanValidationInput {
  id?: string;
  planVersionId: string;
  validatorVersion: string;
  status: PlanValidationStatus;
  contentHash: string;
  findings: PlanningFinding[];
  now?: string;
}

/** Raised when a scene key or scene number is already taken inside the same plan version. */
export class ScenePlanConflictError extends Error {
  readonly planVersionId: string;
  readonly sceneKey: string;
  readonly sceneNumber: number;

  constructor(planVersionId: string, sceneKey: string, sceneNumber: number) {
    super(
      `Scene plan "${sceneKey}" conflicts with an existing scene plan at position ${sceneNumber} of plan version ${planVersionId}.`,
    );
    this.name = "ScenePlanConflictError";
    this.planVersionId = planVersionId;
    this.sceneKey = sceneKey;
    this.sceneNumber = sceneNumber;
  }
}

/** Raised by the repository when a version's status forbids the edit; services translate it. */
export class PlanVersionNotEditableError extends Error {
  readonly planVersionId: string;
  readonly status: PlanVersionStatus;

  constructor(planVersionId: string, status: PlanVersionStatus) {
    super(`Plan version ${planVersionId} is ${status} and cannot be edited in place.`);
    this.name = "PlanVersionNotEditableError";
    this.planVersionId = planVersionId;
    this.status = status;
  }
}

/* -------------------------------------------------------------------------- */
/* Rows and mappers                                                            */
/* -------------------------------------------------------------------------- */

interface BriefRow {
  id: string;
  project_id: string;
  version_number: number;
  supersedes_brief_id: string | null;
  title: string;
  concept: string;
  objective: string;
  audience: string;
  tone: string;
  style: string;
  constraints_json: string;
  status: CreativeBrief["status"];
  content_hash: string;
  idempotency_key: string | null;
  created_at: string;
}

interface WorldRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  environment: string;
  rules_json: string;
  visual_identity_json: string;
  version_number: number;
  supersedes_world_id: string | null;
  status: WorldDefinition["status"];
  content_hash: string;
  idempotency_key: string | null;
  created_at: string;
}

interface VisualDnaRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  style: string;
  palette_json: string;
  lighting: string;
  composition: string;
  camera_language: string;
  rendering_style: string;
  atmosphere: string;
  consistency_rules_json: string;
  version_number: number;
  supersedes_dna_id: string | null;
  status: VisualDnaDefinition["status"];
  content_hash: string;
  idempotency_key: string | null;
  created_at: string;
}

interface PlanningCharacterRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  metadata_json: string | null;
  traits_json: string | null;
  visual_identity_json: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanRow {
  id: string;
  project_id: string;
  brief_id: string;
  title: string;
  current_version_id: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanVersionRow {
  id: string;
  plan_id: string;
  version_number: number;
  status: PlanVersionStatus;
  content_hash: string;
  visual_dna_id: string | null;
  predecessor_version_id: string | null;
  revision_note: string;
  approved_by: string | null;
  approved_at: string | null;
  approved_validation_id: string | null;
  executable_at: string | null;
  executable_providers_json: string | null;
  planner_version: string | null;
  planner_rules_version: string | null;
  planner_seed: number | null;
  planner_input_fingerprint: string | null;
  planner_output_fingerprint: string | null;
  planner_content_hash: string | null;
  planner_trace_json: string | null;
  created_at: string;
  updated_at: string;
}

interface StoryRow {
  id: string;
  plan_version_id: string;
  premise: string;
  structure: string;
  themes_json: string;
  beginning: string;
  development: string;
  ending: string;
  created_at: string;
  updated_at: string;
}

interface ScenePlanRow {
  id: string;
  plan_version_id: string;
  scene_key: string;
  scene_number: number;
  title: string;
  narrative_purpose: string;
  description: string;
  duration_target_ms: number | null;
  world_id: string | null;
  visual_dna_id: string | null;
  continuity_json: string;
  references_json: string;
  planned_outputs_json: string;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

interface SpecRow {
  id: string;
  scene_plan_id: string;
  spec_number: number;
  kind: GenerationSpecKind;
  instructions: string;
  output_count: number;
  aspect_ratio: string | null;
  duration_ms: number | null;
  references_json: string;
  constraints_json: string;
  required_capabilities_json: string;
  requirement_notes: string;
  idempotency_key: string | null;
  created_at: string;
}

interface ValidationRow {
  id: string;
  plan_version_id: string;
  validator_version: string;
  status: PlanValidationStatus;
  content_hash: string;
  findings_json: string;
  error_count: number;
  warning_count: number;
  created_at: string;
}

function briefFromRow(row: BriefRow): CreativeBrief {
  return {
    id: row.id,
    projectId: row.project_id,
    versionNumber: row.version_number,
    title: row.title,
    concept: row.concept,
    objective: row.objective,
    audience: row.audience,
    tone: row.tone,
    style: row.style,
    constraints: decodeJson<CreativeBriefConstraint[]>(row.constraints_json, []),
    status: row.status,
    supersedesBriefId: row.supersedes_brief_id ?? undefined,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

function worldFromRow(row: WorldRow): WorldDefinition {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    environment: row.environment,
    rules: decodeJson<string[]>(row.rules_json, []),
    visualIdentity: decodeJson<WorldVisualIdentity>(row.visual_identity_json, {
      description: "",
      palette: [],
      lighting: "",
    }),
    versionNumber: row.version_number,
    status: row.status,
    supersedesWorldId: row.supersedes_world_id ?? undefined,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

function visualDnaFromRow(row: VisualDnaRow): VisualDnaDefinition {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    style: row.style,
    palette: decodeJson<string[]>(row.palette_json, []),
    lighting: row.lighting,
    composition: row.composition,
    cameraLanguage: row.camera_language,
    renderingStyle: row.rendering_style,
    atmosphere: row.atmosphere,
    consistencyRules: decodeJson<string[]>(row.consistency_rules_json, []),
    versionNumber: row.version_number,
    status: row.status,
    supersedesDnaId: row.supersedes_dna_id ?? undefined,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

function characterFromRow(row: PlanningCharacterRow): PlanningCharacterRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description ?? undefined,
    metadata: row.metadata_json
      ? decodeJson<Record<string, unknown>>(row.metadata_json, {})
      : undefined,
    traits: row.traits_json ? decodeJson<CharacterTraits>(row.traits_json, { appearance: "", personality: "" }) : undefined,
    visualIdentity: row.visual_identity_json
      ? decodeJson<CharacterVisualIdentity>(row.visual_identity_json, {
          description: "",
          distinguishingFeatures: [],
          palette: [],
        })
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function planFromRow(row: PlanRow): ProductionPlan {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    briefId: row.brief_id,
    currentVersionId: row.current_version_id ?? undefined,
    idempotencyKey: row.idempotency_key ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function planVersionFromRow(row: PlanVersionRow): ProductionPlanVersion {
  return {
    id: row.id,
    planId: row.plan_id,
    versionNumber: row.version_number,
    status: row.status,
    contentHash: row.content_hash,
    visualDnaId: row.visual_dna_id ?? undefined,
    predecessorVersionId: row.predecessor_version_id ?? undefined,
    revisionNote: row.revision_note === "" ? undefined : row.revision_note,
    approvedBy: row.approved_by ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    approvedValidationId: row.approved_validation_id ?? undefined,
    executableAt: row.executable_at ?? undefined,
    executableProviders: row.executable_providers_json
      ? decodeJson<string[]>(row.executable_providers_json, [])
      : undefined,
    plannerVersion: row.planner_version ?? undefined,
    plannerRulesVersion: row.planner_rules_version ?? undefined,
    plannerSeed: row.planner_seed ?? undefined,
    plannerInputFingerprint: row.planner_input_fingerprint ?? undefined,
    plannerOutputFingerprint: row.planner_output_fingerprint ?? undefined,
    plannerContentHash: row.planner_content_hash ?? undefined,
    plannerTrace: row.planner_trace_json
      ? decodeJson<PlannerTraceStep[]>(row.planner_trace_json, [])
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function storyFromRow(row: StoryRow): PlanStory {
  return {
    id: row.id,
    planVersionId: row.plan_version_id,
    premise: row.premise,
    structure: row.structure,
    themes: decodeJson<string[]>(row.themes_json, []),
    beginning: row.beginning,
    development: row.development,
    ending: row.ending,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function scenePlanFromRow(row: ScenePlanRow): ScenePlan {
  return {
    id: row.id,
    planVersionId: row.plan_version_id,
    sceneKey: row.scene_key,
    sceneNumber: row.scene_number,
    title: row.title,
    narrativePurpose: row.narrative_purpose,
    description: row.description,
    durationTargetMs: row.duration_target_ms ?? undefined,
    worldId: row.world_id ?? undefined,
    visualDnaId: row.visual_dna_id ?? undefined,
    continuity: decodeJson<ScenePlanContinuity[]>(row.continuity_json, []),
    requiredReferences: decodeJson<PlanningReference[]>(row.references_json, []),
    plannedOutputs: decodeJson<PlannedOutput[]>(row.planned_outputs_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function specFromRow(row: SpecRow): GenerationSpec {
  return {
    id: row.id,
    scenePlanId: row.scene_plan_id,
    specNumber: row.spec_number,
    kind: row.kind,
    instructions: row.instructions,
    outputCount: row.output_count,
    aspectRatio: row.aspect_ratio ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    references: decodeJson<PlanningReference[]>(row.references_json, []),
    constraints: decodeJson<string[]>(row.constraints_json, []),
    providerRequirements: {
      capabilities: decodeJson<ProviderCapabilityKey[]>(row.required_capabilities_json, []),
      notes: row.requirement_notes === "" ? undefined : row.requirement_notes,
    },
    createdAt: row.created_at,
  };
}

function validationFromRow(row: ValidationRow): PlanValidationRecord {
  const findings = decodeJson<PlanningFinding[]>(row.findings_json, []);
  return {
    id: row.id,
    planVersionId: row.plan_version_id,
    validatorVersion: row.validator_version,
    status: row.status,
    contentHash: row.content_hash,
    findings,
    errorCount: row.error_count,
    warningCount: row.warning_count,
    createdAt: row.created_at,
  };
}

function hashableSpec(row: SpecRow): unknown {
  return {
    specNumber: row.spec_number,
    kind: row.kind,
    instructions: row.instructions,
    outputCount: row.output_count,
    aspectRatio: row.aspect_ratio,
    durationMs: row.duration_ms,
    references: decodeJson<PlanningReference[]>(row.references_json, []),
    constraints: decodeJson<string[]>(row.constraints_json, []),
    requiredCapabilities: decodeJson<ProviderCapabilityKey[]>(row.required_capabilities_json, []),
    requirementNotes: row.requirement_notes,
  };
}

function computeContentHash(content: unknown): string {
  return createPlanningContentHash(content);
}

function dedupeCast(cast: readonly PlanCastLink[]): PlanCastLink[] {
  const byId = new Map<string, PlanCastLink>();
  for (const link of [...cast].sort((left, right) =>
    left.characterId === right.characterId
      ? left.role.localeCompare(right.role)
      : left.characterId.localeCompare(right.characterId),
  )) {
    byId.set(link.characterId, {
      characterId: link.characterId,
      role: optionalText(link.role) ?? "",
    });
  }
  return [...byId.values()];
}

export interface ScenePlanCastInput {
  characterId: string;
  role?: string;
  position?: number;
}

function dedupeSceneCast(
  cast: readonly ScenePlanCastInput[],
): Array<{ characterId: string; role: string; position?: number }> {
  const byId = new Map<string, { characterId: string; role: string; position?: number }>();
  for (const link of cast) {
    byId.set(link.characterId, {
      characterId: link.characterId,
      role: optionalText(link.role) ?? "",
      position: link.position,
    });
  }
  return [...byId.values()].sort(
    (left, right) => (left.position ?? 0) - (right.position ?? 0) ||
      left.characterId.localeCompare(right.characterId),
  );
}

function assertProjectExists(db: Database.Database, projectId: string): void {
  const row = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as
    | { id: string }
    | undefined;
  if (!row) throw new Error(`Project not found: ${projectId}`);
}
