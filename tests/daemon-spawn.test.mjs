import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTestDir,
  isPidAlive,
  mockSnapshot,
  readLines,
  setupDaemonTestEnv,
  spawnDaemon,
  waitFor,
  waitForProcessExit,
  writeJson,
} from "./helpers.mjs";

test("daemon-spawn: combines Herdr and OpenCode activity, deduplicates caffeinate, and respects mode changes", async (t) => {
  const { dir: testRoot, defer } = createTestDir("daemon-spawn-lifecycle-", t);
  const envInfo = setupDaemonTestEnv(testRoot, defer);

  // Start with Herdr working.
  writeJson(envInfo.herdrControlFile, {
    panes: [{ id: "p1", agent_status: "working" }],
  });

  const daemonProc = spawnDaemon(envInfo.env, defer);

  // Start exactly one caffeinate with display protection.
  await waitFor(
    () => readLines(envInfo.caffeinateLog).some((l) => l.startsWith("spawn:")),
    "Startup must spawn caffeinate",
  );
  let spawns = readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("spawn:"));
  assert.equal(spawns.length, 1, "Startup must spawn exactly one caffeinate");
  assert.equal(spawns[0].includes("-d"), true, "KEEP_AWAKE_DISPLAY=1 must include -d");

  // Observe a second working poll without a duplicate spawn.
  await waitFor(() => {
    if (!existsSync(envInfo.daemonLog)) return false;
    const count = (readFileSync(envInfo.daemonLog, "utf8").match(/Working agent detected/g) || []).length;
    return count >= 2;
  }, "Wait for the second working poll");
  spawns = readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("spawn:"));
  assert.equal(spawns.length, 1, "Continued activity must not spawn duplicate caffeinate");

  // Disabling the mode stops caffeinate.
  writeFileSync(join(envInfo.stateDir, "enabled"), "disabled\n", "utf8");
  await waitFor(() => {
    return readLines(envInfo.caffeinateLog).some((l) => l.startsWith("kill:"));
  }, "Disabling mode must stop caffeinate");

  // Re-enabling mode starts caffeinate again.
  writeFileSync(join(envInfo.stateDir, "enabled"), "enabled\n", "utf8");
  await waitFor(() => {
    return readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("spawn:")).length >= 2;
  }, "Re-enabling mode must restart caffeinate");

  // Herdr becoming idle stops caffeinate.
  writeJson(envInfo.herdrControlFile, {
    panes: [{ id: "p1", agent_status: "idle" }],
  });
  await waitFor(() => {
    return readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("kill:")).length >= 2;
  }, "Herdr idle must stop caffeinate");

  // OpenCode alone keeps the Mac awake: Herdr OR OpenCode.
  const ocFile = join(envInfo.opencodeDir, "inst-1.json");
  writeJson(ocFile, mockSnapshot({ ses_active_1: { status: "running" } }, { id: "inst-1" }));
  await waitFor(() => {
    return readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("spawn:")).length >= 3;
  }, "OpenCode activity must spawn caffeinate");

  // Both sources becoming idle stops caffeinate.
  writeJson(ocFile, mockSnapshot({}, { id: "inst-1" }));
  await waitFor(() => {
    return readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("kill:")).length >= 3;
  }, "All sources idle must stop caffeinate");

  // SIGTERM exits through the daemon's signal handler.
  daemonProc.kill("SIGTERM");
  await waitForProcessExit(daemonProc, 3000);
  assert.equal(daemonProc.exitCode, 0, "SIGTERM must exit normally");
  assert.equal(daemonProc.signalCode, null, "The signal handler must complete cleanup");
});

