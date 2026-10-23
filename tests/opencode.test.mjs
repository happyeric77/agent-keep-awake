import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getOpenCodeStatus } from "../opencode.mjs";
import { createTestDir, mockSnapshot, writeJson } from "./helpers.mjs";

test("getOpenCodeStatus: missing directories are inactive", () => {
  const nonExistentDir = join(tmpdir(), `test-opencode-none-${Date.now()}`);
  const status = getOpenCodeStatus({ opencodeDir: nonExistentDir });
  assert.equal(status.working, false);
  assert.equal(status.instancesCount, 0);
  assert.equal(status.activeSessions.length, 0);
});

test("getOpenCodeStatus: aggregates running A and removed idle B", (t) => {
  const { dir } = createTestDir("opencode-reader-", t);
  writeJson(join(dir, "inst-1.json"), mockSnapshot({ sessionA: { status: "running" } }));

  const status = getOpenCodeStatus({ opencodeDir: dir });
  assert.equal(status.working, true);
  assert.equal(status.activeSessions.includes("sessionA"), true);
  assert.equal(status.instancesCount, 1);
});

test("getOpenCodeStatus: empty sessions allow sleep", (t) => {
  const { dir } = createTestDir("opencode-reader-", t);
  writeJson(join(dir, "inst-1.json"), mockSnapshot({}));

  const status = getOpenCodeStatus({ opencodeDir: dir });
  assert.equal(status.working, false);
  assert.equal(status.activeSessions.length, 0);
});

test("getOpenCodeStatus: ignores dead PIDs and stale heartbeats without deleting files", (t) => {
  const { dir } = createTestDir("opencode-reader-", t);
  writeJson(join(dir, "dead.json"), mockSnapshot({ crashedSession: { status: "running" } }, { pid: 99999999 }));
  writeJson(
    join(dir, "stale.json"),
    mockSnapshot({ staleSession: { status: "running" } }, { heartbeat: Date.now() - 60_000 }),
  );

  const status = getOpenCodeStatus({
    opencodeDir: dir,
    heartbeatTimeoutMs: 10_000,
    isPidAlive: (pid) => pid === process.pid,
  });

  assert.equal(status.working, false);
  assert.equal(status.activeSessions.length, 0);
  assert.equal(status.instancesCount, 0);
  assert.equal(existsSync(join(dir, "dead.json")), true, "Do not delete dead-PID snapshots");
  assert.equal(existsSync(join(dir, "stale.json")), true, "Do not delete stale snapshots");
});

test("getOpenCodeStatus: rejects oversized files, future timestamps, and malformed data", (t) => {
  const { dir } = createTestDir("opencode-reader-", t);

  // Exercise the 64 KB size guard.
  writeJson(join(dir, "large.json"), mockSnapshot({ ses_large: { status: "running" } }, { padding: "x".repeat(70_000) }));

  // Reject heartbeats more than five seconds in the future.
  writeJson(join(dir, "future.json"), mockSnapshot({ ses_f: { status: "running" } }, { heartbeat: Date.now() + 60_000 }));

  // Malformed JSON.
  writeFileSync(join(dir, "malformed.json"), "{ malformed json", "utf8");

  // Invalid timeout values fall back safely.
  const status = getOpenCodeStatus({
    opencodeDir: dir,
    heartbeatTimeoutMs: Number.NaN,
    isPidAlive: () => true,
  });

  assert.equal(status.working, false);
  assert.equal(status.instancesCount, 0);
});

test("getOpenCodeStatus: isolates same-PID projects and aggregates active sessions", (t) => {
  const { dir } = createTestDir("opencode-reader-", t);

  // One idle instance.
  writeJson(join(dir, "inst-idle.json"), mockSnapshot({}, { id: "inst-idle", projectDir: "/project/idle" }));

  // Two active instances with multiple sessions.
  writeJson(
    join(dir, "inst-act1.json"),
    mockSnapshot(
      { ses_a1: { status: "running" }, ses_a2: { status: "running" } },
      { id: "inst-act1", projectDir: "/project/A" },
    ),
  );
  writeJson(
    join(dir, "inst-act2.json"),
    mockSnapshot(
      { ses_b1: { status: "running" } },
      { id: "inst-act2", projectDir: "/project/B" },
    ),
  );

  // Valid JSON with invalid PID, heartbeat, or session schemas.
  writeJson(join(dir, "invalid-pid.json"), {
    id: "invalid-pid",
    pid: "not-a-number",
    heartbeat: Date.now(),
    sessions: { ses_bad1: { status: "running" } },
  });
  writeJson(join(dir, "invalid-heartbeat.json"), {
    id: "invalid-heartbeat",
    pid: process.pid,
    heartbeat: "not-a-timestamp",
    sessions: { ses_bad2: { status: "running" } },
  });
  writeJson(join(dir, "invalid-sessions.json"), {
    id: "invalid-sessions",
    pid: process.pid,
    heartbeat: Date.now(),
    sessions: ["ses_bad3"],
  });

  const status = getOpenCodeStatus({
    opencodeDir: dir,
    isPidAlive: () => true,
  });

  assert.equal(status.working, true);
  // Keep three valid instances and ignore invalid schemas.
  assert.equal(status.instancesCount, 3);
  // Verify the full union of active sessions.
  assert.deepEqual(status.activeSessions.sort(), ["ses_a1", "ses_a2", "ses_b1"]);
});
