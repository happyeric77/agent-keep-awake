import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import plugin from "../opencode-plugin.mjs";
import { getOpenCodeStatus } from "../opencode.mjs";
import { createMockOpenCodeContext, createTestDir, readJson, repoRoot, sleep, waitFor } from "./helpers.mjs";

test("opencode-plugin: 完全自給自足且無任何相對路徑引入", () => {
  const code = readFileSync(join(repoRoot, "opencode-plugin.mjs"), "utf8");
  const relativeImportRegex = /from\s+["'](\.\/|\.\.\/)/g;
  const matches = [...code.matchAll(relativeImportRegex)];
  assert.equal(matches.length, 0, "opencode-plugin.mjs 不得包含任何相對路徑引入");
  assert.equal(typeof plugin.setup, "function");
  assert.equal(plugin.id, "herdr.keep-awake");
});

test("opencode-plugin: 暴露 bug - 真實 OpenCode 2.0.26 環境無 ctx.session.active 時必須透過事件訂閱追蹤 session", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-bug-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/test" });

  // 驗證真實 OpenCode 2.0.26 形狀：ctx.session 沒有 active 函式
  assert.equal(context.session.active, undefined, "真實 OpenCode 2.0.26 Plugin context 的 ctx.session 不得有 active");

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));
  assert.equal(existsSync(stateFile), true);

  // 發出 session 執行開始事件
  emit({
    id: "evt_1",
    type: "session.execution.started",
    created: Date.now(),
    data: { sessionID: "ses_started_1" },
  });

  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_started_1?.status === "running";
  }, "必須透過 session.execution.started 事件記錄活躍 session");
});

test("opencode-plugin: 同 PID 下的兩個專案實例各自獨立寫入與清理", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-multi-", t);
  const { context: ctxA, emit: emitA } = createMockOpenCodeContext({ directory: "/project/A" });
  const { context: ctxB, emit: emitB } = createMockOpenCodeContext({ directory: "/project/B" });

  const cleanupA = await plugin.setup(ctxA, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanupA);
  const cleanupB = await plugin.setup(ctxB, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanupB);

  emitA({ id: "evt_a", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_A" } });
  emitB({ id: "evt_b", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_B" } });

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 2, "同 PID 下必須建立兩個獨立的 UUID 狀態檔");

  await waitFor(() => {
    const sessions = files.map((f) => readJson(join(dir, f))).flatMap((s) => Object.keys(s.sessions));
    return sessions.includes("ses_A") && sessions.includes("ses_B");
  }, "兩個實例必須各自記錄各自的 session");

  await cleanupA();
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 1, "清理 A 必須僅刪除 A 的檔案");

  await cleanupB();
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 0, "清理 B 必須刪除 B 的檔案");
});

test("opencode-plugin: 事件訂閱追蹤 session.execution.started 與結束（succeeded/failed/interrupted）", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-exec-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/exec" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // 啟動 3 個 session
  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_1" } });
  emit({ id: "e2", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_2" } });
  emit({ id: "e3", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_3" } });

  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_1 && s.sessions.ses_2 && s.sessions.ses_3;
  }, "所有 3 個 session 皆已進入活躍狀態");

  // ses_1 成功結束
  emit({ id: "e4", type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "ses_1" } });
  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_1 === undefined && s.sessions.ses_2 && s.sessions.ses_3;
  }, "ses_1 成功結束後必須自活躍清單移除");

  // ses_2 失敗結束
  emit({ id: "e5", type: "session.execution.failed", created: Date.now(), data: { sessionID: "ses_2", error: { message: "fail" } } });
  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_2 === undefined && s.sessions.ses_3;
  }, "ses_2 失敗結束後必須自活躍清單移除");

  // ses_3 被中斷
  emit({ id: "e6", type: "session.execution.interrupted", created: Date.now(), data: { sessionID: "ses_3", reason: "user" } });
  await waitFor(() => {
    const s = readJson(stateFile);
    return Object.keys(s.sessions).length === 0;
  }, "所有 session 結束後活躍清單必須為空");
});

