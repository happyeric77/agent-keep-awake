import { spawnSync } from "node:child_process";
import { ensureAwake } from "./awake.mjs";
import {
  daemonAlive,
  loadDotEnv,
  modeEnabled,
  removeDaemonPid,
  writeDaemonPid,
} from "./lib.mjs";
import { appendLog } from "./log.mjs";

loadDotEnv();

const herdrBin = process.env.HERDR_BIN_PATH ?? "herdr";
const pollIntervalMs = parseInt(process.env.KEEP_AWAKE_POLL_INTERVAL ?? "15", 10) * 1000;
const maxFailures = 3;
let failures = 0;

writeDaemonPid(process.pid);
appendLog(`daemon started (pid ${process.pid}, poll ${pollIntervalMs}ms)`);

function cleanupAndExit() {
  ensureAwake(false);
  removeDaemonPid();
  appendLog("daemon stopped");
  process.exit(0);
}

process.on("SIGTERM", cleanupAndExit);
process.on("SIGINT", cleanupAndExit);

function anyAgentWorking(panes) {
  return panes.some((pane) => pane?.agent_status === "working");
}

function poll() {
  const result = spawnSync(herdrBin, ["pane", "list"], { encoding: "utf8" });
  if (result.status !== 0) {
    failures += 1;
    appendLog(
      `herdr pane list failed (${result.status}): ${(result.stderr ?? result.stdout ?? "unknown error").trim().slice(0, 200)}`,
    );
    if (failures >= maxFailures) {
      appendLog(`too many failures (${failures}), exiting`);
      cleanupAndExit();
    }
    return;
  }
  failures = 0;
  try {
    const parsed = JSON.parse(result.stdout);
    const panes = parsed?.result?.panes ?? parsed?.panes ?? [];
    const working = anyAgentWorking(panes);
    ensureAwake(working);
    appendLog(
      working
        ? `working agents present, keeping awake`
        : `no working agents (${panes.length} panes), allowing sleep`,
    );
  } catch (error) {
    appendLog(`pane list parse failed: ${error.message}`);
  }
}

poll();
setInterval(poll, pollIntervalMs);
