import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition, message, timeoutMs = 5000, stepMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await sleep(stepMs);
  }
  assert.fail(message ?? `timed out waiting for condition after ${timeoutMs}ms`);
}

test("daemon-spawn: real subprocess daemon lifecycle, restart consuming snapshot, and flag regressions", async () => {
  const testRoot = mkdtempSync(join(tmpdir(), "daemon-spawn-test-"));
  const binDir = join(testRoot, "bin");
  const stateDir = join(testRoot, "state");
  const opencodeDir = join(stateDir, "opencode");
  const herdrControlFile = join(testRoot, "herdr-control.json");
  const caffeinateLog = join(testRoot, "caffeinate.log");
  const herdrLog = join(testRoot, "herdr.log");

  const fs = await import("node:fs");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(opencodeDir, { recursive: true });

  // Mock herdr script
  const herdrScript = `#!/bin/sh
echo "herdr called: $@" >> "${herdrLog}"
if [ -f "${herdrControlFile}" ]; then
  cat "${herdrControlFile}"
  exit $(cat "${herdrControlFile}.exit" 2>/dev/null || echo 0)
fi
echo '{"panes":[]}'
exit 0
`;
  writeFileSync(join(binDir, "herdr"), herdrScript, "utf8");
  chmodSync(join(binDir, "herdr"), 0o755);

  // Mock caffeinate script: logs invocation arguments and sleeps until killed
  const caffeinateScript = `#!/bin/sh
echo "spawn: $$ $@" >> "${caffeinateLog}"
trap 'echo "kill: $$" >> "${caffeinateLog}"; exit 0' TERM INT
while true; do
  sleep 0.05
done
`;
  writeFileSync(join(binDir, "caffeinate"), caffeinateScript, "utf8");
  chmodSync(join(binDir, "caffeinate"), 0o755);

  // Initial Herdr state: working
  writeFileSync(
    herdrControlFile,
    JSON.stringify({ panes: [{ id: "p1", agent_status: "working" }] }),
    "utf8",
  );
  writeFileSync(`${herdrControlFile}.exit`, "0", "utf8");

  const daemonPath = join(process.cwd(), "daemon.mjs");
  const baseEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    OPENCODE_STATE_DIR: opencodeDir,
    KEEP_AWAKE_POLL_INTERVAL: "1",
    HERDR_TIMEOUT_MS: "1000",
  };

  let daemonProc = spawn(process.execPath, [daemonPath], {
    env: baseEnv,
    stdio: "ignore",
  });

  try {
    // 1. Initial poll: Herdr is working -> caffeinate must be spawned with -d
    await waitFor(
      () => existsSync(caffeinateLog) && readFileSync(caffeinateLog, "utf8").includes("spawn:"),
      "caffeinate must be spawned on startup",
    );
    let logLines = readFileSync(caffeinateLog, "utf8").trim().split("\n");
    let spawns = logLines.filter((l) => l.startsWith("spawn:"));
    assert.equal(spawns.length, 1, "exactly one caffeinate spawn on startup");
    assert.equal(spawns[0].includes("-d"), true, "default KEEP_AWAKE_DISPLAY=1 must include -d");

    // 2. Second poll: still working -> caffeinate must NOT be duplicated
    await sleep(1100);
    logLines = readFileSync(caffeinateLog, "utf8").trim().split("\n");
    spawns = logLines.filter((l) => l.startsWith("spawn:"));
    assert.equal(spawns.length, 1, "no duplicate caffeinate spawn while still working");

    // 3. Mode flag regression (enabled file): set to disabled -> caffeinate must be killed
    writeFileSync(join(stateDir, "enabled"), "disabled\n", "utf8");
    await waitFor(() => {
      const lines = readFileSync(caffeinateLog, "utf8").trim().split("\n");
      return lines.some((l) => l.startsWith("kill:"));
    }, "caffeinate must be killed when mode is disabled");

    // Re-enable mode
    writeFileSync(join(stateDir, "enabled"), "enabled\n", "utf8");
    await waitFor(() => {
      const lines = readFileSync(caffeinateLog, "utf8").trim().split("\n");
      return lines.filter((l) => l.startsWith("spawn:")).length >= 2;
    }, "caffeinate must respawn when mode is re-enabled");

    // 4. Herdr becomes idle -> caffeinate must be killed
    writeFileSync(
      herdrControlFile,
      JSON.stringify({ panes: [{ id: "p1", agent_status: "idle" }] }),
      "utf8",
    );
    await waitFor(() => {
      const lines = readFileSync(caffeinateLog, "utf8").trim().split("\n");
      return lines.filter((l) => l.startsWith("kill:")).length >= 2;
    }, "caffeinate must be killed when Herdr becomes idle");

    // 5. OpenCode has an active session while Herdr is idle -> caffeinate re-spawned
    const ocFile = join(opencodeDir, "inst-1.json");
    writeFileSync(
      ocFile,
      JSON.stringify({
        id: "inst-1",
        pid: process.pid,
        heartbeat: Date.now(),
        sessions: {
          "ses_active_1": { status: "running", updatedAt: Date.now() },
        },
      }),
      "utf8",
    );
    await waitFor(() => {
      const lines = readFileSync(caffeinateLog, "utf8").trim().split("\n");
      return lines.filter((l) => l.startsWith("spawn:")).length >= 3;
    }, "caffeinate spawned for active OpenCode session");

    // 6. RESTART TEST: kill daemon while valid OpenCode snapshot exists; new daemon must resume keep awake
    daemonProc.kill("SIGTERM");
    await waitFor(() => daemonProc.exitCode !== null, "daemon must exit on SIGTERM");

    // Start a second daemon instance with KEEP_AWAKE_DISPLAY=0 to verify display flag regression
    daemonProc = spawn(process.execPath, [daemonPath], {
      env: {
        ...baseEnv,
        KEEP_AWAKE_DISPLAY: "0",
      },
      stdio: "ignore",
    });

    await waitFor(() => {
      const lines = readFileSync(caffeinateLog, "utf8").trim().split("\n");
      return lines.filter((l) => l.startsWith("spawn:")).length >= 4;
    }, "restarted daemon must consume valid snapshot and spawn caffeinate");

    const latestSpawn = readFileSync(caffeinateLog, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("spawn:"))
      .pop();
    assert.equal(
      latestSpawn.includes("-d"),
      false,
      "KEEP_AWAKE_DISPLAY=0 must not include -d flag",
    );

    // 7. Herdr pane list fails for 3+ consecutive polls while OpenCode is active -> daemon stays alive
    writeFileSync(`${herdrControlFile}.exit`, "1", "utf8");
    writeFileSync(herdrControlFile, "error: herdr broken", "utf8");
    await sleep(3200);
    assert.equal(daemonProc.exitCode, null, "daemon must stay alive during Herdr failures if OpenCode is working");

    // 8. OpenCode becomes idle -> caffeinate killed
    const killsBeforeIdle = readFileSync(caffeinateLog, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("kill:")).length;

    writeFileSync(
      ocFile,
      JSON.stringify({
        id: "inst-1",
        pid: process.pid,
        heartbeat: Date.now(),
        sessions: {},
      }),
      "utf8",
    );
    await waitFor(() => {
      const lines = readFileSync(caffeinateLog, "utf8").trim().split("\n");
      return lines.filter((l) => l.startsWith("kill:")).length > killsBeforeIdle;
    }, "caffeinate killed when OpenCode becomes idle");

    // 9. Herdr failure continues with all sources idle -> daemon exits after max failures
    await waitFor(() => daemonProc.exitCode !== null, "daemon exits when Herdr fails without active work");
  } finally {
    try {
      daemonProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    rmSync(testRoot, { recursive: true, force: true });
  }
});