test("daemon-spawn: restart reads existing snapshots and respects KEEP_AWAKE_DISPLAY", async (t) => {
  const { dir: testRoot, defer } = createTestDir("daemon-spawn-restart-", t);
  const envInfo = setupDaemonTestEnv(testRoot, defer, { KEEP_AWAKE_DISPLAY: "0" });

  // Seed a valid OpenCode snapshot.
  const ocFile = join(envInfo.opencodeDir, "inst-existing.json");
  writeJson(ocFile, mockSnapshot({ ses_restored: { status: "running" } }, { id: "inst-existing" }));

  // First daemon keeps the display on.
  const daemon1 = spawnDaemon({ ...envInfo.env, KEEP_AWAKE_DISPLAY: "1" }, defer);

  // Wait for the first caffeinate.
  await waitFor(
    () => readLines(envInfo.caffeinateLog).some((l) => l.startsWith("spawn:")),
    "First daemon must spawn caffeinate",
  );
  let spawns = readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("spawn:"));
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].includes("-d"), true, "First caffeinate must include -d");

  const firstPid = Number(spawns[0].split(/\s+/)[1]);
  assert.equal(Number.isInteger(firstPid) && firstPid > 0, true, "First caffeinate PID must be valid");

  // Stop the first daemon normally.
  daemon1.kill("SIGTERM");
  await waitForProcessExit(daemon1, 3000);
  assert.equal(daemon1.exitCode, 0, "First daemon must exit normally on SIGTERM");
  assert.equal(daemon1.signalCode, null, "First daemon must handle SIGTERM");

  // Wait for actual exit without sending another signal.
  await waitFor(() => !isPidAlive(firstPid), "First caffeinate must actually exit");

  // Restart against the same snapshot without display protection.
  const daemon2 = spawnDaemon(envInfo.env, defer);

  // The new caffeinate must omit -d.
  await waitFor(() => {
    return readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("spawn:")).length >= 2;
  }, "Restart must read the snapshot and spawn a new caffeinate");

  spawns = readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("spawn:"));
  const secondSpawn = spawns[spawns.length - 1];
  assert.equal(secondSpawn.includes("-d"), false, "KEEP_AWAKE_DISPLAY=0 must omit -d");

  // Stop the second daemon.
  daemon2.kill("SIGTERM");
  await waitForProcessExit(daemon2, 3000);
  assert.equal(daemon2.exitCode, 0);
  assert.equal(daemon2.signalCode, null);
});

test("daemon-spawn: Herdr failures retain active OpenCode protection and exit only after all work is idle", async (t) => {
  const { dir: testRoot, defer } = createTestDir("daemon-spawn-failover-", t);
  const envInfo = setupDaemonTestEnv(testRoot, defer);

  // Start with OpenCode active.
  const ocFile = join(envInfo.opencodeDir, "inst-failover.json");
  writeJson(ocFile, mockSnapshot({ ses_failover: { status: "running" } }, { id: "inst-failover" }));

  // Herdr fails repeatedly with exit code 1.
  writeFileSync(`${envInfo.herdrControlFile}.exit`, "1", "utf8");
  writeFileSync(envInfo.herdrControlFile, "error: herdr broken\n", "utf8");

  const daemonProc = spawnDaemon(envInfo.env, defer);

  // Record the actual caffeinate PID.
  await waitFor(
    () => readLines(envInfo.caffeinateLog).some((l) => l.startsWith("spawn:")),
    "OpenCode activity must start caffeinate",
  );
  const spawns = readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("spawn:"));
  assert.equal(spawns.length, 1);
  const caffeinatePid = Number(spawns[0].split(/\s+/)[1]);
  assert.equal(Number.isInteger(caffeinatePid) && caffeinatePid > 0, true, "Caffeinate PID must be valid");

  // Observe at least three Herdr failures while OpenCode remains active.
  await waitFor(() => {
    if (!existsSync(envInfo.daemonLog)) return false;
    const log = readFileSync(envInfo.daemonLog, "utf8");
    const failureCount = (log.match(/herdr pane list failed/g) || []).length;
    return failureCount >= 3 && log.includes("but OpenCode is working; staying awake");
  }, "Wait for three Herdr failures with protection retained");

  assert.equal(daemonProc.exitCode, null, "Herdr failures must not stop an active OpenCode daemon");

  // OpenCode idle must stop caffeinate.
  writeJson(ocFile, mockSnapshot({}, { id: "inst-failover" }));

  await waitFor(
    () => readLines(envInfo.caffeinateLog).some((l) => l.startsWith("kill:")),
    "OpenCode idle must signal caffeinate to stop",
  );
  await waitFor(() => !isPidAlive(caffeinatePid), "Caffeinate must actually exit");

  // With no active work, repeated failures allow the daemon to exit.
  await waitFor(() => {
    if (!existsSync(envInfo.daemonLog)) return false;
    return readFileSync(envInfo.daemonLog, "utf8").includes("Too many failures");
  }, "Wait for the daemon failure limit");

  await waitForProcessExit(daemonProc, 4000);
  assert.equal(daemonProc.exitCode, 0, "Idle daemon must exit normally after repeated Herdr failures");
  assert.equal(daemonProc.signalCode, null, "Daemon must exit through its cleanup handler");
});