test("opencode-plugin: 涵蓋真實 v2.0.26 事件：session.retry.scheduled 與進行中事件維持活躍，execution 成功結束轉為閒置", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-retry-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/retry" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // 1. session.execution.started 建立活躍
  emit({
    id: "e1",
    type: "session.execution.started",
    created: Date.now(),
    data: { sessionID: "ses_task" },
  });

  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_task?.status === "running";
  }, "session.execution.started 必須記錄為活躍狀態");

  // 2. provider 重試等待（Retry/Backoff）：真實 OpenCode v2.0.26 發射 session.retry.scheduled
  emit({
    id: "e2",
    type: "session.retry.scheduled",
    created: Date.now(),
    data: { sessionID: "ses_task", assistantMessageID: "msg_1", attempt: 1, at: Date.now() + 5000 },
  });

  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_task?.status === "running";
  }, "session.retry.scheduled 必須維持活躍狀態");

  // 3. 進行中連續事件（如 tool progress、step streamed、text delta）維持活躍
  emit({
    id: "e3",
    type: "session.tool.progress",
    created: Date.now(),
    data: { sessionID: "ses_task", metadata: { progress: 50 } },
  });

  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_task?.status === "running";
  }, "session.tool.progress 必須維持活躍狀態");

  // 4. session.execution.succeeded 正常完成並轉為閒置
  emit({
    id: "e4",
    type: "session.execution.succeeded",
    created: Date.now(),
    data: { sessionID: "ses_task" },
  });

  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_task === undefined;
  }, "session.execution.succeeded 必須移除該 session");
});

test("opencode-plugin: 任務斷線前已安靜超過 lease 仍在重連寬限保持 working", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-silent-before-", t);
  const { context, emit, setStreamFail, getSubscribeCount } = createMockOpenCodeContext({ directory: "/project/silent-before" });

  // 設定租約為 120ms
  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 30, sessionLeaseMs: 120 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // 1. 任務啟動
  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_silent_before" } });
  await waitFor(() => readJson(stateFile).sessions.ses_silent_before?.status === "running");

  // 2. 在健康串流下保持安靜超過租約時間 (160ms > 120ms)
  await sleep(160);

  // 驗證健康串流下活動絕不得因安靜到期被刪除
  assert.equal(readJson(stateFile).sessions.ses_silent_before?.status, "running", "健康串流下沉默任務不得被清理");

  // 3. 模擬短暫斷線
  setStreamFail(true);
  await sleep(40);

  // 4. 重連，確實等待連線次數增加
  setStreamFail(false);
  await waitFor(() => getSubscribeCount() >= 2, "重連必須確實觸發第二次訂閱");

  // 5. 重連後立即檢查：舊 updatedAt 雖然已超時，但因獲得重連寬限租約，仍必須維持 working
  const stateAfterReconnect = readJson(stateFile);
  assert.equal(stateAfterReconnect.sessions.ses_silent_before?.status, "running", "重連寬限期內即便舊時間已過期仍必須保持 running");

  const status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 500 });
  assert.equal(status.working, true, "斷線前安靜超過租約之任務在重連寬限期內讀取端必須保持 working");
  assert.equal(status.activeSessions.includes("ses_silent_before"), true);
});

test("opencode-plugin: 健康 stream 沉默超過 lease 仍保持 working", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-healthy-silent-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/healthy-silent" });

  // 設定租約為 100ms
  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 25, sessionLeaseMs: 100 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_healthy_silent" } });
  await waitFor(() => readJson(stateFile).sessions.ses_healthy_silent?.status === "running");

  // 串流持續健康，心跳定時器持續運作，但無任何新事件長達 250ms（超過 2 倍租約）
  await sleep(250);

  const state = readJson(stateFile);
  assert.equal(state.sessions.ses_healthy_silent?.status, "running", "健康串流下沉默長任務絕不因租約過期被刪除");

  const status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 500 });
  assert.equal(status.working, true, "健康串流下沉默任務必須持續保持 working");
  assert.equal(status.activeSessions.includes("ses_healthy_silent"), true);
});

