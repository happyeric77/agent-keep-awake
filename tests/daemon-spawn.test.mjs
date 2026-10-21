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

test("daemon-spawn: 依據 Herdr 與 OpenCode 活躍狀態管理 caffeinate、去重與模式切換", async (t) => {
  const { dir: testRoot, defer } = createTestDir("daemon-spawn-lifecycle-", t);
  const envInfo = setupDaemonTestEnv(testRoot, defer);

  // 初始 Herdr 狀態：working
  writeJson(envInfo.herdrControlFile, {
    panes: [{ id: "p1", agent_status: "working" }],
  });

  const daemonProc = spawnDaemon(envInfo.env, defer);

  // 1. 初始輪詢：Herdr 處於 working -> caffeinate 必須以 -d 參數啟動
  await waitFor(
    () => readLines(envInfo.caffeinateLog).some((l) => l.startsWith("spawn:")),
    "啟動時必須產生 caffeinate",
  );
  let spawns = readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("spawn:"));
  assert.equal(spawns.length, 1, "啟動時必須恰好產生一個 caffeinate");
  assert.equal(spawns[0].includes("-d"), true, "預設 KEEP_AWAKE_DISPLAY=1 必須包含 -d 參數");

  // 2. 第二次輪詢：依據 daemon.log 觀測完成第二輪，caffeinate 不得重複啟動
  await waitFor(() => {
    if (!existsSync(envInfo.daemonLog)) return false;
    const count = (readFileSync(envInfo.daemonLog, "utf8").match(/檢測到工作中的 agent/g) || []).length;
    return count >= 2;
  }, "等待守護進程完成第二輪工作輪詢");
  spawns = readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("spawn:"));
  assert.equal(spawns.length, 1, "持續處於 working 狀態時不得重複產生 caffeinate");

  // 3. 模式旗標（enabled 檔案）：設為 disabled -> caffeinate 必須被終止
  writeFileSync(join(envInfo.stateDir, "enabled"), "disabled\n", "utf8");
  await waitFor(() => {
    return readLines(envInfo.caffeinateLog).some((l) => l.startsWith("kill:"));
  }, "當模式被停用時必須終止 caffeinate");

  // 重新啟用模式 -> caffeinate 必須重新產生
  writeFileSync(join(envInfo.stateDir, "enabled"), "enabled\n", "utf8");
  await waitFor(() => {
    return readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("spawn:")).length >= 2;
  }, "當模式重新啟用時必須重新產生 caffeinate");

  // 4. Herdr 轉為 idle -> caffeinate 必須被終止
  writeJson(envInfo.herdrControlFile, {
    panes: [{ id: "p1", agent_status: "idle" }],
  });
  await waitFor(() => {
    return readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("kill:")).length >= 2;
  }, "當 Herdr 轉為 idle 時必須終止 caffeinate");

  // 5. Herdr 處於 idle 但 OpenCode 活躍（邏輯 OR） -> caffeinate 重新產生
  const ocFile = join(envInfo.opencodeDir, "inst-1.json");
  writeJson(ocFile, mockSnapshot({ ses_active_1: { status: "running" } }, { id: "inst-1" }));
  await waitFor(() => {
    return readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("spawn:")).length >= 3;
  }, "OpenCode session 活躍時必須產生 caffeinate");

  // 6. OpenCode 轉為 idle -> caffeinate 被終止
  writeJson(ocFile, mockSnapshot({}, { id: "inst-1" }));
  await waitFor(() => {
    return readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("kill:")).length >= 3;
  }, "當所有來源皆轉為 idle 時必須終止 caffeinate");

  // 7. 正常終止守護進程並驗證 exitCode=0, signalCode=null
  daemonProc.kill("SIGTERM");
  await waitForProcessExit(daemonProc, 3000);
  assert.equal(daemonProc.exitCode, 0, "守護進程收到 SIGTERM 應正常退出 (exitCode=0)");
  assert.equal(daemonProc.signalCode, null, "守護進程應由內部信號處理常式退出");
});

