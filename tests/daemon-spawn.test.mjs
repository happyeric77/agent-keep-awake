import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, message, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${message}`);
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("daemon stays awake for Herdr or OpenCode work, and sleeps when both are idle", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "keep-awake-daemon-"));
  const binDir = join(dir, "bin");
  const opencodeDir = join(dir, "opencode");
  const paneFile = join(dir, "panes.json");
  const caffeinateLog = join(dir, "caffeinate.log");
  mkdirSync(binDir);
  mkdirSync(opencodeDir);

  // Fake CLI tools: Herdr prints a fixture, caffeinate records its PID.
  writeFileSync(join(binDir, "herdr"), `#!/bin/sh\ncat "${paneFile}"\n`, { mode: 0o755 });
  writeFileSync(join(binDir, "caffeinate"), `#!/bin/sh\necho $$ >> "${caffeinateLog}"\nexec sleep 30\n`, { mode: 0o755 });
  const setHerdr = (status) => writeFileSync(paneFile, JSON.stringify({ result: { panes: status ? [{ agent_status: status }] : [] } }));
  const setSessions = (sessions) => writeFileSync(join(opencodeDir, "instance.json"), JSON.stringify({ pid: process.pid, sessions }));
  const caffeinatePids = () => (existsSync(caffeinateLog) ? readFileSync(caffeinateLog, "utf8").trim().split("\n").map(Number) : []);

  setHerdr("working");
  const daemon = spawn(process.execPath, [join(root, "daemon.mjs")], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      HERDR_BIN_PATH: join(binDir, "herdr"),
      HERDR_PLUGIN_STATE_DIR: join(dir, "state"),
      OPENCODE_STATE_DIR: opencodeDir,
      KEEP_AWAKE_POLL_INTERVAL: "1",
      KEEP_AWAKE_DISPLAY: "0",
    },
    stdio: "ignore",
  });
  t.after(() => {
    daemon.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  });

  await waitFor(() => caffeinatePids().length === 1, "Herdr work starts caffeinate");
  const caffeinatePid = caffeinatePids()[0];

  // Herdr goes idle, but a background OpenCode session is still working.
  setHerdr(null);
  setSessions(["ses_background"]);
  await sleep(1500);
  assert.equal(daemon.exitCode, null, "the daemon keeps running");
  assert.equal(caffeinatePids().length, 1, "caffeinate is not restarted");
  assert.equal(isAlive(caffeinatePid), true, "OpenCode work keeps the Mac awake");

  // Everything is idle: caffeinate stops.
  setSessions([]);
  await waitFor(() => !isAlive(caffeinatePid), "all idle stops caffeinate");
  daemon.kill("SIGTERM");
  await waitFor(() => daemon.exitCode !== null, "SIGTERM exits the daemon");
  assert.equal(daemon.exitCode, 0);
});