test("opencode-plugin: 重連寬限期內若有新活動則清除 unconfirmed lease 保持 working", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-lease-renew-", t);
  const { context, emit, setStreamFail, getSubscribeCount } = createMockOpenCodeContext({ directory: "/project/lease-renew" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 25, sessionLeaseMs: 120 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_renew" } });
  await waitFor(() => readJson(stateFile).sessions.ses_renew?.status === "running");

  // 斷線
  setStreamFail(true);
  await sleep(40);

  // 重連
  setStreamFail(false);
  await waitFor(() => getSubscribeCount() >= 2, "重連必須觸發訂閱");

  // 在重連寬限期內發射新活動事件，確認租約應被清除為健康狀態
  emit({ id: "e2", type: "session.tool.progress", created: Date.now(), data: { sessionID: "ses_renew", metadata: {} } });

  // 等待超過重連租約時間 (180ms > 120ms)
  await sleep(180);

  // 驗證未被當成幽靈 session 清理
  const state = readJson(stateFile);
  assert.equal(state.sessions.ses_renew?.status, "running", "收到新活動後未確認租約必須被清除並維持 running");

  const status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 500 });
  assert.equal(status.working, true);
  assert.equal(status.activeSessions.includes("ses_renew"), true);
});

test("opencode-plugin: 正常 EOF 終止具備有界退避且重新連上但安靜時心跳健康", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-eof-", t);
  const { context, emit, closeStream, getSubscribeCount } = createMockOpenCodeContext({ directory: "/project/eof" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 40, sessionLeaseMs: 150 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // 建立初始活躍狀態
  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_eof" } });
  await waitFor(() => readJson(stateFile).sessions.ses_eof?.status === "running");

  const initialCount = getSubscribeCount();
  assert.equal(initialCount, 1, "初次連線僅訂閱 1 次");

  // 正常 EOF 關閉串流
  closeStream();

  // 確實等待退避重連觸發（非空泛等待）
  await waitFor(() => getSubscribeCount() >= 2, "正常 EOF 後必須觸發重新訂閱");

  const countAfterEof = getSubscribeCount();
  assert.equal(countAfterEof <= initialCount + 4, true, "必須遵守有界退避，不得形成緊密無窮迴圈");

  // 重新連上但環境安靜：等待幽靈 session 租約過期後被清除
  await waitFor(() => {
    const s = readJson(stateFile);
    return Object.keys(s.sessions).length === 0;
  }, "重新連上後幽靈 session 應被清除");

  const status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 500 });
  assert.equal(status.working, false, "安靜重連後必須允許休眠");
});

test("opencode-plugin: 啟動前已活躍/斷線期間持續工作依真實 v2.0.26 進行中事件恢復", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-resume-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/resume" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // 錯過 execution.started，直接收到 session.step.started 進行中事件
  emit({
    id: "step_1",
    type: "session.step.started",
    created: Date.now(),
    data: { sessionID: "ses_ongoing" },
  });

  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_ongoing?.status === "running";
  }, "收到 session.step.started 必須能將既有工作恢復為 running");

  // 收到 session.text.delta 維持活躍
  emit({
    id: "text_1",
    type: "session.text.delta",
    created: Date.now(),
    data: { sessionID: "ses_ongoing" },
  });

  await sleep(50);
  assert.equal(readJson(stateFile).sessions.ses_ongoing?.status, "running");

  // 收到 session.execution.failed 結束
  emit({
    id: "fail_1",
    type: "session.execution.failed",
    created: Date.now(),
    data: { sessionID: "ses_ongoing", error: { message: "timeout" } },
  });

  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_ongoing === undefined;
  }, "session.execution.failed 必須移除該 session");
});

