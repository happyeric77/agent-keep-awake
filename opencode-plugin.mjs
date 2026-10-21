import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function getDefaultStateDir() {
  if (process.env.OPENCODE_STATE_DIR) {
    return process.env.OPENCODE_STATE_DIR;
  }
  const stateHome =
    process.env.XDG_STATE_HOME ||
    (process.env.HOME ? join(process.env.HOME, ".local", "state") : "");
  return join(stateHome, "herdr-keep-awake", "opencode");
}

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmpPath, filePath);
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      // 忽略錯誤
    }
  }
}

function isValidActiveMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return false;
  }
  for (const [id, info] of Object.entries(raw)) {
    if (!id.startsWith("ses")) {
      return false;
    }
    if (!info || typeof info !== "object" || Array.isArray(info)) {
      return false;
    }
    if (info.type !== "running") {
      return false;
    }
  }
  return true;
}

export const plugin = {
  id: "herdr.keep-awake",

  async setup(ctx, options = {}) {
    const opts = { ...ctx?.options, ...options };
    const stateDir = opts.stateDir ?? getDefaultStateDir();
    try {
      mkdirSync(stateDir, { recursive: true });
    } catch {
      // 忽略錯誤
    }

    const instanceId = opts.id ?? randomUUID();
    const pid = opts.pid ?? process.pid;
    const stateFile = join(stateDir, `${instanceId}.json`);

    const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
    const activeTimeoutMs = opts.activeTimeoutMs ?? 5_000;

    const state = {
      id: instanceId,
      pid,
      projectDir: ctx?.location?.directory ?? process.cwd(),
      projectID: ctx?.location?.project?.id ?? null,
      heartbeat: Date.now(),
      sessions: {},
    };

    let cleanedUp = false;
    let inFlight = false;

    const writeCurrentState = () => {
      if (cleanedUp) return;
      state.heartbeat = Date.now();
      atomicWriteJson(stateFile, state);
    };

    // 寫入初始實例狀態
    writeCurrentState();

    const reconcileActive = async () => {
      if (cleanedUp || inFlight) return;
      if (typeof ctx?.session?.active !== "function") {
        return;
      }

      inFlight = true;
      let timedOut = false;
      let timer = null;

      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("active 請求逾時"));
        }, activeTimeoutMs);
        if (timer.unref) {
          timer.unref();
        }
      });

      const callPromise = Promise.resolve().then(() => ctx.session.active());

      // 底層進行中鎖（in-flight lock）持續維持至實際 settle
      callPromise
        .finally(() => {
          inFlight = false;
        })
        .catch(() => {});

      try {
        const raw = await Promise.race([callPromise, timeoutPromise]);
        if (timer) clearTimeout(timer);
        if (cleanedUp || timedOut) return;

        if (!isValidActiveMap(raw)) {
          // 拒絕畸形或經包裝（enveloped）資料且不重新整理心跳或狀態
          return;
        }

        const now = Date.now();
        const activeSessions = {};
        for (const id of Object.keys(raw)) {
          activeSessions[id] = { status: "running", updatedAt: now };
        }

        state.sessions = activeSessions;
        writeCurrentState();
      } catch {
        if (timer) clearTimeout(timer);
        // 發生錯誤或逾時：不重新整理心跳或狀態
      }
    };

    // 初始權威快照協調
    await reconcileActive();

    const intervalTimer = setInterval(() => {
      void reconcileActive().catch(() => {});
    }, pollIntervalMs);

    if (intervalTimer.unref) {
      intervalTimer.unref();
    }

    const onExit = () => {
      try {
        unlinkSync(stateFile);
      } catch {
        // 忽略錯誤
      }
    };

    process.once("exit", onExit);

    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(intervalTimer);
      process.removeListener("exit", onExit);
      try {
        unlinkSync(stateFile);
      } catch {
        // 忽略錯誤
      }
    };

    return cleanup;
  },
};

export default plugin;
