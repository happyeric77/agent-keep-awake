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
appendLog(`守護進程已啟動 (PID ${process.pid}，輪詢間隔 ${pollIntervalMs} 毫秒)`);

function cleanupAndExit() {
  ensureAwake(false);
  removeDaemonPid();
  appendLog("守護進程已停止");
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
    const errorMsg = (result.stderr ?? result.stdout ?? "未知錯誤")
      .trim()
      .slice(0, 200);
    appendLog(`herdr pane list 執行失敗 (${result.status})：${errorMsg}`);
  } else {
    failures = 0;
    try {
      const parsed = JSON.parse(result.stdout);
      panes = parsed?.result?.panes ?? parsed?.panes ?? [];
    } catch (error) {
      appendLog(`pane list 解析失敗：${error.message}`);
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
        `herdr pane list 失敗（${failures} 次），但 OpenCode 仍在執行中；保持喚醒狀態`,
      );
    } else {
      appendLog(`失敗次數過多（${failures} 次），即將退出`);
      cleanupAndExit();
      return;
    }
  }

  let ocDetails = "";
  if (opencodeEnabled && opencodeStatus.instancesCount > 0) {
    const ocActiveCount = opencodeStatus.activeSessions.length;
    ocDetails = opencodeWorking
      ? `, opencode: working (${ocActiveCount} 個活躍)`
      : ", opencode: idle";
  }

  if (shouldKeepAwake) {
    const herdrState = herdrWorking ? "working" : "idle";
    appendLog(`檢測到工作中的 agent (herdr: ${herdrState}${ocDetails})，保持喚醒`);
  } else {
    const ocInst = opencodeEnabled
      ? `，${opencodeStatus.instancesCount} 個 opencode 實例`
      : "";
    appendLog(`無工作中的 agent (${panes.length} 個窗格${ocInst})，允許休眠`);
  }
}

poll();
setInterval(poll, pollIntervalMs);
