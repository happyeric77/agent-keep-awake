import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import plugin from "../opencode-plugin.mjs";
import { getOpenCodeStatus } from "../opencode.mjs";

test("opencode-plugin: is self-contained with zero relative imports", () => {
  const code = readFileSync(join(process.cwd(), "opencode-plugin.mjs"), "utf8");
  const relativeImportRegex = /from\s+["'](\.\/|\.\.\/)/g;
  const matches = [...code.matchAll(relativeImportRegex)];
  assert.equal(matches.length, 0, "opencode-plugin.mjs must have zero relative imports");
  assert.equal(typeof plugin.setup, "function");
  assert.equal(plugin.id, "herdr.keep-awake");
});

test(
  "opencode-plugin: two project instances in same PID write and clean up independently",
  async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plug-multi-"));
  try {
    const ctxA = {
      location: { directory: "/project/A" },
      session: {
        active: async () => ({ ses_A: { type: "running" } }),
      },
    };
    const ctxB = {
      location: { directory: "/project/B" },
      session: {
        active: async () => ({ ses_B: { type: "running" } }),
      },
    };

    // Start instance A and B in same process
    const cleanupA = await plugin.setup(ctxA, { stateDir: dir, pollIntervalMs: 50 });
    const cleanupB = await plugin.setup(ctxB, { stateDir: dir, pollIntervalMs: 50 });

    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 2, "must create two separate UUID state files for same PID");

    // Read both files
    const states = files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
    const sessions = states.flatMap((s) => Object.keys(s.sessions));
    assert.equal(sessions.includes("ses_A"), true);
    assert.equal(sessions.includes("ses_B"), true);

    // Clean up A only -> B must remain intact
    await cleanupA();
    const remaining = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(remaining.length, 1, "cleaning up A must only remove A's file");

    await cleanupB();
    const afterAll = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(afterAll.length, 0, "cleaning up B must remove B's file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode-plugin: authoritative active contract removes finished sessions without retaining idle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plug-snap-"));
  try {
    let activeMap = { ses_1: { type: "running" }, ses_2: { type: "running" } };
    const ctx = {
      location: { directory: "/project" },
      session: {
        active: async () => activeMap,
      },
    };

    const cleanup = await plugin.setup(ctx, { stateDir: dir, pollIntervalMs: 50 });
    const file = readdirSync(dir).find((f) => f.endsWith(".json"));
    let state = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(Object.keys(state.sessions).length, 2);

    // Session 1 finishes -> leaves activeMap
    activeMap = { ses_2: { type: "running" } };
    await new Promise((r) => setTimeout(r, 120));

    state = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(state.sessions.ses_1, undefined, "finished session must be deleted, not retained");
    assert.equal(state.sessions.ses_2?.status, "running");

    // Both finish
    activeMap = {};
    await new Promise((r) => setTimeout(r, 120));

    state = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(Object.keys(state.sessions).length, 0, "all finished sessions deleted");

    await cleanup();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode-plugin: does not persist sensitive error messages or raw payload data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plug-sensitive-"));
  try {
    const ctx = {
      location: { directory: "/project" },
      session: {
        active: async () => ({
          ses_sec: {
            type: "running",
            secretToken: "sk-super-secret",
            errorMessage: "Sensitive error message from provider",
          },
        }),
      },
    };

    const cleanup = await plugin.setup(ctx, { stateDir: dir, pollIntervalMs: 50 });
    const file = readdirSync(dir).find((f) => f.endsWith(".json"));
    const rawContent = readFileSync(join(dir, file), "utf8");
    assert.equal(rawContent.includes("sk-super-secret"), false);
    assert.equal(rawContent.includes("Sensitive error message"), false);

    const parsed = JSON.parse(rawContent);
    assert.deepEqual(parsed.sessions.ses_sec.status, "running");
    assert.equal(parsed.sessions.ses_sec.secretToken, undefined);
    assert.equal(parsed.sessions.ses_sec.errorMessage, undefined);

    await cleanup();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode-plugin: hanging active() request is bounded by timeout and does not block shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plug-timeout-"));
  try {
    const ctx = {
      location: { directory: "/project" },
      session: {
        active: async () => {
          // Never resolves
          await new Promise(() => {});
        },
      },
    };

    const cleanup = await plugin.setup(ctx, {
      stateDir: dir,
      pollIntervalMs: 50,
      activeTimeoutMs: 100, // short timeout for testing
    });

    const file = readdirSync(dir).find((f) => f.endsWith(".json"));
    assert.equal(Boolean(file), true);

    // Cleanup should complete promptly without waiting on hanging promise
    const start = Date.now();
    await cleanup();
    assert.equal(Date.now() - start < 1000, true, "cleanup must not hang");
    assert.equal(existsSync(join(dir, file)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode-plugin: late completion after cleanup does not recreate state file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plug-late-"));
  try {
    let resolveActive;
    const ctx = {
      location: { directory: "/project" },
      session: {
        active: () =>
          new Promise((resolve) => {
            resolveActive = resolve;
          }),
      },
    };

    const cleanup = await plugin.setup(ctx, {
      stateDir: dir,
      pollIntervalMs: 500,
      activeTimeoutMs: 50,
    });

    const file = readdirSync(dir).find((f) => f.endsWith(".json"));
    assert.equal(Boolean(file), true);

    // Stop plugin while active request is still pending
    await cleanup();
    assert.equal(existsSync(join(dir, file)), false);

    // Late resolve after plugin is already cleaned up
    resolveActive?.({ ses_late: { type: "running" } });
    await new Promise((r) => setTimeout(r, 100));

    // Must NOT have recreated the file
    assert.equal(existsSync(join(dir, file)), false, "late completion must not recreate state file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode-plugin: success active then perpetual failure does not refresh heartbeat and expires in reader", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plug-expire-"));
  try {
    let failActive = false;
    const ctx = {
      location: { directory: "/project" },
      session: {
        active: async () => {
          if (failActive) {
            throw new Error("API failure");
          }
          return { ses_1: { type: "running" } };
        },
      },
    };

    const cleanup = await plugin.setup(ctx, {
      stateDir: dir,
      pollIntervalMs: 30,
      activeTimeoutMs: 50,
    });

    const file = readdirSync(dir).find((f) => f.endsWith(".json"));
    assert.equal(Boolean(file), true);

    // Initial state is working
    let status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 120 });
    assert.equal(status.working, true);
    assert.equal(status.activeSessions.includes("ses_1"), true);

    const firstHeartbeat = JSON.parse(readFileSync(join(dir, file), "utf8")).heartbeat;

    // Now fail continuously
    failActive = true;
    // Wait through several poll ticks and past heartbeat timeout
    await new Promise((r) => setTimeout(r, 200));

    const stateAfterFailures = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(
      stateAfterFailures.heartbeat,
      firstHeartbeat,
      "heartbeat must NOT be refreshed on API failure",
    );

    // Reader must see working: false because heartbeat expired
    status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 120 });
    assert.equal(status.working, false, "reader must see not working after timeout");

    await cleanup();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode-plugin: exactly one in-flight request at most across many ticks and late resolve does not write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plug-inflight-"));
  try {
    let callCount = 0;
    let resolveActive;
    const ctx = {
      location: { directory: "/project" },
      session: {
        active: () => {
          callCount += 1;
          return new Promise((resolve) => {
            resolveActive = resolve;
          });
        },
      },
    };

    const cleanup = await plugin.setup(ctx, {
      stateDir: dir,
      pollIntervalMs: 25,
      activeTimeoutMs: 40,
    });

    const file = readdirSync(dir).find((f) => f.endsWith(".json"));
    assert.equal(Boolean(file), true);

    // Initial setup launched call 1. Let multiple interval ticks fire while call is still pending
    await new Promise((r) => setTimeout(r, 160));

    assert.equal(
      callCount,
      1,
      "must never have overlapping underlying calls across interval ticks",
    );

    // Now resolve late (well after the activeTimeoutMs)
    resolveActive({ ses_late: { type: "running" } });
    await new Promise((r) => setTimeout(r, 60));

    // Late result after timeout must NOT have written sessions to state
    const state = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(state.sessions.ses_late, undefined, "late result after timeout must not write");

    await cleanup();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode-plugin: strictly validates unwrapped map and rejects malformed/enveloped/idle data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plug-val-"));
  try {
    let currentResponse = { data: { ses_1: { type: "running" } } }; // Enveloped: must be rejected!
    const ctx = {
      location: { directory: "/project" },
      session: {
        active: async () => currentResponse,
      },
    };

    const cleanup = await plugin.setup(ctx, {
      stateDir: dir,
      pollIntervalMs: 40,
      activeTimeoutMs: 50,
    });

    const file = readdirSync(dir).find((f) => f.endsWith(".json"));
    let state = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(
      Object.keys(state.sessions).length,
      0,
      "enveloped data must be rejected and not populate sessions",
    );

    // Arbitrary idle object: must be rejected!
    currentResponse = { ses_idle: { type: "idle" } };
    await new Promise((r) => setTimeout(r, 70));
    state = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(
      state.sessions.ses_idle,
      undefined,
      "idle objects must be rejected, not marked active",
    );

    // Arbitrary key not starting with 'ses': must be rejected!
    currentResponse = { arbitrary_key: { type: "running" } };
    await new Promise((r) => setTimeout(r, 70));
    state = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(
      state.sessions.arbitrary_key,
      undefined,
      "keys not starting with ses must be rejected",
    );

    // Valid unwrapped response with ses prefix and type: running: must be accepted!
    currentResponse = { ses_valid: { type: "running" } };
    await new Promise((r) => setTimeout(r, 70));
    state = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(state.sessions.ses_valid?.status, "running");

    await cleanup();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode-plugin: repeated setup and cleanup restores process listener counts without signal alteration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plug-listeners-"));
  try {
    const exitBefore = process.listenerCount("exit");
    const sigtermBefore = process.listenerCount("SIGTERM");
    const sigintBefore = process.listenerCount("SIGINT");

    const ctx = {
      location: { directory: "/project" },
      session: {
        active: async () => ({}),
      },
    };

    for (let i = 0; i < 5; i++) {
      const cleanup = await plugin.setup(ctx, {
        stateDir: dir,
        pollIntervalMs: 100,
      });
      // During setup, only an exit listener may be added; never SIGTERM or SIGINT
      assert.equal(process.listenerCount("SIGTERM"), sigtermBefore, "plugin must not add SIGTERM listeners");
      assert.equal(process.listenerCount("SIGINT"), sigintBefore, "plugin must not add SIGINT listeners");
      await cleanup();
    }

    // After repeated cleanups, exit listener count must be completely restored
    assert.equal(
      process.listenerCount("exit"),
      exitBefore,
      "exit listener count must be restored after cleanup",
    );
    assert.equal(process.listenerCount("SIGTERM"), sigtermBefore);
    assert.equal(process.listenerCount("SIGINT"), sigintBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