test("opencode-plugin: 同步返回 AsyncIterable 可正常運作", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-sync-", t);
  let queue = [];
  let notify = null;
  let closed = false;

  const syncContext = {
    location: { directory: "/project/sync" },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              while (queue.length === 0) {
                if (closed) return { done: true, value: undefined };
                await new Promise((r) => {
                  notify = r;
                });
              }
              const item = queue.shift();
              return { done: false, value: item };
            },
            async return() {
              closed = true;
              return { done: true, value: undefined };
            },
          };
        },
      }),
    },
  };

  const cleanup = await plugin.setup(syncContext, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  queue.push({ id: "e1", type: "session.execution.started", data: { sessionID: "ses_sync" } });
  if (notify) notify();

  await waitFor(() => readJson(stateFile).sessions.ses_sync?.status === "running", "同步 AsyncIterable 必須正常處理事件");
});

test("opencode-plugin: 防護特殊 session ID key 與 cleanup 可取消退避計時器", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-proto-", t);
  const { context, emit, setStreamFail } = createMockOpenCodeContext({ directory: "/project/proto" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // 特殊原型屬性名稱注入測試
  emit({ id: "p1", type: "session.execution.started", data: { sessionID: "__proto__" } });
  emit({ id: "p2", type: "session.execution.started", data: { sessionID: "constructor" } });
  emit({ id: "p3", type: "session.execution.started", data: { sessionID: "prototype" } });

  await sleep(60);
  const state = readJson(stateFile);
  assert.equal(state.sessions.__proto__, Object.prototype);
  assert.equal(Object.hasOwn(state.sessions, "__proto__"), false);
  assert.equal(Object.hasOwn(state.sessions, "constructor"), false);
  assert.equal(Object.hasOwn(state.sessions, "prototype"), false);

  // 測試 cleanup 可立即取消正在退避中的計時器，絕不懸掛
  setStreamFail(true);
  await sleep(50); // 進入退避狀態

  const cleanupStart = Date.now();
  await cleanup();
  const cleanupDuration = Date.now() - cleanupStart;
  assert.equal(cleanupDuration < 500, true, `cleanup 必須立即取消退避計時器（耗時: ${cleanupDuration}ms）`);
});

test("opencode-plugin: session.deleted 正確移除 session", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-del-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/del" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_del" } });
  await waitFor(() => readJson(stateFile).sessions.ses_del?.status === "running");

  emit({ id: "e2", type: "session.deleted", created: Date.now(), data: { sessionID: "ses_del" } });
  await waitFor(() => readJson(stateFile).sessions.ses_del === undefined, "session.deleted 必須移除該 session");
});

test("opencode-plugin: 不持久化敏感錯誤訊息或原始 payload 資料", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-sensitive-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/sec" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  emit({
    id: "e1",
    type: "session.retry.scheduled",
    created: Date.now(),
    data: {
      sessionID: "ses_sec",
      attempt: 1,
      secretToken: "sk-super-secret-token",
      prompt: "Tell me the secret recipe",
      errorMessage: "Sensitive error from upstream provider",
    },
  });

  await waitFor(() => readJson(stateFile).sessions.ses_sec?.status === "running");

  const rawContent = readFileSync(stateFile, "utf8");
  assert.equal(rawContent.includes("sk-super-secret"), false);
  assert.equal(rawContent.includes("secret recipe"), false);
  assert.equal(rawContent.includes("Sensitive error"), false);

  const parsed = JSON.parse(rawContent);
  assert.equal(parsed.sessions.ses_sec.status, "running");
  assert.equal(parsed.sessions.ses_sec.secretToken, undefined);
  assert.equal(parsed.sessions.ses_sec.prompt, undefined);
});

