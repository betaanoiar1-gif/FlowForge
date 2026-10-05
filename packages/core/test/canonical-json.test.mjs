import assert from "node:assert/strict";
import test from "node:test";
import { canonicalize, fingerprintJson, sha256Hex, stableJson } from "../dist/index.js";

/**
 * Canonical JSON is the substrate of every durable identity in FlowForge — job idempotency keys, plan
 * version content hashes, and planner fingerprints. These tests pin the properties those consumers rely
 * on: order-insensitive objects, order-*sensitive* arrays, dropped `undefined`, and namespaced digests.
 */

test("canonicalize sorts object keys but never reorders arrays", () => {
  assert.equal(stableJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(stableJson({ a: [2, 1], b: { z: 1, y: 2 } }), '{"a":[2,1],"b":{"y":2,"z":1}}');
  // Scene order and cast order are creative decisions; a canonicalizer that sorted arrays would rewrite them.
  assert.notEqual(stableJson(["scene-a", "scene-b"]), stableJson(["scene-b", "scene-a"]));
});

test("canonicalize drops undefined members and keeps null", () => {
  assert.equal(stableJson({ a: undefined, b: null, c: 1 }), '{"b":null,"c":1}');
  // An absent optional field and an explicitly unset one must agree, or a plan edited and reverted
  // would look like different content.
  assert.equal(stableJson({ a: 1 }), stableJson({ a: 1, b: undefined }));
});

test("canonicalize rejects what JSON cannot carry", () => {
  assert.throws(() => canonicalize(Number.NaN), /finite numbers/u);
  assert.throws(() => canonicalize(Infinity), /finite numbers/u);
  assert.throws(() => canonicalize(() => 1), /Unsupported value/u);
  assert.throws(() => canonicalize(Symbol("x")), /Unsupported value/u);
});

test("nested structures canonicalize independently of key insertion order", () => {
  const left = { version: { story: { premise: "p", themes: ["a", "b"] }, status: "DRAFT" }, plan: { id: "x" } };
  const right = { plan: { id: "x" }, version: { status: "DRAFT", story: { themes: ["a", "b"], premise: "p" } } };
  assert.equal(stableJson(left), stableJson(right));
  assert.equal(fingerprintJson("ns", left), fingerprintJson("ns", right));
});

test("sha256Hex is the lowercase hex digest of the exact string given", () => {
  // Pinned against a known vector so a change in hashing is caught rather than silently re-fingerprinting.
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.match(sha256Hex("anything"), /^[0-9a-f]{64}$/u);
});

test("fingerprints are namespaced so one digest cannot impersonate another", () => {
  const value = { id: "same" };
  assert.notEqual(fingerprintJson("flowforge:planner-input:v1", value), fingerprintJson("flowforge:planner-output:v1", value));
  // The same value under the same namespace must be reproducible across processes and runs.
  assert.equal(fingerprintJson("ns", value), fingerprintJson("ns", JSON.parse(JSON.stringify(value))));
});
