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
      OPENCODE_ACTIVITY_WORKSPACE: "",
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

test("global workspace hint refreshes and clears without controlling sleep or pane state", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "keep-awake-metadata-"));
  const binDir = join(dir, "bin");
  const opencodeDir = join(dir, "opencode");
  const callsFile = join(dir, "calls.jsonl");
  const behaviorFile = join(dir, "behavior");
  const caffeinateFile = join(dir, "caffeinate.pid");
  mkdirSync(binDir);
  mkdirSync(opencodeDir);
  writeFileSync(behaviorFile, "hang");
  writeFileSync(join(binDir, "herdr"), `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.join(' ') === 'pane list') {
  console.log(JSON.stringify({ result: { panes: [] } }));
} else {
  appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
  const behavior = readFileSync(${JSON.stringify(behaviorFile)}, 'utf8');
  if (behavior === 'hang') setInterval(() => {}, 1000);
  else if (behavior !== 'ok') {
    console.error(JSON.stringify({ error: { code: behavior } }));
    process.exit(1);
  }
}
`, { mode: 0o755 });
  writeFileSync(join(binDir, "package.json"), '{"type":"module"}');
  writeFileSync(join(binDir, "caffeinate"), `#!/bin/sh\necho $$ > "${caffeinateFile}"\nexec sleep 120\n`, { mode: 0o755 });
  const setSessions = (sessions) => {
    const raw = JSON.stringify({ pid: process.pid, sessions });
    for (const name of ["a", "b"]) writeFileSync(join(opencodeDir, `${name}.json`), raw);
  };
  const calls = () => existsSync(callsFile)
    ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  const hasCount = (count) => calls().some((args) => args.includes(`aka_oc_global=OpenCode Global: ${count} detected running`));
  setSessions(["ses_a"]);
  const daemon = spawn(process.execPath, [join(root, "daemon.mjs")], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      HERDR_BIN_PATH: join(binDir, "herdr"),
      HERDR_PLUGIN_STATE_DIR: join(dir, "state"),
      OPENCODE_STATE_DIR: opencodeDir,
      OPENCODE_KEEP_AWAKE_ENABLED: "1",
      OPENCODE_ACTIVITY_WORKSPACE: "w_existing",
      KEEP_AWAKE_POLL_INTERVAL: "1",
      KEEP_AWAKE_DISPLAY: "0",
    },
    stdio: "ignore",
  });
  t.after(async () => {
    if (daemon.exitCode === null) daemon.kill("SIGTERM");
    await waitFor(() => daemon.exitCode !== null, "daemon cleanup");
    rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(() => existsSync(caffeinateFile) && hasCount(1), "sleep prevention and deduplicated hint start");
  const caffeine = Number(readFileSync(caffeinateFile, "utf8"));
  setSessions([]);
  await waitFor(() => !isAlive(caffeine), "hung metadata must not delay sleep decisions");
  writeFileSync(behaviorFile, "unavailable");
  setSessions(["ses_a", "ses_b"]);
  await waitFor(() => hasCount(2) && isAlive(Number(readFileSync(caffeinateFile, "utf8"))), "failed metadata must not stop keep awake");
  writeFileSync(behaviorFile, "ok");
  await sleep(2500);
  const refreshedFrom = calls().length;
  await waitFor(() => calls().length > refreshedFrom, "unchanged active count refreshes its TTL", 35000);
  for (const args of calls()) {
    assert.deepEqual(args.slice(0, 3), ["workspace", "report-metadata", "w_existing"]);
    assert.ok(args.includes("--clear-token") || args.includes("--ttl-ms"));
    assert.ok(!args.some((arg) => arg.includes("report-agent")));
  }
  setSessions([]);
  await waitFor(() => calls().at(-1)?.includes("--clear-token"), "idle clears just our token");
  assert.equal(calls().at(-1).at(-1), "aka_oc_global");
  setSessions(["ses_a"]);
  await waitFor(() => calls().at(-1)?.includes("aka_oc_global=OpenCode Global: 1 detected running"), "activity restarts");
  daemon.kill("SIGTERM");
  await waitFor(() => daemon.exitCode !== null, "shutdown completes");
  assert.ok(calls().at(-1).includes("--clear-token"), "shutdown clears the hint");
  assert.equal(daemon.exitCode, 0);

  // A closed/missing target must not redirect the hint to another workspace.
  writeFileSync(behaviorFile, "workspace_not_found");
  const beforeMissing = calls().length;
  const missing = spawn(process.execPath, [join(root, "daemon.mjs")], {
    env: {
      ...process.env,
      HERDR_BIN_PATH: join(binDir, "herdr"),
      HERDR_PLUGIN_STATE_DIR: join(dir, "missing-state"),
      OPENCODE_STATE_DIR: opencodeDir,
      OPENCODE_ACTIVITY_WORKSPACE: "w_missing",
      KEEP_AWAKE_POLL_INTERVAL: "1",
      PATH: `${binDir}:${process.env.PATH}`,
      KEEP_AWAKE_DISPLAY: "0",
    },
    stdio: "ignore",
  });
  t.after(async () => {
    missing.kill("SIGTERM");
    await waitFor(() => missing.exitCode !== null, "missing workspace daemon cleanup");
  });
  await waitFor(() => calls().length > beforeMissing, "missing workspace checked");
  await sleep(2200);
  assert.equal(calls().length, beforeMissing + 1, "missing workspace disables reporting");
  assert.equal(missing.exitCode, null, "keep awake survives a missing workspace");
  missing.kill("SIGTERM");
  await waitFor(() => missing.exitCode !== null, "missing workspace daemon stops");
});