test("opencode-plugin: 懸掛或清理後遲到的事件不阻礙關閉且不重建狀態檔", { timeout: 3000 }, async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-late-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/late" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));
  assert.equal(existsSync(stateFile), true);

  const start = Date.now();
  await cleanup();
  assert.equal(Date.now() - start < 1000, true, "清理過程不得懸掛阻斷");
  assert.equal(existsSync(stateFile), false, "清理後狀態檔必須被刪除");

  // 清理後遲到的事件發出
  emit({ id: "e_late", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_late" } });
  await sleep(100);

  assert.equal(existsSync(stateFile), false, "清理後遲到的事件絕不得重建狀態檔");
});

test("opencode-plugin: 事件串流持續失敗時停止重新整理心跳並在讀取端過期", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-expire-", t);
  const { context, emit, setStreamFail } = createMockOpenCodeContext({ directory: "/project/expire" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 30 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // 產生活躍 session
  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_expire" } });
  await waitFor(() => readJson(stateFile).sessions.ses_expire?.status === "running");

  // 初始狀態為 working
  let status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 100 });
  assert.equal(status.working, true);
  assert.equal(status.activeSessions.includes("ses_expire"), true);

  const firstHeartbeat = readJson(stateFile).heartbeat;

  // 模擬串流中斷且重連持續失敗
  setStreamFail(true);

  // 等待心跳過期時間推進
  await sleep(150);

  const stateAfterFailures = readJson(stateFile);
  assert.equal(stateAfterFailures.heartbeat, firstHeartbeat, "串流持續失敗時不得重新整理心跳");

  // 心跳過期後讀取端必須視為 working: false
  status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 100 });
  assert.equal(status.working, false, "心跳逾時後讀取端必須判定為非 working");
});

test("opencode-plugin: 忽略無效/畸形事件且不更動 sessions 或心跳", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-val-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/val" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 500 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  emit({ id: "init", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_init" } });
  await waitFor(() => readJson(stateFile).sessions.ses_init?.status === "running");
  const snapshotBefore = readJson(stateFile);

  const invalidEvents = [
    null,
    undefined,
    {},
    { type: "session.execution.started" }, // 缺少 data
    { type: "session.execution.started", data: null },
    { type: "session.execution.started", data: { sessionID: 12345 } }, // 非字串
    { type: "session.execution.started", data: { sessionID: "invalid_prefix" } }, // 非 ses 開頭
    { type: "unrelated.event", data: { sessionID: "ses_other" } },
  ];

  for (const invalid of invalidEvents) {
    emit(invalid);
  }

  await sleep(60);

  const snapshotAfter = readJson(stateFile);
  assert.deepEqual(snapshotAfter.sessions, snapshotBefore.sessions, "無效或無關事件不得變更 sessions 狀態");
  assert.equal(snapshotAfter.heartbeat, snapshotBefore.heartbeat, "無效或無關事件不得更新心跳");
});

test("opencode-plugin: 重複 setup 與清理可恢復行程接聽程式數量且不更動信號", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-listeners-", t);
  const exitBefore = process.listenerCount("exit");
  const sigtermBefore = process.listenerCount("SIGTERM");
  const sigintBefore = process.listenerCount("SIGINT");
  const { context } = createMockOpenCodeContext();

  for (let i = 0; i < 3; i++) {
    const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 100 });
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

test("opencode-plugin: shell.started 標為活躍，shell.ended 結束活躍；在輪次中執行時不造成假 idle", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-shell-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/shell" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // 1. 獨立 shell 指令：started -> running；ended -> idle (自 sessions 移除)
  emit({ id: "sh1", type: "session.shell.started", created: Date.now(), data: { sessionID: "ses_sh_standalone" } });
  await waitFor(() => readJson(stateFile).sessions.ses_sh_standalone?.status === "running");

  emit({ id: "sh2", type: "session.shell.ended", created: Date.now(), data: { sessionID: "ses_sh_standalone" } });
  await waitFor(() => readJson(stateFile).sessions.ses_sh_standalone === undefined, "獨立 shell 結束後必須轉為 idle");

  // 2. 輪次中執行的 shell 指令：輪次開始 -> shell 開始 -> shell 結束 (不可假 idle) -> 輪次結束
  emit({ id: "ex1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_sh_turn" } });
  await waitFor(() => readJson(stateFile).sessions.ses_sh_turn?.status === "running");

  emit({ id: "sh3", type: "session.shell.started", created: Date.now(), data: { sessionID: "ses_sh_turn" } });
  await sleep(40);
  assert.equal(readJson(stateFile).sessions.ses_sh_turn?.status, "running");

  emit({ id: "sh4", type: "session.shell.ended", created: Date.now(), data: { sessionID: "ses_sh_turn" } });
  await sleep(40);
  assert.equal(readJson(stateFile).sessions.ses_sh_turn?.status, "running", "輪次內 shell.ended 絕不得導致假 idle");

  emit({ id: "ex2", type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "ses_sh_turn" } });
  await waitFor(() => readJson(stateFile).sessions.ses_sh_turn === undefined, "執行輪次成功完成後轉為 idle");
});

