import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getOpenCodeStatus, getOpenCodeStateDir } from "../opencode.mjs";

test("getOpenCodeStatus: returns inactive when directory does not exist", () => {
  const nonExistentDir = join(tmpdir(), `test-opencode-none-${Date.now()}`);
  const status = getOpenCodeStatus({ opencodeDir: nonExistentDir });
  assert.equal(status.working, false);
  assert.equal(status.instancesCount, 0);
  assert.equal(status.activeSessions.length, 0);
});

test("getOpenCodeStatus: handles A running B idle (idle deleted from state)", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-test-"));
  try {
    const file = join(dir, "inst-uuid-1.json");
    writeFileSync(
      file,
      JSON.stringify({
        id: "inst-uuid-1",
        pid: process.pid,
        projectDir: "/test/project",
        heartbeat: Date.now(),
        sessions: {
          sessionA: { status: "running", updatedAt: Date.now() },
        },
      }),
    );
    const status = getOpenCodeStatus({ opencodeDir: dir });
    assert.equal(status.working, true);
    assert.equal(status.activeSessions.includes("sessionA"), true);
    assert.equal(status.instancesCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getOpenCodeStatus: all idle (empty sessions) allows sleep", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-test-"));
  try {
    const file = join(dir, "inst-uuid-1.json");
    writeFileSync(
      file,
      JSON.stringify({
        id: "inst-uuid-1",
        pid: process.pid,
        projectDir: "/test/project",
        heartbeat: Date.now(),
        sessions: {},
      }),
    );
    const status = getOpenCodeStatus({ opencodeDir: dir });
    assert.equal(status.working, false);
    assert.equal(status.activeSessions.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getOpenCodeStatus: single-pass validation ignores crashed PID and stale heartbeat without unlinking", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-test-"));
  try {
    const deadPid = 99999999;
    writeFileSync(
      join(dir, "dead.json"),
      JSON.stringify({
        id: "dead",
        pid: deadPid,
        heartbeat: Date.now(),
        sessions: { crashedSession: { status: "running", updatedAt: Date.now() } },
      }),
    );

    writeFileSync(
      join(dir, "stale.json"),
      JSON.stringify({
        id: "stale",
        pid: process.pid,
        heartbeat: Date.now() - 60_000,
        sessions: { staleSession: { status: "running", updatedAt: Date.now() - 60_000 } },
      }),
    );

    const status = getOpenCodeStatus({
      opencodeDir: dir,
      heartbeatTimeoutMs: 10_000,
      isPidAlive: (pid) => pid === process.pid,
    });

    assert.equal(status.working, false);
    assert.equal(status.activeSessions.length, 0);
    assert.equal(status.instancesCount, 0);
    // Retain files; plugin exit owns cleanup to prevent deleting replacements
    assert.equal(existsSync(join(dir, "dead.json")), true, "must NOT unlink dead PID file");
    assert.equal(existsSync(join(dir, "stale.json")), true, "must NOT unlink stale file");
    // Obsolete aliases removed
    assert.equal(status.busySessions, undefined);
    assert.equal(status.retrySessions, undefined);
    assert.equal(status.idleSessions, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getOpenCodeStatus: bounds checking rejects oversized files and future timestamps", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-test-"));
  try {
    // Oversized file > 64KB
    const largeStr = "a".repeat(70000);
    writeFileSync(join(dir, "large.json"), JSON.stringify({ padding: largeStr }));

    // Future heartbeat timestamp (> now + 5000ms)
    writeFileSync(
      join(dir, "future.json"),
      JSON.stringify({
        id: "future",
        pid: process.pid,
        heartbeat: Date.now() + 60_000,
        sessions: { ses_f: { status: "running", updatedAt: Date.now() } },
      }),
    );

    // Invalid heartbeatTimeoutMs (NaN) safely falls back
    const status = getOpenCodeStatus({
      opencodeDir: dir,
      heartbeatTimeoutMs: Number.NaN,
      isPidAlive: () => true,
    });

    assert.equal(status.working, false);
    assert.equal(status.instancesCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getOpenCodeStatus: multi-project same-PID instance isolation", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-test-"));
  try {
    // Two distinct plugin instances sharing the same server process PID
    writeFileSync(
      join(dir, "inst-projA.json"),
      JSON.stringify({
        id: "inst-projA",
        pid: process.pid,
        projectDir: "/project/A",
        heartbeat: Date.now(),
        sessions: {},
      }),
    );
    writeFileSync(
      join(dir, "inst-projB.json"),
      JSON.stringify({
        id: "inst-projB",
        pid: process.pid,
        projectDir: "/project/B",
        heartbeat: Date.now(),
        sessions: {
          sessionB1: { status: "running", updatedAt: Date.now() },
        },
      }),
    );

    const status = getOpenCodeStatus({
      opencodeDir: dir,
      isPidAlive: () => true,
    });

    assert.equal(status.working, true);
    assert.equal(status.instancesCount, 2);
    assert.equal(status.activeSessions.includes("sessionB1"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
