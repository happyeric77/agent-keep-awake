import { spawnSync } from "node:child_process";
import { ensureAwake } from "./awake.mjs";
import {
  envFlag,
  loadDotEnv,
  modeEnabled,
  removeDaemonPid,
  writeDaemonPid,
} from "./lib.mjs";
import { appendLog } from "./log.mjs";
import { getOpenCodeStatus } from "./opencode.mjs";

loadDotEnv();

const herdrBin = process.env.HERDR_BIN_PATH ?? "herdr";
const pollIntervalMs = parseInt(process.env.KEEP_AWAKE_POLL_INTERVAL ?? "15", 10) * 1000;
const opencodeEnabled = envFlag("OPENCODE_KEEP_AWAKE_ENABLED", true);
const maxFailures = 3;
let failures = 0;

writeDaemonPid(process.pid);
appendLog(`Daemon started (PID ${process.pid}, poll interval ${pollIntervalMs} ms)`);

function cleanupAndExit() {
  ensureAwake(false);
  removeDaemonPid();
  appendLog("Daemon stopped");
  process.exit(0);
}

process.on("SIGTERM", cleanupAndExit);
process.on("SIGINT", cleanupAndExit);

function anyAgentWorking(panes) {
  return panes.some((pane) => pane?.agent_status === "working");
}

function poll() {
  const opencode = opencodeEnabled
    ? getOpenCodeStatus()
    : { working: false, instancesCount: 0, activeSessions: [] };

  const result = spawnSync(herdrBin, ["pane", "list"], { encoding: "utf8" });
  if (result.status !== 0) {
    failures += 1;
    const errorMsg = (result.stderr ?? result.stdout ?? "Unknown error").trim().slice(0, 200);
    appendLog(`herdr pane list failed (${result.status}): ${errorMsg}`);
    if (failures >= maxFailures && !opencode.working) {
      appendLog(`Too many failures (${failures}), exiting`);
      cleanupAndExit();
    }
    ensureAwake(opencode.working && modeEnabled());
    return;
  }
  failures = 0;

  try {
    const parsed = JSON.parse(result.stdout);
    const panes = parsed?.result?.panes ?? parsed?.panes ?? [];
    const herdrWorking = anyAgentWorking(panes);
    const working = (herdrWorking || opencode.working) && modeEnabled();
    ensureAwake(working);
    const ocDetails = opencode.working
      ? `, opencode: working (${opencode.activeSessions.length} active)`
      : "";
    appendLog(
      working
        ? `Working agent detected (herdr: ${herdrWorking ? "working" : "idle"}${ocDetails}), staying awake`
        : `No working agents (${panes.length} panes, ${opencode.instancesCount} opencode instances), allowing sleep`,
    );
  } catch (error) {
    appendLog(`pane list parse failed: ${error.message}`);
  }
}

poll();
setInterval(poll, pollIntervalMs);
