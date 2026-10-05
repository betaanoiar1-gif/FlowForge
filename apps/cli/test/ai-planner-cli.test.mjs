import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/**
 * Phase 4C operator-surface tests for AI-assisted planning.
 *
 * They run the real CLI against a loopback OpenAI-compatible endpoint and a throwaway data directory, with
 * a key that exists only in the child's environment: the surface being tested is the whole route —
 * selection flags, exit codes, what gets printed, and above all what is *not* done. No test in this file
 * needs a real credential or a network beyond localhost, and none of them can reach a provider account.
 *
 * The assertions that matter most here are negative: `--dry-run` writes nothing, a refused proposal exits
 * 3 with no version behind it, and there is no command that turns a plan into execution.
 */

const PROPOSAL = {
  schemaVersion: "ai-planning-proposal-v1",
  story: {
    premise: "A solo developer ships a launch teaser in an afternoon.",
    beginning: "A developer opens a blank project. Nothing works yet.",
    development: "The pipeline comes online. Shots queue in order.",
    ending: "The teaser ships and the signups arrive.",
  },
  scenes: [
    {
      title: "Blank project",
      intent: "Establish the stakes: an empty timeline at 4pm.",
      characters: ["Aya"],
      world: "Rooftops",
      durationMs: 4000,
      kinds: ["image"],
    },
    {
      title: "Ship it",
      intent: "Land the release and the first signups.",
      characters: ["Aya"],
      world: "Rooftops",
      durationMs: 6000,
      kinds: ["image"],
    },
  ],
  visualDna: "dawn-grain",
};

