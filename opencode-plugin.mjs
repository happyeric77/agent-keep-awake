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
      // ignore
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
      // ignore
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

    // Write initial instance state
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
          reject(new Error("active request timed out"));
        }, activeTimeoutMs);
        if (timer.unref) {
          timer.unref();
        }
      });

      const callPromise = Promise.resolve().then(() => ctx.session.active());

      // Underlying in-flight lock remains held until actual settle
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
          // Reject malformed/enveloped data without refreshing heartbeat or state
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
        // Error or timeout: do NOT refresh heartbeat or state
      }
    };

    // Initial authoritative snapshot reconciliation
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
        // ignore
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
        // ignore
      }
    };

    return cleanup;
  },
};

export default plugin;