test("opencode-plugin: compaction.started/delta 標為活躍，compaction.ended/failed 結束活躍；涵蓋 delta 與輪次組合", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-compact-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/compact" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // 1. 自動/獨立 compaction：started -> delta -> ended
  emit({ id: "c1", type: "session.compaction.started", created: Date.now(), data: { sessionID: "ses_comp_auto" } });
  await waitFor(() => readJson(stateFile).sessions.ses_comp_auto?.status === "running");

  emit({ id: "c2", type: "session.compaction.delta", created: Date.now(), data: { sessionID: "ses_comp_auto" } });
  await sleep(30);
  assert.equal(readJson(stateFile).sessions.ses_comp_auto?.status, "running");

  emit({ id: "c3", type: "session.compaction.ended", created: Date.now(), data: { sessionID: "ses_comp_auto" } });
  await waitFor(() => readJson(stateFile).sessions.ses_comp_auto === undefined, "獨立 compaction.ended 後必須轉為 idle");

  // 2. compaction.failed 結束
  emit({ id: "c4", type: "session.compaction.started", created: Date.now(), data: { sessionID: "ses_comp_fail" } });
  await waitFor(() => readJson(stateFile).sessions.ses_comp_fail?.status === "running");

  emit({ id: "c5", type: "session.compaction.failed", created: Date.now(), data: { sessionID: "ses_comp_fail" } });
  await waitFor(() => readJson(stateFile).sessions.ses_comp_fail === undefined, "compaction.failed 後必須轉為 idle");

  // 3. 輪次中觸發 compaction 與 tool.input.delta：compaction 結束不發生假 idle
  emit({ id: "ex1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_comp_turn" } });
  await waitFor(() => readJson(stateFile).sessions.ses_comp_turn?.status === "running");

  emit({ id: "t1", type: "session.tool.input.delta", created: Date.now(), data: { sessionID: "ses_comp_turn" } });
  emit({ id: "c6", type: "session.compaction.started", created: Date.now(), data: { sessionID: "ses_comp_turn" } });
  emit({ id: "c7", type: "session.compaction.delta", created: Date.now(), data: { sessionID: "ses_comp_turn" } });
  await sleep(40);
  assert.equal(readJson(stateFile).sessions.ses_comp_turn?.status, "running");

  emit({ id: "c8", type: "session.compaction.ended", created: Date.now(), data: { sessionID: "ses_comp_turn" } });
  await sleep(40);
  assert.equal(readJson(stateFile).sessions.ses_comp_turn?.status, "running", "輪次中 compaction.ended 不得造成假 idle");

  emit({ id: "ex2", type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "ses_comp_turn" } });
  await waitFor(() => readJson(stateFile).sessions.ses_comp_turn === undefined, "輪次結束後轉為 idle");
});

test("opencode-plugin: 當 ctx.event.subscribe 不存在時在寫入狀態檔前安全退出且不留檔案", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-nosub-", t);
  const contextWithoutSubscribe = {
    location: { directory: "/project/nosub" },
    event: {}, // 沒有 subscribe
  };

  const cleanup = await plugin.setup(contextWithoutSubscribe, { stateDir: dir });
  defer(cleanup);

  const jsonFiles = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.equal(jsonFiles.length, 0, "event.subscribe 不存在時絕不得在磁碟建立任何狀態檔");

  // cleanup 必須能正常呼叫且不拋出錯誤
  await assert.doesNotReject(async () => {
    await cleanup();
  });
});

