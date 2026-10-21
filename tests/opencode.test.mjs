import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getOpenCodeStatus } from "../opencode.mjs";
import { createTestDir, mockSnapshot, writeJson } from "./helpers.mjs";

test("getOpenCodeStatus: 當目錄不存在時回傳非活躍狀態", () => {
  const nonExistentDir = join(tmpdir(), `test-opencode-none-${Date.now()}`);
  const status = getOpenCodeStatus({ opencodeDir: nonExistentDir });
  assert.equal(status.working, false);
  assert.equal(status.instancesCount, 0);
  assert.equal(status.activeSessions.length, 0);
});

test("getOpenCodeStatus: 處理 A running 與 B idle（idle 已自狀態中刪除）", (t) => {
  const { dir } = createTestDir("opencode-reader-", t);
  writeJson(join(dir, "inst-1.json"), mockSnapshot({ sessionA: { status: "running" } }));

  const status = getOpenCodeStatus({ opencodeDir: dir });
  assert.equal(status.working, true);
  assert.equal(status.activeSessions.includes("sessionA"), true);
  assert.equal(status.instancesCount, 1);
});

test("getOpenCodeStatus: 全部 idle（空 sessions）允許休眠", (t) => {
  const { dir } = createTestDir("opencode-reader-", t);
  writeJson(join(dir, "inst-1.json"), mockSnapshot({}));

  const status = getOpenCodeStatus({ opencodeDir: dir });
  assert.equal(status.working, false);
  assert.equal(status.activeSessions.length, 0);
});

test("getOpenCodeStatus: 單次驗證忽略崩潰 PID 與過期心跳且不刪除檔案", (t) => {
  const { dir } = createTestDir("opencode-reader-", t);
  writeJson(join(dir, "dead.json"), mockSnapshot({ crashedSession: { status: "running" } }, { pid: 99999999 }));
  writeJson(
    join(dir, "stale.json"),
    mockSnapshot({ staleSession: { status: "running" } }, { heartbeat: Date.now() - 60_000 }),
  );

  const status = getOpenCodeStatus({
    opencodeDir: dir,
    heartbeatTimeoutMs: 10_000,
    isPidAlive: (pid) => pid === process.pid,
  });

  assert.equal(status.working, false);
  assert.equal(status.activeSessions.length, 0);
  assert.equal(status.instancesCount, 0);
  assert.equal(existsSync(join(dir, "dead.json")), true, "不得刪除已終止 PID 之檔案");
  assert.equal(existsSync(join(dir, "stale.json")), true, "不得刪除過期檔案");
});

test("getOpenCodeStatus: 邊界檢查拒絕過大檔案、未來時間戳記與畸形資料", (t) => {
  const { dir } = createTestDir("opencode-reader-", t);

  // 大小 > 64KB 之快照，證明 size guard 確實生效
  writeJson(join(dir, "large.json"), mockSnapshot({ ses_large: { status: "running" } }, { padding: "x".repeat(70_000) }));

  // 未來心跳時間戳記（> 目前時間 + 5000 毫秒）
  writeJson(join(dir, "future.json"), mockSnapshot({ ses_f: { status: "running" } }, { heartbeat: Date.now() + 60_000 }));

  // 畸形 JSON 檔案
  writeFileSync(join(dir, "malformed.json"), "{ malformed json", "utf8");

  // 無效的 heartbeatTimeoutMs (NaN) 安全降級
  const status = getOpenCodeStatus({
    opencodeDir: dir,
    heartbeatTimeoutMs: Number.NaN,
    isPidAlive: () => true,
  });

  assert.equal(status.working, false);
  assert.equal(status.instancesCount, 0);
});

test("getOpenCodeStatus: 多專案同 PID 實例隔離與活躍聚合", (t) => {
  const { dir } = createTestDir("opencode-reader-", t);

  // 1 個 idle 實例
  writeJson(join(dir, "inst-idle.json"), mockSnapshot({}, { id: "inst-idle", projectDir: "/project/idle" }));

  // 至少 2 個 active 實例，具有多個 session
  writeJson(
    join(dir, "inst-act1.json"),
    mockSnapshot(
      { ses_a1: { status: "running" }, ses_a2: { status: "running" } },
      { id: "inst-act1", projectDir: "/project/A" },
    ),
  );
  writeJson(
    join(dir, "inst-act2.json"),
    mockSnapshot(
      { ses_b1: { status: "running" } },
      { id: "inst-act2", projectDir: "/project/B" },
    ),
  );

  // 有效 JSON 但 invalid schema（pid / heartbeat / sessions）
  writeJson(join(dir, "invalid-pid.json"), {
    id: "invalid-pid",
    pid: "not-a-number",
    heartbeat: Date.now(),
    sessions: { ses_bad1: { status: "running" } },
  });
  writeJson(join(dir, "invalid-heartbeat.json"), {
    id: "invalid-heartbeat",
    pid: process.pid,
    heartbeat: "not-a-timestamp",
    sessions: { ses_bad2: { status: "running" } },
  });
  writeJson(join(dir, "invalid-sessions.json"), {
    id: "invalid-sessions",
    pid: process.pid,
    heartbeat: Date.now(),
    sessions: ["ses_bad3"],
  });

  const status = getOpenCodeStatus({
    opencodeDir: dir,
    isPidAlive: () => true,
  });

  assert.equal(status.working, true);
  // 3 個合法實例（1 idle + 2 active），invalid schema 被忽略
  assert.equal(status.instancesCount, 3);
  // 多 session 完整 activeSessions union 驗證
  assert.deepEqual(status.activeSessions.sort(), ["ses_a1", "ses_a2", "ses_b1"]);
});