async function createWorkspace(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-ai-cli-"));
  const dataDir = path.join(directory, "data");
  const seen = [];
  let answered = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      answered += 1;
      seen.push({ url: req.url, authorization: req.headers.authorization ?? "", body });
      res.writeHead(options.status ?? 200, { "content-type": "application/json" });
      if (options.raw !== undefined) {
        res.end(options.raw);
        return;
      }
      res.end(JSON.stringify({ model: "cli-test-model", choices: [{ message: { role: "assistant", content: JSON.stringify(PROPOSAL) }, finish_reason: "stop" }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  // `spawnSync` would block this process, and this process is the one serving the mock endpoint — a
  // synchronous child could never be answered. So every call is async on purpose.
  const runCli = promisify(execFile);
  const run = async (args, spawnOptions = {}) => {
    const env = spawnOptions.noKey
      ? { ...process.env, FLOWFORGE_AI_API_KEY: "" }
      : { ...process.env, FLOWFORGE_AI_API_KEY: "sk-cli-test-key-0000000000000000" };
    let result;
    let exited = 0;
    try {
      result = await runCli(process.execPath, [CLI, ...args, "--data-dir", dataDir], {
        encoding: "utf8",
        timeout: 60_000,
        env: { ...env, ...(spawnOptions.env ?? {}) },
        windowsHide: true,
      });
    } catch (error) {
      // A non-zero exit is an expected outcome for a typed command: the rejection carries the exit code and
      // both streams, which is exactly what an operator's shell would report.
      result = error;
      exited = typeof error.code === "number" ? error.code : 1;
    }
    const stdout = result.stdout ?? "";
    let payload;
    try {
      payload = stdout.trim() ? JSON.parse(stdout) : undefined;
    } catch {
      payload = undefined;
    }
    return {
      code: exited,
      stdout,
      stderr: result.stderr ?? "",
      payload,
      data: () => payload?.data,
    };
  };
  const aiFlags = ["--ai-base-url", `http://127.0.0.1:${String(port)}/v1`];
  const json = (args, spawnOptions = {}) => run([...args, "--json"], spawnOptions);
  return {
    directory,
    dataDir,
    run,
    json,
    aiFlags,
    seen,
    answers: () => answered,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function setup(workspace) {
  const calls = [
    [["project", "create", "--project-id", "pilot", "--name", "Pilot"]],
    [
      [
        "brief",
        "create",
        "--project-id",
        "pilot",
        "--title",
        "Launch film",
        "--concept",
        "A launch teaser for a planning tool",
        "--objective",
        "Get signups",
        "--constraints-json",
        '[{"kind":"MUST","value":"no on-screen text"}]',
      ],
    ],
    [
      [
        "definition",
        "character-create",
        "--project-id",
        "pilot",
        "--character-id",
        "char-aya",
        "--name",
        "Aya",
        "--traits-json",
        '{"role":"protagonist","appearance":"red jacket","personality":"decisive"}',
        "--visual-identity-json",
        '{"description":"silver watch"}',
      ],
    ],
    [
      [
        "definition",
        "world-create",
        "--project-id",
        "pilot",
        "--world-id",
        "world-roof",
        "--name",
        "Rooftops",
        "--environment",
        "Dense rooftop grid at dawn",
      ],
    ],
    [
      [
        "definition",
        "dna-create",
        "--project-id",
        "pilot",
        "--visual-dna-id",
        "dna-grain",
        "--name",
        "dawn-grain",
        "--style",
        "35mm film look",
        "--palette-json",
        '["#0b1020"]',
        "--lighting",
        "low key",
        "--composition",
        "centered thirds",
        "--camera-language",
        "slow dolly",
        "--rendering-style",
        "photoreal",
        "--atmosphere",
        "tense",
      ],
    ],
  ];
  for (const [args] of calls) {
    const result = await workspace.json(args);
    assert.equal(result.code, 0, `${args.join(" ")} → ${result.stderr || result.stdout}`);
  }
}

test("planner ai-run proposes, plans, validates, and records the route — and stops there", async () => {
  const workspace = await createWorkspace();
  try {
    await setup(workspace);
    const run = await workspace.json(["planner", "ai-run", "--project-id", "pilot", ...workspace.aiFlags]);
    assert.equal(run.code, 0, run.stderr || run.stdout);
    const data = run.data();
    assert.equal(data.outcome, "SUCCESS");
    assert.equal(data.created, true);
    assert.equal(data.scenePlans, 2);
    assert.equal(data.validation.status, "PASSED");
    assert.equal(data.ai.adapter, "openai-chat");
    assert.equal(data.ai.provider, "openai-compatible");
    assert.equal(data.ai.model, "gpt-4o-mini");
    assert.equal(data.ai.path, "ai-adapter");
    assert.equal(data.ai.fallback, false);
    assert.equal(data.ai.provenanceRecorded, true);
    assert.equal(data.version.ai.model, "gpt-4o-mini", "the stored version says which model proposed it");
    assert.equal(data.version.ai.adapterVersion, "openai-chat-adapter-v1");
    assert.match(data.version.ai.requestFingerprint, /^[a-f0-9]{64}$/u);
    assert.match(data.version.ai.responseFingerprint, /^[a-f0-9]{64}$/u);
    assert.deepEqual(
      data.trace.slice(0, 4).map((step) => step.stage),
      ["AI_REQUEST", "AI_RESPONSE", "AI_SCHEMA_VALIDATION", "NORMALIZATION"],
    );
    // Planning only: the queue stayed empty and the version is what a reviewer would look at next.
    const queue = await workspace.json(["queue", "status"]);
    assert.equal(queue.code, 0, queue.stderr);
    assert.equal(queue.data().depth.total, 0, "an AI-planned version enqueues nothing");
    assert.equal(workspace.answers(), 1, "exactly one model call for one run");

    // The credential reached the endpoint and nowhere else: not stdout, not stderr, not the printed result.
    assert.equal(workspace.seen[0].authorization, "Bearer sk-cli-test-key-0000000000000000");
    assert.equal(run.stdout.includes("sk-cli-test-key"), false);
    assert.equal(run.stderr.includes("sk-cli-test-key"), false);
    assert.equal(workspace.seen[0].body.includes("sk-cli-test-key"), false, "the key never enters the prompt");
  } finally {
    await workspace.close();
  }
});

test("--dry-run reports the whole attempt and writes nothing", async () => {
  const workspace = await createWorkspace();
  try {
    await setup(workspace);
    const run = await workspace.json(["planner", "ai-run", "--project-id", "pilot", "--dry-run", ...workspace.aiFlags]);
    assert.equal(run.code, 0, run.stderr || run.stdout);
    const data = run.data();
    assert.equal(data.outcome, "SUCCESS");
    assert.equal(data.created, false);
    assert.equal(data.version, null);
    assert.equal(data.ai.provenanceRecorded, false);
    assert.match(data.ai.provenanceReason, /dry run writes nothing/u);
    assert.match(data.ai.proposalFingerprint, /^[a-f0-9]{64}$/u, "fingerprints are still reported");
    const plans = await workspace.json(["plan", "list", "--project-id", "pilot"]);
    assert.equal(plans.code, 0, plans.stderr);
    assert.equal(plans.data().length, 0, "no plan was created by a dry run");
  } finally {
    await workspace.close();
  }
});

test("a refused or unusable answer exits 3 with nothing written, and says what to do next", async () => {
  for (const [label, options, expectedCode] of [
    ["no credential", { spawn: { noKey: true } }, "AI_CREDENTIAL_MISSING"],
    ["prose instead of a proposal", { raw: JSON.stringify({ choices: [{ message: { content: "Once upon a time…" }, finish_reason: "stop" }] }) }, "AI_INVALID_JSON"],
    ["endpoint down", { raw: "not json at all" }, "AI_INVALID_JSON"],
  ]) {
    const workspace = await createWorkspace(options);
    try {
      await setup(workspace);
      const run = await workspace.json(["planner", "ai-run", "--project-id", "pilot", ...workspace.aiFlags], options.spawn ?? {});
      assert.equal(run.code, 3, `${label}: expected the blocked exit code, got ${String(run.code)} — ${run.stderr || run.stdout}`);
      const data = run.data();
      assert.equal(data.outcome, "AI_FAILURE", label);
      assert.equal(data.errors[0].code, expectedCode, `${label}: ${JSON.stringify(data.errors)}`);
      assert.equal(data.version, null);
      assert.equal(data.created, false);
      assert.ok(
        data.notices.some((notice) => notice.code === "AI_FALLBACK_NOT_REQUESTED"),
        "the operator is told the fallback has to be asked for",
      );
      const plans = await workspace.json(["plan", "list", "--project-id", "pilot"]);
      assert.equal(plans.data().length, 0, `${label}: nothing may be written by a refused run`);
      if (label === "no credential") {
        assert.equal(workspace.answers(), 0, "a missing key never reaches the network");
        assert.equal(run.stdout.includes("sk-cli-test-key"), false);
      }
    } finally {
      await workspace.close();
    }
  }
});

test("--fallback=deterministic plans the operator's own story, and records that it did", async () => {
  const workspace = await createWorkspace({ status: 503, raw: "upstream unavailable" });
  try {
    await setup(workspace);
    const story = JSON.stringify({
      premise: "A solo developer ships a launch teaser in an afternoon.",
      beginning: "A developer opens a blank project. Nothing works yet.",
      development: "The pipeline comes online. Shots queue in order.",
      ending: "The teaser ships and the signups arrive.",
    });
    const run = await workspace.json([
      "planner",
      "ai-run",
      "--project-id",
      "pilot",
      "--fallback=deterministic",
      "--story-json",
      story,
      ...workspace.aiFlags,
    ]);
    assert.equal(run.code, 0, run.stderr || run.stdout);
    const data = run.data();
    assert.equal(data.outcome, "SUCCESS");
    assert.equal(data.ai.path, "deterministic-fallback");
    assert.equal(data.ai.fallback, true);
    assert.equal(data.version.ai.path, "deterministic-fallback", "the stored version says a fallback was used");
    assert.ok(data.notices.some((notice) => notice.code === "AI_FALLBACK_USED"));
    // A failed adapter is not silently re-tried into a different route: one call, then the stated fallback.
    assert.equal(workspace.answers(), 1);
  } finally {
    await workspace.close();
  }
});

test("configuration mistakes are usage errors, never a half-run", async () => {
  const workspace = await createWorkspace();
  try {
    await setup(workspace);
    const unknownFlag = await workspace.json(["planner", "ai-run", "--project-id", "pilot", "--model=gpt-5", ...workspace.aiFlags]);
    assert.equal(unknownFlag.code, 2);
    assert.match(unknownFlag.stderr, /--model/u);
    assert.match(unknownFlag.stderr, /planner ai-run/u, "the refusal names the command it was parsing");

    const unknownAdapter = await workspace.run([
      "planner",
      "ai-run",
      "--project-id",
      "pilot",
      "--ai-adapter=vendor-of-the-month",
      "--json",
      ...workspace.aiFlags,
    ]);
    assert.equal(unknownAdapter.code, 2);
    assert.match(unknownAdapter.stderr, /--ai-adapter must be one of openai-chat/u);

    const badFallback = await workspace.json(["planner", "ai-run", "--project-id", "pilot", "--fallback=whatever", ...workspace.aiFlags]);
    assert.equal(badFallback.code, 2);
    assert.match(badFallback.stderr, /fallback/u);

    const badJson = await workspace.json(["planner", "ai-run", "--project-id", "pilot", "--guidance-json={", ...workspace.aiFlags]);
    assert.equal(badJson.code, 2);

    const noProject = await workspace.json(["planner", "ai-run", ...workspace.aiFlags]);
    assert.equal(noProject.code, 2);
    assert.match(noProject.stderr, /--project-id is required/u);
    assert.equal(workspace.answers(), 0, "a usage error never asks the model anything");
  } finally {
    await workspace.close();
  }
});

test("--trace prints the stages, and the boundary is printed either way", async () => {
  const workspace = await createWorkspace();
  try {
    await setup(workspace);
    const human = await workspace.run(["planner", "ai-run", "--project-id", "pilot", ...workspace.aiFlags, "--trace"]);
    assert.equal(human.code, 0, human.stderr || human.stdout);
    assert.match(human.stdout, /ai planning  adapter openai-chat@openai-chat-adapter-v1  openai-compatible\//u);
    assert.match(human.stdout, /AI_REQUEST\s+APPLIED ai-request/u);
    assert.match(human.stdout, /AI_SCHEMA_VALIDATION\s+APPLIED ai-schema-validation/u);
    assert.match(human.stdout, /DOMAIN_VALIDATION\s+APPLIED domain-validation/u);
    assert.match(human.stdout, /RULE\s+APPLIED plan-integrity/u);
    assert.match(human.stdout, /planning only\. No generation job was created/u);
    assert.equal(human.stdout.includes("sk-cli-test-key"), false);
    const quiet = await workspace.run(["planner", "ai-run", "--project-id", "pilot", "--dry-run", ...workspace.aiFlags]);
    assert.match(quiet.stdout, /add --trace to print them/u);
  } finally {
    await workspace.close();
  }
});

test("there is no AI execution command, and none will be inferred", async () => {
  const workspace = await createWorkspace();
  try {
    for (const args of [
      ["planner", "ai-execute", "--project-id", "pilot"],
      ["planner", "execute", "--project-id", "pilot"],
      ["planner", "ai-submit", "--project-id", "pilot"],
      ["planner", "ai-run", "--execute", "--project-id", "pilot"],
      ["plan", "ai-generate", "--project-id", "pilot"],
    ]) {
      const result = await workspace.run([...args, "--json", ...workspace.aiFlags]);
      assert.equal(result.code, 2, `${args.join(" ")} must not be a command`);
      assert.match(result.stderr, /Unknown command|Unknown option/u, args.join(" "));
    }
    const help = await workspace.run(["help"]);
    assert.equal(help.code, 0);
    assert.equal(help.stdout.includes("ai-execute"), false);
    assert.match(help.stdout, /planner ai-run/u, "the one AI verb is listed in help");
  } finally {
    await workspace.close();
  }
});
