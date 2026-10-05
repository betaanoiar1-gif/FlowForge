import { fingerprintJson } from "@flowforge/core";
import { PLANNER_ID_NAMESPACE } from "../planner/types.js";

/**
 * Digests of an AI planning attempt.
 *
 * Three separate fingerprints, because three different questions get asked of them:
 *
 *   - *what did we ask?*  `requestFingerprint`, over the planning context the adapter received. It never
 *     contains a prompt, a credential, an endpoint, or a header — only the data the port is allowed to
 *     carry — so it can be persisted and printed without a privacy review each time.
 *   - *what did the model answer?*  `responseFingerprint`, over the raw response bytes. It is the audit
 *     handle for a nondeterministic producer: a plan can be re-checked against the exact response that
 *     produced it without FlowForge storing the response, and a digest of an empty or failed response is
 *     simply absent.
 *   - *what did the domain accept?*  `proposalFingerprint`, over the validated, tidied proposal. Two AI
 *     calls whose answers differ in wording but not in accepted content still differ here (content is
 *     content), while a byte-identical proposal repeats identically — which is what lets the existing
 *     Phase 4B reuse recognise the second run as the same plan.
 *
 * None of them feeds the deterministic planner's input fingerprint, so an adapter's identity can never
 * change a plan's content: the fingerprints below describe the *route*, and `PlannerInput` describes the
 * *content*.
 */
export const AI_REQUEST_FINGERPRINT_NAMESPACE = "flowforge:ai-planner-request:v1";
export const AI_PROPOSAL_FINGERPRINT_NAMESPACE = "flowforge:ai-planner-proposal:v1";
export const AI_RESPONSE_FINGERPRINT_NAMESPACE = "flowforge:ai-planner-response:v1";

/** Namespaces are part of every digest, so an AI digest can never be mistaken for a planner id. */
export { PLANNER_ID_NAMESPACE };

/** Over the request the adapter was handed: structured context only, so the digest is safe to persist. */
export function aiRequestFingerprint(request: unknown): string {
  return fingerprintJson(AI_REQUEST_FINGERPRINT_NAMESPACE, request);
}

export function aiProposalFingerprint(proposal: unknown): string {
  return fingerprintJson(AI_PROPOSAL_FINGERPRINT_NAMESPACE, proposal);
}

/**
 * Digest of the response *as received*, before validation. `null` in, `null` out: "no answer at all" is a
 * different fact from "an answer we refused", and the audit must be able to tell them apart.
 */
export function aiResponseFingerprint(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.length === 0) return null;
  return fingerprintJson(AI_RESPONSE_FINGERPRINT_NAMESPACE, value);
}
