import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import plugin from "../opencode-plugin.mjs";
import { getOpenCodeStatus } from "../opencode.mjs";

test("opencode-plugin: 完全自給自足且無任何相對路徑引入", () => {
  const code = readFileSync(join(process.cwd(), "opencode-plugin.mjs"), "utf8");
  const relativeImportRegex = /from\s+["'](\.\/|\.\.\/)/g;
  const matches = [...code.matchAll(relativeImportRegex)];
  assert.equal(matches.length, 0, "opencode-plugin.mjs 不得包含任何相對路徑引入");
  assert.equal(typeof plugin.setup, "function");
  assert.equal(plugin.id, "herdr.keep-awake");
});

test(
  "opencode-plugin: 同 PID 下的兩個專案實例各自獨立寫入與清理",
  async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plug-multi-"));
  try {
    const ctxA = {
      location: { directory: "/project/A" },
      session: {
        active: async () => ({ ses_A: { type: "running" } }),
      },
    };
    const ctxB = {
      location: { directory: "/project/B" },
      session: {
        active: async () => ({ ses_B: { type: "running" } }),
      },
    };

    // 在同一個行程中啟動實例 A 與 B
    const cleanupA = await plugin.setup(ctxA, { stateDir: dir, pollIntervalMs: 50 });
    const cleanupB = await plugin.setup(ctxB, { stateDir: dir, pollIntervalMs: 50 });

    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 2, "同 PID 下必須建立兩個獨立的 UUID 狀態檔");

    // 讀取兩個檔案
    const states = files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
    const sessions = states.flatMap((s) => Object.keys(s.sessions));
    assert.equal(sessions.includes("ses_A"), true);
    assert.equal(sessions.includes("ses_B"), true);

    // 僅清理 A -> B 必須保持完整
    await cleanupA();
    const remaining = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(remaining.length, 1, "清理 A 必須僅刪除 A 的檔案");

    await cleanupB();
    const afterAll = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(afterAll.length, 0, "清理 B 必須刪除 B 的檔案");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode-plugin: 權威 active 協定移除已完成 session 且不保留 idle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plug-snap-"));
  try {
    let activeMap = { ses_1: { type: "running" }, ses_2: { type: "running" } };
    const ctx = {
      location: { directory: "/project" },
      session: {
        active: async () => activeMap,
      },
    };

    const cleanup = await plugin.setup(ctx, { stateDir: dir, pollIntervalMs: 50 });
    const file = readdirSync(dir).find((f) => f.endsWith(".json"));
    let state = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(Object.keys(state.sessions).length, 2);

    // Session 1 完成 -> 自 activeMap 移除
    activeMap = { ses_2: { type: "running" } };
    await new Promise((r) => setTimeout(r, 120));

    state = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(state.sessions.ses_1, undefined, "已完成的 session 必須被刪除，不得保留");
    assert.equal(state.sessions.ses_2?.status, "running");

    // 兩者皆完成
    activeMap = {};
    await new Promise((r) => setTimeout(r, 120));

    state = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(Object.keys(state.sessions).length, 0, "所有已完成的 session 皆已刪除");

    await cleanup();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode-plugin: 不持久化敏感錯誤訊息或原始 payload 資料", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plug-sensitive-"));
  try {
    const ctx = {
      location: { directory: "/project" },
      session: {
        active: async () => ({
          ses_sec: {
            type: "running",
            secretToken: "sk-super-secret",
            errorMessage: "Sensitive error message from provider",
          },
        }),
      },
    };

    const cleanup = await plugin.setup(ctx, { stateDir: dir, pollIntervalMs: 50 });
    const file = readdirSync(dir).find((f) => f.endsWith(".json"));
    const rawContent = readFileSync(join(dir, file), "utf8");
    assert.equal(rawContent.includes("sk-super-secret"), false);
    assert.equal(rawContent.includes("Sensitive error message"), false);

    const parsed = JSON.parse(rawContent);
    assert.deepEqual(parsed.sessions.ses_sec.status, "running");
    assert.equal(parsed.sessions.ses_sec.secretToken, undefined);
    assert.equal(parsed.sessions.ses_sec.errorMessage, undefined);

    await cleanup();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode-plugin: 懸掛的 active() 請求受逾時限制且不阻礙關閉", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plug-timeout-"));
  try {
    const ctx = {
      location: { directory: "/project" },
      session: {
        active: async () => {
          // 永不 resolve
          await new Promise(() => {});
        },
      },
    };

    const cleanup = await plugin.setup(ctx, {
      stateDir: dir,
      pollIntervalMs: 50,
      activeTimeoutMs: 100, // 測試用短逾時
    });

    const file = readdirSync(dir).find((f) => f.endsWith(".json"));
    assert.equal(Boolean(file), true);

    // 清理應迅速完成，無需等待懸掛的 promise
    const start = Date.now();
    await cleanup();
    assert.equal(Date.now() - start < 1000, true, "清理過程不得懸掛阻斷");
    assert.equal(existsSync(join(dir, file)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode-plugin: 清理後遲到的完成不重建狀態檔", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plug-late-"));
  try {
    let resolveActive;
    const ctx = {
      location: { directory: "/project" },
      session: {
        active: () =>
          new Promise((resolve) => {
            resolveActive = resolve;
          }),
      },
    };

    const cleanup = await plugin.setup(ctx, {
      stateDir: dir,
      pollIntervalMs: 500,
      activeTimeoutMs: 50,
    });

    const file = readdirSync(dir).find((f) => f.endsWith(".json"));
    assert.equal(Boolean(file), true);

    // 在 active 請求仍處於 pending 時停止外掛
    await cleanup();
    assert.equal(existsSync(join(dir, file)), false);

    // 外掛已清理後遲到的 resolve
    resolveActive?.({ ses_late: { type: "running" } });
    await new Promise((r) => setTimeout(r, 100));

    // 不得重新建立檔案
    assert.equal(existsSync(join(dir, file)), false, "遲到的完成不得重建狀態檔");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode-plugin: 成功取得 active 後持續失敗不會重新整理心跳並在讀取端過期", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plug-expire-"));
  try {
    let failActive = false;
    const ctx = {
      location: { directory: "/project" },
      session: {
        active: async () => {
          if (failActive) {
            throw new Error("API failure");
          }
          return { ses_1: { type: "running" } };
        },
      },
    };

    const cleanup = await plugin.setup(ctx, {
      stateDir: dir,
      pollIntervalMs: 30,
      activeTimeoutMs: 50,
    });

    const file = readdirSync(dir).find((f) => f.endsWith(".json"));
    assert.equal(Boolean(file), true);

    // 初始狀態為 working
    let status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 120 });
    assert.equal(status.working, true);
    assert.equal(status.activeSessions.includes("ses_1"), true);

    const firstHeartbeat = JSON.parse(readFileSync(join(dir, file), "utf8")).heartbeat;

    // 接著持續失敗
    failActive = true;
    // 等待數個輪詢週期並超過心跳逾時時間
    await new Promise((r) => setTimeout(r, 200));

    const stateAfterFailures = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(
      stateAfterFailures.heartbeat,
      firstHeartbeat,
      "API 失敗時不得重新整理心跳",
    );

    // 心跳過期後讀取端必須視為 working: false
    status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 120 });
    assert.equal(status.working, false, "逾時後讀取端必須判斷為非 working");

    await cleanup();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode-plugin: 跨多個週期最多僅有一個進行中請求且遲到的 resolve 不寫入", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plug-inflight-"));
  try {
    let callCount = 0;
    let resolveActive;
    const ctx = {
      location: { directory: "/project" },
      session: {
        active: () => {
          callCount += 1;
          return new Promise((resolve) => {
            resolveActive = resolve;
          });
        },
      },
    };

    const cleanup = await plugin.setup(ctx, {
      stateDir: dir,
      pollIntervalMs: 25,
      activeTimeoutMs: 40,
    });

    const file = readdirSync(dir).find((f) => f.endsWith(".json"));
    assert.equal(Boolean(file), true);

    // 初始 setup 啟動了第 1 次呼叫。在呼叫仍處於 pending 期間讓多個間隔週期觸發
    await new Promise((r) => setTimeout(r, 160));

    assert.equal(
      callCount,
      1,
      "跨間隔週期絕不得有重疊的底層呼叫",
    );

    // 接著延遲 resolve（已超過 activeTimeoutMs）
    resolveActive({ ses_late: { type: "running" } });
    await new Promise((r) => setTimeout(r, 60));

    // 逾時後遲到的結果不得將 sessions 寫入狀態
    const state = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(state.sessions.ses_late, undefined, "逾時後遲到的結果不得寫入");

    await cleanup();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode-plugin: 嚴格驗證非包裝映射並拒絕畸形／經包裝／idle 資料", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plug-val-"));
  try {
    let currentResponse = { data: { ses_1: { type: "running" } } }; // 經包裝（enveloped）：必須被拒絕！
    const ctx = {
      location: { directory: "/project" },
      session: {
        active: async () => currentResponse,
      },
    };

    const cleanup = await plugin.setup(ctx, {
      stateDir: dir,
      pollIntervalMs: 40,
      activeTimeoutMs: 50,
    });

    const file = readdirSync(dir).find((f) => f.endsWith(".json"));
    let state = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(
      Object.keys(state.sessions).length,
      0,
      "經包裝的資料必須被拒絕且不得填入 sessions",
    );

    // 任意 idle 物件：必須被拒絕！
    currentResponse = { ses_idle: { type: "idle" } };
    await new Promise((r) => setTimeout(r, 70));
    state = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(
      state.sessions.ses_idle,
      undefined,
      "idle 物件必須被拒絕，不得標記為活躍",
    );

    // 非 'ses' 開頭的任意鍵：必須被拒絕！
    currentResponse = { arbitrary_key: { type: "running" } };
    await new Promise((r) => setTimeout(r, 70));
    state = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(
      state.sessions.arbitrary_key,
      undefined,
      "非 ses 開頭的鍵必須被拒絕",
    );

    // 具備 ses 字首且 type 為 running 的有效非包裝回應：必須被接受！
    currentResponse = { ses_valid: { type: "running" } };
    await new Promise((r) => setTimeout(r, 70));
    state = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(state.sessions.ses_valid?.status, "running");

    await cleanup();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode-plugin: 重複 setup 與清理可恢復行程接聽程式數量且不更動信號", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-plug-listeners-"));
  try {
    const exitBefore = process.listenerCount("exit");
    const sigtermBefore = process.listenerCount("SIGTERM");
    const sigintBefore = process.listenerCount("SIGINT");

    const ctx = {
      location: { directory: "/project" },
      session: {
        active: async () => ({}),
      },
    };

    for (let i = 0; i < 5; i++) {
      const cleanup = await plugin.setup(ctx, {
        stateDir: dir,
        pollIntervalMs: 100,
      });
      // 於 setup 期間僅可加入 exit 接聽程式；絕不可加入 SIGTERM 或 SIGINT
      assert.equal(process.listenerCount("SIGTERM"), sigtermBefore, "外掛不得加入 SIGTERM 接聽程式");
      assert.equal(process.listenerCount("SIGINT"), sigintBefore, "外掛不得加入 SIGINT 接聽程式");
      await cleanup();
    }

    // 經過多次清理後，exit 接聽程式數量必須完全復原
    assert.equal(
      process.listenerCount("exit"),
      exitBefore,
      "清理後 exit 接聽程式數量必須復原",
    );
    assert.equal(process.listenerCount("SIGTERM"), sigtermBefore);
    assert.equal(process.listenerCount("SIGINT"), sigintBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
