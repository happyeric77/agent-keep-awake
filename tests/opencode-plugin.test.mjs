import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import plugin from "../opencode-plugin.mjs";
import { getOpenCodeStatus } from "../opencode.mjs";
import { createTestDir, mockContext, readJson, repoRoot, sleep, waitFor } from "./helpers.mjs";

test("opencode-plugin: 完全自給自足且無任何相對路徑引入", () => {
  const code = readFileSync(join(repoRoot, "opencode-plugin.mjs"), "utf8");
  const relativeImportRegex = /from\s+["'](\.\/|\.\.\/)/g;
  const matches = [...code.matchAll(relativeImportRegex)];
  assert.equal(matches.length, 0, "opencode-plugin.mjs 不得包含任何相對路徑引入");
  assert.equal(typeof plugin.setup, "function");
  assert.equal(plugin.id, "herdr.keep-awake");
});

test("opencode-plugin: 同 PID 下的兩個專案實例各自獨立寫入與清理", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-multi-", t);
  const cleanupA = await plugin.setup(
    mockContext({ ses_A: { type: "running" } }, "/project/A"),
    { stateDir: dir, pollIntervalMs: 50 },
  );
  defer(cleanupA);
  const cleanupB = await plugin.setup(
    mockContext({ ses_B: { type: "running" } }, "/project/B"),
    { stateDir: dir, pollIntervalMs: 50 },
  );
  defer(cleanupB);

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 2, "同 PID 下必須建立兩個獨立的 UUID 狀態檔");

  const sessions = files.map((f) => readJson(join(dir, f))).flatMap((s) => Object.keys(s.sessions));
  assert.equal(sessions.includes("ses_A"), true);
  assert.equal(sessions.includes("ses_B"), true);

  await cleanupA();
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 1, "清理 A 必須僅刪除 A 的檔案");

  await cleanupB();
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 0, "清理 B 必須刪除 B 的檔案");
});

test("opencode-plugin: 權威 active 協定移除已完成 session 且不保留 idle", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-snap-", t);
  let activeMap = { ses_1: { type: "running" }, ses_2: { type: "running" } };
  const cleanup = await plugin.setup(mockContext(() => activeMap), { stateDir: dir, pollIntervalMs: 30 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));
  assert.equal(Object.keys(readJson(stateFile).sessions).length, 2);

  // ses_1 完成 -> 自 activeMap 移除
  activeMap = { ses_2: { type: "running" } };
  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_1 === undefined && s.sessions.ses_2?.status === "running";
  }, "已完成的 session 必須被刪除，不得保留");

  // 兩者皆完成
  activeMap = {};
  await waitFor(() => {
    const s = readJson(stateFile);
    return Object.keys(s.sessions).length === 0;
  }, "所有已完成的 session 皆已刪除");
});

test("opencode-plugin: 不持久化敏感錯誤訊息或原始 payload 資料", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-sensitive-", t);
  const cleanup = await plugin.setup(
    mockContext({
      ses_sec: {
        type: "running",
        secretToken: "sk-super-secret",
        errorMessage: "Sensitive error message from provider",
      },
    }),
    { stateDir: dir, pollIntervalMs: 50 },
  );
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));
  const rawContent = readFileSync(stateFile, "utf8");
  assert.equal(rawContent.includes("sk-super-secret"), false);
  assert.equal(rawContent.includes("Sensitive error message"), false);

  const parsed = JSON.parse(rawContent);
  assert.equal(parsed.sessions.ses_sec.status, "running");
  assert.equal(parsed.sessions.ses_sec.secretToken, undefined);
  assert.equal(parsed.sessions.ses_sec.errorMessage, undefined);
});

test("opencode-plugin: 懸掛的 active() 請求受逾時限制且不阻礙關閉", { timeout: 3000 }, async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-timeout-", t);
  const cleanup = await plugin.setup(
    mockContext(() => new Promise(() => {})), // 永不 resolve
    { stateDir: dir, pollIntervalMs: 50, activeTimeoutMs: 80 },
  );
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));
  assert.equal(existsSync(stateFile), true);

  const start = Date.now();
  await cleanup();
  assert.equal(Date.now() - start < 1000, true, "清理過程不得懸掛阻斷");
  assert.equal(existsSync(stateFile), false);
});

test("opencode-plugin: 清理後遲到的完成不重建狀態檔", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-late-", t);
  let resolveActive;
  const cleanup = await plugin.setup(
    mockContext(() => new Promise((resolve) => { resolveActive = resolve; })),
    { stateDir: dir, pollIntervalMs: 500, activeTimeoutMs: 50 },
  );
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));
  assert.equal(existsSync(stateFile), true);

  // 在 active 請求仍處於 pending 時停止外掛
  await cleanup();
  assert.equal(existsSync(stateFile), false);

  // 外掛已清理後遲到的 resolve，排空事件循環確認不被處理
  resolveActive?.({ ses_late: { type: "running" } });
  await new Promise((r) => setImmediate(r));

  assert.equal(existsSync(stateFile), false, "遲到的完成不得重建狀態檔");
});