test("opencode-plugin: 短暫斷線重連後沉默長任務受租約保護維持活躍（不被瞬間放睡）", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-lease-silent-", t);
  const { context, emit, setStreamFail, getSubscribeCount } = createMockOpenCodeContext({ directory: "/project/lease-silent" });

  // 設定租約為 500ms
  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 30, sessionLeaseMs: 500 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // 啟動一個長任務
  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_silent" } });
  await waitFor(() => readJson(stateFile).sessions.ses_silent?.status === "running");

  // 模擬短暫斷線 (50ms)
  setStreamFail(true);
  await sleep(50);

  // 重新連上（重連後該 session 為沉默長任務，未立即發送新事件）
  setStreamFail(false);
  await waitFor(() => getSubscribeCount() >= 2, "重連必須確實觸發第二次訂閱");

  // 驗證重連後在租約期限內，該任務仍被視為活躍 running，守護進程讀取端判定為 working: true
  const state = readJson(stateFile);
  assert.equal(state.sessions.ses_silent?.status, "running", "租約期間沉默長任務必須保留 running 狀態");

  const status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 500 });
  assert.equal(status.working, true, "重連後沉默長任務在租約內不得被瞬間放睡");
  assert.equal(status.activeSessions.includes("ses_silent"), true);
});

test("opencode-plugin: 斷線期間完成之任務在租約過期後自動清理幽靈 session 並允許休眠", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-lease-expire-", t);
  const { context, emit, setStreamFail, getSubscribeCount } = createMockOpenCodeContext({ directory: "/project/lease-expire" });

  // 設定租約為 120ms
  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 25, sessionLeaseMs: 120 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_ghost" } });
  await waitFor(() => readJson(stateFile).sessions.ses_ghost?.status === "running");

  // 模擬斷線
  setStreamFail(true);
  await sleep(40);

  // 重連，該任務在斷線期間已完成，重連後不再有任何事件
  setStreamFail(false);
  await waitFor(() => getSubscribeCount() >= 2, "重連必須確實觸發第二次訂閱");

  // 等待超過 120ms 租約過期
  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_ghost === undefined && Object.keys(s.sessions).length === 0;
  }, "租約到期後未獲後續事件之幽靈 session 必須被自動清除", 1000);

  const status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 500 });
  assert.equal(status.working, false, "幽靈 session 過期清理後讀取端必須允許休眠");
  assert.equal(status.activeSessions.length, 0);
});

test("opencode-plugin: 首次 iterator.next 待命、錯誤或 EOF 前不標記 healthy 亦不刷新 heartbeat", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-first-event-", t);
  let nextStarted = false;
  let resolveNext = null;

  const mockContext = {
    location: { directory: "/project/first-event" },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              nextStarted = true;
              return new Promise((resolve, reject) => {
                resolveNext = { resolve, reject };
              });
            },
            async return() {
              return { done: true, value: undefined };
            },
          };
        },
      }),
    },
  };

  const cleanup = await plugin.setup(mockContext, { stateDir: dir, pollIntervalMs: 20 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));
  await waitFor(() => nextStarted, "必須觸發首次 next 呼叫");

  const initialHeartbeat = readJson(stateFile).heartbeat;

  // 在首次 next 懸掛待命期間等待數個 poll 週期 (80ms)
  await sleep(80);

  // 驗證心跳在此待命期間絕無被刷新
  assert.equal(readJson(stateFile).heartbeat, initialHeartbeat, "首次收到事件前絕不得刷新心跳");

  // 首次 next 拋出錯誤
  resolveNext.reject(new Error("連線失敗"));
  await sleep(50);

  // 驗證心跳依然沒有被刷新
  assert.equal(readJson(stateFile).heartbeat, initialHeartbeat, "首次 next 失敗後絕不得刷新心跳");
});

