import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getOpenCodeStatus, getOpenCodeStateDir } from "../opencode.mjs";

test("getOpenCodeStatus: 當目錄不存在時回傳非活躍狀態", () => {
  const nonExistentDir = join(tmpdir(), `test-opencode-none-${Date.now()}`);
  const status = getOpenCodeStatus({ opencodeDir: nonExistentDir });
  assert.equal(status.working, false);
  assert.equal(status.instancesCount, 0);
  assert.equal(status.activeSessions.length, 0);
});

test("getOpenCodeStatus: 處理 A running 與 B idle（idle 已自狀態中刪除）", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-test-"));
  try {
    const file = join(dir, "inst-uuid-1.json");
    writeFileSync(
      file,
      JSON.stringify({
        id: "inst-uuid-1",
        pid: process.pid,
        projectDir: "/test/project",
        heartbeat: Date.now(),
        sessions: {
          sessionA: { status: "running", updatedAt: Date.now() },
        },
      }),
    );
    const status = getOpenCodeStatus({ opencodeDir: dir });
    assert.equal(status.working, true);
    assert.equal(status.activeSessions.includes("sessionA"), true);
    assert.equal(status.instancesCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getOpenCodeStatus: 全部 idle（空 sessions）允許休眠", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-test-"));
  try {
    const file = join(dir, "inst-uuid-1.json");
    writeFileSync(
      file,
      JSON.stringify({
        id: "inst-uuid-1",
        pid: process.pid,
        projectDir: "/test/project",
        heartbeat: Date.now(),
        sessions: {},
      }),
    );
    const status = getOpenCodeStatus({ opencodeDir: dir });
    assert.equal(status.working, false);
    assert.equal(status.activeSessions.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getOpenCodeStatus: 單次驗證忽略崩潰 PID 與過期心跳且不刪除檔案", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-test-"));
  try {
    const deadPid = 99999999;
    writeFileSync(
      join(dir, "dead.json"),
      JSON.stringify({
        id: "dead",
        pid: deadPid,
        heartbeat: Date.now(),
        sessions: { crashedSession: { status: "running", updatedAt: Date.now() } },
      }),
    );

    writeFileSync(
      join(dir, "stale.json"),
      JSON.stringify({
        id: "stale",
        pid: process.pid,
        heartbeat: Date.now() - 60_000,
        sessions: { staleSession: { status: "running", updatedAt: Date.now() - 60_000 } },
      }),
    );

    const status = getOpenCodeStatus({
      opencodeDir: dir,
      heartbeatTimeoutMs: 10_000,
      isPidAlive: (pid) => pid === process.pid,
    });

    assert.equal(status.working, false);
    assert.equal(status.activeSessions.length, 0);
    assert.equal(status.instancesCount, 0);
    // 保留檔案；由外掛退出負責清理，避免誤刪替換檔案
    assert.equal(existsSync(join(dir, "dead.json")), true, "不得刪除已終止 PID 之檔案");
    assert.equal(existsSync(join(dir, "stale.json")), true, "不得刪除過期檔案");
    // 已移除過時別名
    assert.equal(status.busySessions, undefined);
    assert.equal(status.retrySessions, undefined);
    assert.equal(status.idleSessions, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getOpenCodeStatus: 邊界檢查拒絕過大檔案與未來時間戳記", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-test-"));
  try {
    // 檔案過大 > 64KB
    const largeStr = "a".repeat(70000);
    writeFileSync(join(dir, "large.json"), JSON.stringify({ padding: largeStr }));

    // 未來心跳時間戳記（> 目前時間 + 5000 毫秒）
    writeFileSync(
      join(dir, "future.json"),
      JSON.stringify({
        id: "future",
        pid: process.pid,
        heartbeat: Date.now() + 60_000,
        sessions: { ses_f: { status: "running", updatedAt: Date.now() } },
      }),
    );

    // 無效的 heartbeatTimeoutMs (NaN) 安全降級
    const status = getOpenCodeStatus({
      opencodeDir: dir,
      heartbeatTimeoutMs: Number.NaN,
      isPidAlive: () => true,
    });

    assert.equal(status.working, false);
    assert.equal(status.instancesCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getOpenCodeStatus: 多專案同 PID 實例隔離", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-test-"));
  try {
    // 共享相同伺服器行程 PID 的兩個獨立外掛實例
    writeFileSync(
      join(dir, "inst-projA.json"),
      JSON.stringify({
        id: "inst-projA",
        pid: process.pid,
        projectDir: "/project/A",
        heartbeat: Date.now(),
        sessions: {},
      }),
    );
    writeFileSync(
      join(dir, "inst-projB.json"),
      JSON.stringify({
        id: "inst-projB",
        pid: process.pid,
        projectDir: "/project/B",
        heartbeat: Date.now(),
        sessions: {
          sessionB1: { status: "running", updatedAt: Date.now() },
        },
      }),
    );

    const status = getOpenCodeStatus({
      opencodeDir: dir,
      isPidAlive: () => true,
    });

    assert.equal(status.working, true);
    assert.equal(status.instancesCount, 2);
    assert.equal(status.activeSessions.includes("sessionB1"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