test("daemon-spawn: 守護進程重啟讀取既有快照並遵守 KEEP_AWAKE_DISPLAY 旗標", async (t) => {
  const { dir: testRoot, defer } = createTestDir("daemon-spawn-restart-", t);
  const envInfo = setupDaemonTestEnv(testRoot, defer, { KEEP_AWAKE_DISPLAY: "0" });

  // 1. 預先寫入有效 OpenCode 快照
  const ocFile = join(envInfo.opencodeDir, "inst-existing.json");
  writeJson(ocFile, mockSnapshot({ ses_restored: { status: "running" } }, { id: "inst-existing" }));

  // 2. 啟動第一個守護進程（KEEP_AWAKE_DISPLAY=1）
  const daemon1 = spawnDaemon({ ...envInfo.env, KEEP_AWAKE_DISPLAY: "1" }, defer);

  // 第一個守護進程產生 caffeinate（包含 -d）
  await waitFor(
    () => readLines(envInfo.caffeinateLog).some((l) => l.startsWith("spawn:")),
    "第一個守護進程必須產生 caffeinate",
  );
  let spawns = readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("spawn:"));
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].includes("-d"), true, "第一個守護進程應包含 -d 參數");

  const firstPid = Number(spawns[0].split(/\s+/)[1]);
  assert.equal(Number.isInteger(firstPid) && firstPid > 0, true, "第一個 caffeinate PID 必須有效");

  // 3. 正常 SIGTERM 終止第一個守護進程
  daemon1.kill("SIGTERM");
  await waitForProcessExit(daemon1, 3000);
  assert.equal(daemon1.exitCode, 0, "第一個守護進程收到 SIGTERM 應正常退出 (exitCode=0)");
  assert.equal(daemon1.signalCode, null, "第一個守護進程 signalCode 應為 null");

  // 4. 等待第一個 caffeinate 行程實際完全退出（只查詢存活狀態，不發送信號）
  await waitFor(() => !isPidAlive(firstPid), "第一個守護進程的 caffeinate 必須確認退出");

  // 5. 同有效快照下啟動第二個守護進程（KEEP_AWAKE_DISPLAY=0）
  const daemon2 = spawnDaemon(envInfo.env, defer);

  // 6. 驗證新的 spawn 產生，且遵守 KEEP_AWAKE_DISPLAY=0（不含 -d）
  await waitFor(() => {
    return readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("spawn:")).length >= 2;
  }, "重啟後的第二個守護進程必須讀取快照並產生新的 caffeinate");

  spawns = readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("spawn:"));
  const secondSpawn = spawns[spawns.length - 1];
  assert.equal(secondSpawn.includes("-d"), false, "KEEP_AWAKE_DISPLAY=0 不得包含 -d 參數");

  // 關閉第二個守護進程
  daemon2.kill("SIGTERM");
  await waitForProcessExit(daemon2, 3000);
  assert.equal(daemon2.exitCode, 0);
  assert.equal(daemon2.signalCode, null);
});

test("daemon-spawn: Herdr 連續失敗容錯：OpenCode 活躍保持運行，全 idle 失敗後退出", async (t) => {
  const { dir: testRoot, defer } = createTestDir("daemon-spawn-failover-", t);
  const envInfo = setupDaemonTestEnv(testRoot, defer);

  // 初始狀態：OpenCode 活躍
  const ocFile = join(envInfo.opencodeDir, "inst-failover.json");
  writeJson(ocFile, mockSnapshot({ ses_failover: { status: "running" } }, { id: "inst-failover" }));

  // 設定 Herdr 呼叫持續失敗（返回狀態碼 1）
  writeFileSync(`${envInfo.herdrControlFile}.exit`, "1", "utf8");
  writeFileSync(envInfo.herdrControlFile, "error: herdr broken\n", "utf8");

  const daemonProc = spawnDaemon(envInfo.env, defer);

  // 1. caffeinate 啟動並記錄 PID
  await waitFor(
    () => readLines(envInfo.caffeinateLog).some((l) => l.startsWith("spawn:")),
    "OpenCode 活躍時必須啟動 caffeinate",
  );
  const spawns = readLines(envInfo.caffeinateLog).filter((l) => l.startsWith("spawn:"));
  assert.equal(spawns.length, 1);
  const caffeinatePid = Number(spawns[0].split(/\s+/)[1]);
  assert.equal(Number.isInteger(caffeinatePid) && caffeinatePid > 0, true, "caffeinate PID 必須有效");

  // 2. 觀測 daemon.log 確認已完成至少 3 次失敗輪詢且記錄 OpenCode 保持運作訊息
  await waitFor(() => {
    if (!existsSync(envInfo.daemonLog)) return false;
    const log = readFileSync(envInfo.daemonLog, "utf8");
    const failureCount = (log.match(/herdr pane list 執行失敗/g) || []).length;
    return failureCount >= 3 && log.includes("但 OpenCode 仍在執行中；保持喚醒狀態");
  }, "等待 Herdr 連續失敗 3 次並確認記錄保持喚醒日誌");

  assert.equal(daemonProc.exitCode, null, "當 OpenCode 處於 working 時，Herdr 失敗期間守護進程必須保持運行");

  // 3. OpenCode 轉為 idle -> 守護進程應終止 caffeinate，且 caffeinate 真正退出
  writeJson(ocFile, mockSnapshot({}, { id: "inst-failover" }));

  await waitFor(
    () => readLines(envInfo.caffeinateLog).some((l) => l.startsWith("kill:")),
    "OpenCode 轉為 idle 後必須向 caffeinate 發送信號終止",
  );
  await waitFor(() => !isPidAlive(caffeinatePid), "caffeinate 必須確認完全退出");

  // 4. 守護進程達到連續失敗上限後應自主退出
  await waitFor(() => {
    if (!existsSync(envInfo.daemonLog)) return false;
    return readFileSync(envInfo.daemonLog, "utf8").includes("失敗次數過多");
  }, "等待守護進程記錄失敗次數過多並準備退出");

  await waitForProcessExit(daemonProc, 4000);
  assert.equal(daemonProc.exitCode, 0, "在無活躍工作且 Herdr 持續失敗時守護進程必須正常退出 (exitCode=0)");
  assert.equal(daemonProc.signalCode, null, "守護進程自主呼叫 exit(0)，signalCode 應為 null");
});
