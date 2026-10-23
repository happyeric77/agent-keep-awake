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
  const detail = lastError ? ` (last error: ${lastError.message ?? lastError})` : "";
  const failureMsg = message
    ? `${message}${detail}`
    : `Condition timed out after ${timeoutMs} ms${detail}`;
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

export function createMockOpenCodeContext(options = {}) {
  const directory = options.directory ?? "/project";
  const projectID = options.projectID ?? "proj-1";
  const autoConnectEvent = options.autoConnectEvent ?? true;
  const listeners = new Set();
  let streamFail = options.streamFail ?? false;
  let subscribeCount = 0;
  const sessions = new Map();
  const waiters = new Set();
  let apiFail = false;

  const updateApi = (event) => {
    const id = event?.data?.sessionID;
    if (typeof id !== "string" || !id.startsWith("ses")) return;
    const item = sessions.get(id) ?? { execution: false, compaction: false, messages: [] };
    const type = event.type;
    if (/^session\.(execution|retry|step|text|reasoning|tool)\./.test(type)) {
      item.execution = !["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(type);
      if (!item.execution) item.compaction = false;
    }
    if (type.startsWith("session.compaction.")) item.compaction = !/\.(ended|failed)$/.test(type);
    if (type === "session.shell.started") item.messages.push({ type: "shell", shellID: event.data.shell?.id ?? `sh_${id}`, status: "running" });
    if (/^session\.shell\.(ended|failed)$/.test(type)) {
      for (const message of item.messages) {
        if (!event.data.shell?.id || message.shellID === event.data.shell.id) message.status = "exited";
      }
    }
    sessions.set(id, item);
    if (type === "session.deleted") sessions.delete(id);
    for (const notify of [...waiters]) notify();
  };

  const emit = (event) => {
    updateApi(event);
    for (const listener of listeners) {
      listener(event);
    }
  };

  const closeStream = () => {
    for (const listener of listeners) {
      listener(null, null, true);
    }
  };

  const setStreamFail = (val) => {
    streamFail = val;
    if (val) {
      for (const listener of listeners) {
        listener(null, new Error("Event stream connection failed"));
      }
    }
  };

  const context = {
    location: { directory, project: { id: projectID } },
    session: {
      hook: () => ({ dispose: () => {} }),
      get: async () => ({ id: "mock" }),
      list: async () => {
        if (apiFail) throw new Error("Status API failed");
        return { data: [...sessions.keys()].map(id => ({ id })), cursor: {} };
      },
      context: async ({ sessionID }) => {
        if (apiFail) throw new Error("Status API failed");
        return structuredClone(sessions.get(sessionID)?.messages ?? []);
      },
      wait: ({ sessionID }, { signal } = {}) => new Promise((resolve, reject) => {
        const notify = () => {
          const item = sessions.get(sessionID);
          if (!signal?.aborted && !apiFail && (item?.execution || item?.compaction)) return;
          waiters.delete(notify);
          signal?.removeEventListener("abort", notify);
          if (signal?.aborted || apiFail) reject(new Error("Status query aborted or failed"));
          else resolve();
        };
        waiters.add(notify);
        signal?.addEventListener("abort", notify, { once: true });
        notify();
      }),
    },
    event: {
      subscribe: (subOpts = {}) => {
        subscribeCount += 1;
        if (streamFail) {
          throw new Error("Event stream connection failed");
        }
        let queue = [];
        let notify = null;
        let closed = false;

        if (autoConnectEvent) {
          queue.push({
            evt: { id: `evt_conn_${subscribeCount}`, type: "server.connected", created: Date.now(), data: {} },
          });
        }

        const onEvent = (evt, err, isEof) => {
          if (closed) return;
          if (isEof) {
            closed = true;
            queue.push({ eof: true });
          } else if (err) {
            closed = true;
            queue.push({ err });
          } else {
            queue.push({ evt });
          }
          if (notify) {
            const cb = notify;
            notify = null;
            cb();
          }
        };

        listeners.add(onEvent);

        const signal = subOpts.signal;
        const remove = () => {
          if (closed) return;
          closed = true;
          listeners.delete(onEvent);
          if (notify) {
            const cb = notify;
            notify = null;
            cb();
          }
        };

        if (signal) {
          if (signal.aborted) {
            remove();
          } else {
            signal.addEventListener("abort", remove, { once: true });
          }
        }

        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                while (queue.length === 0) {
                  if (closed || signal?.aborted) {
                    return { done: true, value: undefined };
                  }
                  await new Promise((resolve) => {
                    notify = resolve;
                  });
                }
                const item = queue.shift();
                if (item.eof) {
                  return { done: true, value: undefined };
                }
                if (item.err) {
                  throw item.err;
                }
                return { done: false, value: item.evt };
              },
              async return() {
                remove();
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    },
  };

  return {
    context,
    emit,
    closeStream,
    setStreamFail,
    updateApi,
    setApiFail: (value) => {
      apiFail = value;
      for (const notify of [...waiters]) notify();
    },
    getSubscribeCount: () => subscribeCount,
  };
}

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
    ? `Process PID ${proc.pid} did not exit within ${timeoutMs} ms`
    : `Process did not exit within ${timeoutMs} ms`;
  await waitFor(
    () => {
      if (proc.spawnError) {
        throw new Error(`Process startup failed: ${proc.spawnError.message}`, { cause: proc.spawnError });
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
        ? `Daemon startup failed: ${proc.spawnError.message}`
        : "Daemon startup failed: invalid PID";
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
        `Caffeinate PID ${pid} did not exit; refusing to remove an in-use directory`,
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
