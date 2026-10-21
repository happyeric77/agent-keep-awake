import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function readLines(p) {
  if (!existsSync(p)) return [];
  const content = readFileSync(p, "utf8").trim();
  return content.length > 0 ? content.split("\n") : [];
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export async function waitFor(condition, message, timeoutMs = 5000, stepMs = 50) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await condition()) return;
    } catch (err) {
      lastError = err;
    }
    await sleep(stepMs);
  }
  const detail = lastError ? `（最後錯誤: ${lastError.message ?? lastError}）` : "";
  const failureMsg = message
    ? `${message}${detail}`
    : `等待條件逾時（超過 ${timeoutMs} 毫秒）${detail}`;
  throw new Error(failureMsg, { cause: lastError });
}

export function createTestDir(prefix, t) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const cleanups = [];
  t.after(async () => {
    let err;
    while (cleanups.length > 0) {
      try {
        await cleanups.pop()();
      } catch (e) {
        err ??= e;
      }
    }
    if (!err) {
      rmSync(dir, { recursive: true, force: true });
    }
    if (err) throw err;
  });
  return { dir, defer: (fn) => cleanups.push(fn) };
}

export const writeJson = (p, data) => writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

export const mockContext = (active = {}, directory = "/project") => ({
  location: { directory },
  session: { active: typeof active === "function" ? active : async () => active },
});

export const mockSnapshot = (sessions = {}, overrides = {}) => ({
  id: "inst-1",
  pid: process.pid,
  projectDir: "/test/project",
  heartbeat: Date.now(),
  sessions,
  ...overrides,
});

export async function waitForProcessExit(proc, timeoutMs = 5000) {
  if (!proc) return;
  const message = proc.pid
    ? `行程 PID ${proc.pid} 未能在 ${timeoutMs} 毫秒內退出`
    : `行程未能在 ${timeoutMs} 毫秒內退出`;
  await waitFor(
    () => {
      if (proc.spawnError) {
        throw new Error(`行程啟動失敗: ${proc.spawnError.message}`, { cause: proc.spawnError });
      }
      return proc.exitCode !== null || proc.signalCode !== null;
    },
    message,
    timeoutMs,
    25,
  );
}

export function spawnDaemon(env, defer) {
  const proc = spawn(process.execPath, [join(repoRoot, "daemon.mjs")], { env, stdio: "ignore" });
  proc.spawnError = null;
  proc.on("error", (err) => {
    proc.spawnError = err;
  });

  defer(async () => {
    if (proc.spawnError || !proc.pid) {
      const message = proc.spawnError
        ? `守護行程啟動失敗: ${proc.spawnError.message}`
        : "守護行程啟動失敗: 行程無有效 PID";
      throw new Error(message, { cause: proc.spawnError });
    }
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      proc.kill("SIGTERM");
      await waitForProcessExit(proc, 1000);
    } catch {
      if (isPidAlive(proc.pid)) {
        proc.kill("SIGKILL");
        await waitForProcessExit(proc, 1000);
      }
    }
  });

  return proc;
}

export function setupDaemonTestEnv(testRoot, defer, overrides = {}) {
  const binDir = join(testRoot, "bin");
  const stateDir = join(testRoot, "state");
  const opencodeDir = join(stateDir, "opencode");
  const configDir = join(testRoot, "config");
  const herdrControlFile = join(testRoot, "herdr-control.json");
  const caffeinateLog = join(testRoot, "caffeinate.log");
  const caffeinatePidFile = join(testRoot, "caffeinate.pid");
  const herdrLog = join(testRoot, "herdr.log");

  mkdirSync(binDir, { recursive: true });
  mkdirSync(opencodeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  writeFileSync(
    join(binDir, "herdr"),
    `#!/bin/sh
echo "herdr called: $@" >> "${herdrLog}"
if [ -f "${herdrControlFile}" ]; then
  cat "${herdrControlFile}"
  exit $(cat "${herdrControlFile}.exit" 2>/dev/null || echo 0)
fi
echo '{"panes":[]}'
exit 0
`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(binDir, "caffeinate"),
    `#!/bin/sh
trap 'echo "kill: $$" >> "${caffeinateLog}"; exit 0' TERM INT
echo "spawn: $$ $@" >> "${caffeinateLog}"
echo "$$" >> "${caffeinatePidFile}"
target_pid=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-w" ]; then
    target_pid="$2"
    shift 2
  else
    shift
  fi
done
count=0
while [ $count -lt 600 ]; do
  if [ -n "$target_pid" ] && ! kill -0 "$target_pid" 2>/dev/null; then
    exit 0
  fi
  count=$((count + 1))
  sleep 0.05
done
exit 0
`,
    { mode: 0o755 },
  );

  defer(async () => {
    if (!existsSync(caffeinatePidFile)) return;
    const pids = readLines(caffeinatePidFile).map(Number).filter((p) => p > 0);
    for (const pid of pids) {
      await waitFor(
        () => !isPidAlive(pid),
        `caffeinate 行程 PID ${pid} 未能及時退出，終止清理以防刪除使用中目錄`,
        3000,
        25,
      );
    }
  });

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH || ""}`,
    HERDR_PLUGIN_CONFIG_DIR: configDir,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    OPENCODE_STATE_DIR: opencodeDir,
    KEEP_AWAKE_ENABLED: "1",
    KEEP_AWAKE_DISPLAY: "1",
    KEEP_AWAKE_POLL_INTERVAL: "1",
    OPENCODE_KEEP_AWAKE_ENABLED: "1",
    OPENCODE_HEARTBEAT_TIMEOUT: "30",
    HERDR_TIMEOUT_MS: "1000",
    HERDR_BIN_PATH: join(binDir, "herdr"),
    ...overrides,
  };

  return {
    binDir,
    stateDir,
    opencodeDir,
    configDir,
    herdrControlFile,
    caffeinateLog,
    caffeinatePidFile,
    herdrLog,
    daemonLog: join(stateDir, "daemon.log"),
    env,
  };
}
