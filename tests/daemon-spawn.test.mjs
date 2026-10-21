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
  assert.fail(message ?? `等待條件逾時（超過 ${timeoutMs} 毫秒）`);
}

test("daemon-spawn: 真實子行程守護進程生命週期、重啟讀取快照與旗標迴歸", async () => {
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

  // 模擬 herdr 指令稿
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

  // 模擬 caffeinate 指令稿：記錄啟動參數並休眠直至被終止
  const caffeinateScript = `#!/bin/sh
echo "spawn: $$ $@" >> "${caffeinateLog}"
trap 'echo "kill: $$" >> "${caffeinateLog}"; exit 0' TERM INT
while true; do
  sleep 0.05
done
`;
  writeFileSync(join(binDir, "caffeinate"), caffeinateScript, "utf8");
  chmodSync(join(binDir, "caffeinate"), 0o755);

  // 初始 Herdr 狀態：working
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
    // 1. 初始輪詢：Herdr 處於 working -> caffeinate 必須以 -d 參數啟動
    await waitFor(
      () => existsSync(caffeinateLog) && readFileSync(caffeinateLog, "utf8").includes("spawn:"),
      "啟動時必須產生 caffeinate",
    );
    let logLines = readFileSync(caffeinateLog, "utf8").trim().split("\n");
    let spawns = logLines.filter((l) => l.startsWith("spawn:"));
    assert.equal(spawns.length, 1, "啟動時必須恰好產生一個 caffeinate");
    assert.equal(spawns[0].includes("-d"), true, "預設 KEEP_AWAKE_DISPLAY=1 必須包含 -d 參數");

    // 2. 第二次輪詢：仍處於 working -> caffeinate 不得重複啟動
    await sleep(1100);
    logLines = readFileSync(caffeinateLog, "utf8").trim().split("\n");
    spawns = logLines.filter((l) => l.startsWith("spawn:"));
    assert.equal(spawns.length, 1, "持續處於 working 狀態時不得重複產生 caffeinate");

    // 3. 模式旗標迴歸測試（enabled 檔案）：設為 disabled -> caffeinate 必須被終止
    writeFileSync(join(stateDir, "enabled"), "disabled\n", "utf8");
    await waitFor(() => {
      const lines = readFileSync(caffeinateLog, "utf8").trim().split("\n");
      return lines.some((l) => l.startsWith("kill:"));
    }, "當模式被停用時必須終止 caffeinate");

    // 重新啟用模式
    writeFileSync(join(stateDir, "enabled"), "enabled\n", "utf8");
    await waitFor(() => {
      const lines = readFileSync(caffeinateLog, "utf8").trim().split("\n");
      return lines.filter((l) => l.startsWith("spawn:")).length >= 2;
    }, "當模式重新啟用時必須重新產生 caffeinate");

    // 4. Herdr 轉為 idle -> caffeinate 必須被終止
    writeFileSync(
      herdrControlFile,
      JSON.stringify({ panes: [{ id: "p1", agent_status: "idle" }] }),
      "utf8",
    );
    await waitFor(() => {
      const lines = readFileSync(caffeinateLog, "utf8").trim().split("\n");
      return lines.filter((l) => l.startsWith("kill:")).length >= 2;
    }, "當 Herdr 轉為 idle 時必須終止 caffeinate");

    // 5. Herdr 處於 idle 但 OpenCode 有活躍 session -> caffeinate 重新啟動
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
    }, "OpenCode session 活躍時必須產生 caffeinate");

    // 6. 重啟測試：在存在有效 OpenCode 快照時終止守護進程；新守護進程必須恢復保持喚醒
    daemonProc.kill("SIGTERM");
    await waitFor(() => daemonProc.exitCode !== null, "收到 SIGTERM 時守護進程必須退出");

    // 啟動第二個守護進程實例並設定 KEEP_AWAKE_DISPLAY=0 以驗證螢幕旗標迴歸
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
    }, "重啟後的守護進程必須讀取有效快照並產生 caffeinate");

    const latestSpawn = readFileSync(caffeinateLog, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("spawn:"))
      .pop();
    assert.equal(
      latestSpawn.includes("-d"),
      false,
      "KEEP_AWAKE_DISPLAY=0 不得包含 -d 參數",
    );

    // 7. OpenCode 處於活躍狀態時，herdr pane list 連續 3 次以上輪詢失敗 -> 守護進程保持運行
    writeFileSync(`${herdrControlFile}.exit`, "1", "utf8");
    writeFileSync(herdrControlFile, "error: herdr broken", "utf8");
    await sleep(3200);
    assert.equal(daemonProc.exitCode, null, "當 OpenCode 處於 working 時，Herdr 失敗期間守護進程必須保持運行");

    // 8. OpenCode 轉為 idle -> caffeinate 被終止
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
    }, "當 OpenCode 轉為 idle 時必須終止 caffeinate");

    // 9. 所有來源均處於 idle 且 Herdr 持續失敗 -> 守護進程達到最大失敗次數後退出
    await waitFor(() => daemonProc.exitCode !== null, "在無活躍工作且 Herdr 失敗時守護進程必須退出");
  } finally {
    try {
      daemonProc.kill("SIGTERM");
    } catch {
      // 忽略錯誤
    }
    rmSync(testRoot, { recursive: true, force: true });
  }
});
