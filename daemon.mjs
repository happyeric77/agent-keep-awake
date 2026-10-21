import { spawnSync } from "node:child_process";
import { ensureAwake } from "./awake.mjs";
import { anyAgentWorking } from "./daemon-logic.mjs";
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
const herdrTimeoutRaw = parseInt(process.env.HERDR_TIMEOUT_MS ?? "5000", 10);
const herdrTimeoutMs =
  Number.isFinite(herdrTimeoutRaw) && herdrTimeoutRaw > 0 ? herdrTimeoutRaw : 5000;
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

function poll() {
  const opencodeEnabled = envFlag("OPENCODE_KEEP_AWAKE_ENABLED", true);
  let panes = [];
  let herdrFailed = false;

  const result = spawnSync(herdrBin, ["pane", "list"], {
    encoding: "utf8",
    timeout: herdrTimeoutMs,
  });

  if (result.status !== 0) {
    herdrFailed = true;
    failures += 1;
    const errorMsg = (result.stderr ?? result.stdout ?? "unknown error")
      .trim()
      .slice(0, 200);
    appendLog(`herdr pane list failed (${result.status}): ${errorMsg}`);
  } else {
    failures = 0;
    try {
      const parsed = JSON.parse(result.stdout);
      panes = parsed?.result?.panes ?? parsed?.panes ?? [];
    } catch (error) {
      appendLog(`pane list parse failed: ${error.message}`);
    }
  }

  const herdrWorking = anyAgentWorking(panes);
  const opencodeStatus = opencodeEnabled
    ? getOpenCodeStatus()
    : { instancesCount: 0, activeSessions: [] };
  const opencodeWorking = opencodeStatus.activeSessions.length > 0;

  const shouldKeepAwake = (herdrWorking || opencodeWorking) && modeEnabled();
  ensureAwake(shouldKeepAwake);

  if (herdrFailed && failures >= maxFailures) {
    if (opencodeWorking) {
      appendLog(
        `herdr pane list failed (${failures} times) but OpenCode is working; staying alive`,
      );
    } else {
      appendLog(`too many failures (${failures}), exiting`);
      cleanupAndExit();
      return;
    }
  }

  let ocDetails = "";
  if (opencodeEnabled && opencodeStatus.instancesCount > 0) {
    const ocActiveCount = opencodeStatus.activeSessions.length;
    ocDetails = opencodeWorking
      ? `, opencode: working (${ocActiveCount} active)`
      : ", opencode: idle";
  }

  if (shouldKeepAwake) {
    const herdrState = herdrWorking ? "working" : "idle";
    appendLog(`working agents present (herdr: ${herdrState}${ocDetails}), keeping awake`);
  } else {
    const ocInst = opencodeEnabled
      ? `, ${opencodeStatus.instancesCount} opencode instances`
      : "";
    appendLog(`no working agents (${panes.length} panes${ocInst}), allowing sleep`);
  }
}

poll();
setInterval(poll, pollIntervalMs);