test("opencode-plugin: 成功取得 active 後持續失敗不會重新整理心跳並在讀取端過期", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-expire-", t);
  let failActive = false;
  let callCount = 0;
  const cleanup = await plugin.setup(
    mockContext(async () => {
      callCount += 1;
      if (failActive) throw new Error("API failure");
      return { ses_1: { type: "running" } };
    }),
    { stateDir: dir, pollIntervalMs: 30, activeTimeoutMs: 50 },
  );
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // 初始狀態為 working
  let status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 100 });
  assert.equal(status.working, true);
  assert.equal(status.activeSessions.includes("ses_1"), true);

  const firstHeartbeat = readJson(stateFile).heartbeat;

  // 接著持續失敗
  failActive = true;
  const callsBefore = callCount;
  await waitFor(
    () => callCount >= callsBefore + 2 && Date.now() - firstHeartbeat > 110,
    "等待失敗輪詢週期與心跳逾時推進",
  );

  const stateAfterFailures = readJson(stateFile);
  assert.equal(stateAfterFailures.heartbeat, firstHeartbeat, "API 失敗時不得重新整理心跳");

  // 心跳過期後讀取端必須視為 working: false
  status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 100 });
  assert.equal(status.working, false, "逾時後讀取端必須判斷為非 working");
});

test("opencode-plugin: 跨多個週期最多僅有一個進行中請求且遲到的 resolve 不寫入", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-inflight-", t);
  let callCount = 0;
  let resolveActive;
  const cleanup = await plugin.setup(
    mockContext(() => {
      callCount += 1;
      return new Promise((resolve) => { resolveActive = resolve; });
    }),
    { stateDir: dir, pollIntervalMs: 25, activeTimeoutMs: 40 },
  );
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // 初始 setup 啟動第 1 次呼叫，等待 80ms 保留跨數個輪詢週期（>3 個 25ms 週期）的進行中時間語意
  await sleep(80);
  assert.equal(callCount, 1, "跨間隔週期絕不得有重疊的底層呼叫");

  // 逾時後延遲 resolve 並排空事件循環微任務
  resolveActive({ ses_late: { type: "running" } });
  await new Promise((r) => setImmediate(r));

  const state = readJson(stateFile);
  assert.equal(state.sessions.ses_late, undefined, "逾時後遲到的結果不得寫入");
});

test("opencode-plugin: 嚴格驗證非包裝映射並拒絕畸形／經包裝／idle 資料", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-val-", t);
  let activeCalls = 0;
  let currentResponse = { ses_valid_init: { type: "running" } };
  const cleanup = await plugin.setup(
    mockContext(async () => {
      activeCalls += 1;
      return currentResponse;
    }),
    { stateDir: dir, pollIntervalMs: 25, activeTimeoutMs: 50 },
  );
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // 驗證初始有效快照成功寫入
  await waitFor(() => existsSync(stateFile) && readJson(stateFile).sessions.ses_valid_init?.status === "running");
  const initialSnapshot = readJson(stateFile);

  const invalidCases = [
    { name: "包裹物件", res: { data: { ses_enveloped: { type: "running" } } } },
    { name: "非活躍狀態", res: { ses_idle: { type: "idle" } } },
    { name: "無效 session 鍵名", res: { arbitrary_key: { type: "running" } } },
    { name: "陣列型態", res: [{ type: "running" }] },
    { name: "空值物件", res: null },
  ];

  for (const { name, res } of invalidCases) {
    currentResponse = res;
    const targetCalls = activeCalls + 1;
    await waitFor(() => activeCalls >= targetCalls, `等待消費 ${name} 回應`);
    await new Promise((r) => setImmediate(r));

    const state = readJson(stateFile);
    assert.deepEqual(state.sessions, initialSnapshot.sessions, `${name} 回應不得變更 sessions 狀態`);
    assert.equal(state.heartbeat, initialSnapshot.heartbeat, `${name} 回應不得更新心跳`);
  }

  // 後續合法回應：必須被接受且更新快照
  currentResponse = { ses_valid_next: { type: "running" } };
  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_valid_next?.status === "running" && !s.sessions.ses_valid_init;
  }, "後續有效回應必須被成功套用");
});

test("opencode-plugin: 重複 setup 與清理可恢復行程接聽程式數量且不更動信號", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-listeners-", t);
  const exitBefore = process.listenerCount("exit");
  const sigtermBefore = process.listenerCount("SIGTERM");
  const sigintBefore = process.listenerCount("SIGINT");
  const ctx = mockContext({});

  for (let i = 0; i < 3; i++) {
    const cleanup = await plugin.setup(ctx, { stateDir: dir, pollIntervalMs: 100 });
    defer(cleanup);
    assert.equal(process.listenerCount("SIGTERM"), sigtermBefore, "外掛不得加入 SIGTERM 接聽程式");
    assert.equal(process.listenerCount("SIGINT"), sigintBefore, "外掛不得加入 SIGINT 接聽程式");
    await cleanup();
  }

  // 經過多次清理後，接聽程式數量必須完全復原
  assert.equal(process.listenerCount("exit"), exitBefore, "清理後 exit 接聽程式數量必須復原");
  assert.equal(process.listenerCount("SIGTERM"), sigtermBefore);
  assert.equal(process.listenerCount("SIGINT"), sigintBefore);
});