test("opencode-plugin: 重複慢速 EOF/錯誤下退避時間必須持續累積不被重置", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-slow-backoff-", t);
  let subscribeAttempts = 0;
  const attemptTimestamps = [];

  const slowFailContext = {
    location: { directory: "/project/slow-fail" },
    event: {
      subscribe: () => {
        subscribeAttempts += 1;
        attemptTimestamps.push(Date.now());
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                // 每次連線皆慢速等待 60ms 後正常 EOF（從未收到任何有效 event）
                await sleep(60);
                return { done: true, value: undefined };
              },
              async return() {
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    },
  };

  const cleanup = await plugin.setup(slowFailContext, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  // 等待至少累積 3 次連線嘗試
  await waitFor(() => attemptTimestamps.length >= 3, "慢速 EOF 下必須累積至第 3 次嘗試", 3000);

  // 驗證嘗試次數在合理時間窗內受到指數退避之約束（不得緊密重試）
  assert.equal(subscribeAttempts >= 3, true, "必須觸發至少 3 次重試嘗試");
  assert.equal(subscribeAttempts <= 5, true, `慢速 EOF 下退避必須累積，不得重置（實際嘗試次數: ${subscribeAttempts}）`);

  // 驗證相鄰嘗試間距逐步拉長（無條件執行斷言）
  const gap1 = attemptTimestamps[1] - attemptTimestamps[0];
  const gap2 = attemptTimestamps[2] - attemptTimestamps[1];
  assert.equal(gap2 > gap1, true, `第 2 次間距 (${gap2}ms) 必須大於第 1 次間距 (${gap1}ms)`);
});

test("opencode-plugin: 首筆事件為畸形（null、{}、空字串 type）時不得標健康、不得刷新心跳且退避持續累積", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-malformed-first-", t);
  const { context, emit, closeStream, getSubscribeCount } = createMockOpenCodeContext({
    directory: "/project/malformed",
    autoConnectEvent: false,
  });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 500 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));
  const initialHeartbeat = readJson(stateFile).heartbeat;

  // 發射各種畸形首筆事件
  emit(null);
  emit({});
  emit({ type: "" });
  emit({ type: "   " });
  emit({ notType: "some_data" });

  await sleep(80);

  // 驗證心跳在此期間絕無被刷新
  assert.equal(readJson(stateFile).heartbeat, initialHeartbeat, "畸形首筆事件絕不得刷新心跳");

  // 關閉串流觸發 EOF
  closeStream();

  // 驗證必須觸發重新連線
  await waitFor(() => getSubscribeCount() >= 2, "畸形事件後串流結束必須觸發重新連線");

  // 在重連串流發射合法首筆事件
  emit({
    id: "ok_1",
    type: "session.execution.started",
    created: Date.now(),
    data: { sessionID: "ses_valid_after_retry" },
  });

  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_valid_after_retry?.status === "running" && s.heartbeat > initialHeartbeat;
  }, "收到合法首筆事件後必須記錄 session 並更新心跳");
});

test("opencode-plugin: execution 終止時自動清除 compaction 狀態防止孤立殘留", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-compact-clear-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/compact-clear" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // 1. execution 開始
  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_cc" } });
  await waitFor(() => readJson(stateFile).sessions.ses_cc?.status === "running");

  // 2. compaction 開始
  emit({ id: "c1", type: "session.compaction.started", created: Date.now(), data: { sessionID: "ses_cc" } });
  await sleep(30);
  assert.equal(readJson(stateFile).sessions.ses_cc?.status, "running");

  // 3. execution 失敗終止，未發射 compaction.ended
  emit({ id: "e2", type: "session.execution.failed", created: Date.now(), data: { sessionID: "ses_cc" } });

  // 驗證：因 compaction 僅存在於 execution 內，execution 終止時 compaction 必須一併清除，session 轉為 idle
  await waitFor(() => readJson(stateFile).sessions.ses_cc === undefined, "execution 終止必須一併清理 compaction 狀態");
});

test("opencode-plugin: shell.failed 終止 shell 活躍狀態", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-shell-fail-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/shell-fail" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  emit({ id: "sh1", type: "session.shell.started", created: Date.now(), data: { sessionID: "ses_sh_fail" } });
  await waitFor(() => readJson(stateFile).sessions.ses_sh_fail?.status === "running");

  emit({ id: "sh2", type: "session.shell.failed", created: Date.now(), data: { sessionID: "ses_sh_fail" } });
  await waitFor(() => readJson(stateFile).sessions.ses_sh_fail === undefined, "shell.failed 必須終止 shell 活躍狀態");
});
