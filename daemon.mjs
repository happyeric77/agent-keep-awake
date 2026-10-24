import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
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
let activityWorkspace = process.env.OPENCODE_ACTIVITY_WORKSPACE?.trim();
const metadataTtlMs = Math.min(86_400_000, Math.max(60_000, pollIntervalMs * 3));
const execFileAsync = promisify(execFile);
let metadataPending;
let metadataCount;
let metadataUpdated = 0;
let stopping = false;
let pollTimer;
const maxFailures = 3;
let failures = 0;

writeDaemonPid(process.pid);
appendLog(`Daemon started (PID ${process.pid}, poll interval ${pollIntervalMs} ms)`);

async function cleanupAndExit() {
  if (stopping) return;
  stopping = true;
  clearInterval(pollTimer);
  ensureAwake(false);
  await metadataPending;
  await reportActivity(0);
  removeDaemonPid();
  appendLog("Daemon stopped");
  process.exit(0);
}

process.on("SIGTERM", cleanupAndExit);
process.on("SIGINT", cleanupAndExit);

function anyAgentWorking(panes) {
  return panes.some((pane) => pane?.agent_status === "working");
}

function reportActivity(count) {
  if (!activityWorkspace) return;
  if (metadataPending) return metadataPending;
  if (count === metadataCount && (!count || Date.now() - metadataUpdated < metadataTtlMs / 2)) return;
  const args = [
    "workspace", "report-metadata", activityWorkspace,
    "--source", "keep-awake:opencode-global",
  ];
  if (count) {
    args.push(
      "--token", `aka_oc_global=OpenCode Global: ${count} detected running`,
      "--ttl-ms", String(metadataTtlMs),
    );
  } else {
    args.push("--clear-token", "aka_oc_global");
  }
  // Metadata must never block the next sleep decision, even if Herdr hangs.
  metadataPending = execFileAsync(herdrBin, args, { timeout: 2000, killSignal: "SIGKILL", maxBuffer: 8192 })
    .then(() => {
      metadataCount = count;
      metadataUpdated = Date.now();
    })
    .catch((error) => {
      let missing = false;
      try {
        missing = JSON.parse(error.stderr).error?.code === "workspace_not_found";
      } catch {
        // Transient or unsupported API: retry next poll; old metadata expires.
      }
      if (missing) activityWorkspace = undefined;
      appendLog(missing
        ? "Activity workspace missing; hint disabled"
        : "Activity metadata failed; keep awake unaffected");
    })
    .finally(() => {
      metadataPending = undefined;
    });
  return metadataPending;
}

function poll() {
  const opencode = opencodeEnabled
    ? getOpenCodeStatus()
    : { working: false, instancesCount: 0, activeSessions: [] };
  reportActivity(opencode.activeSessions.length);

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
pollTimer = setInterval(poll, pollIntervalMs);
