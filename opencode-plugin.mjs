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
  const tmpPath = `${filePath}.tmp.${randomUUID()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmpPath, filePath);
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best effort.
    }
  }
}

export const plugin = {
  id: "herdr.keep-awake",

  async setup(ctx, options = {}) {
    // Unsupported hosts must not leave a snapshot behind.
    if (typeof ctx?.event?.subscribe !== "function") {
      return async () => {};
    }

    const opts = { ...ctx?.options, ...options };
    const stateDir = opts.stateDir ?? getDefaultStateDir();
    try {
      mkdirSync(stateDir, { recursive: true });
    } catch {
      // Best effort.
    }

    const instanceId = opts.id ?? randomUUID();
    const pid = opts.pid ?? process.pid;
    const stateFile = join(stateDir, `${instanceId}.json`);
    const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
    const syncTimeoutMs = opts.syncTimeoutMs ?? 5_000;

    const state = {
      id: instanceId,
      pid,
      projectDir: ctx?.location?.directory ?? process.cwd(),
      projectID: ctx?.location?.project?.id ?? null,
      heartbeat: Date.now(),
      sessions: {},
    };

    let cleanedUp = false;
    let streamHealthy = false;
    let abortController = null;

    const writeCurrentState = () => {
      if (cleanedUp) return;
      state.heartbeat = Date.now();
      atomicWriteJson(stateFile, state);
    };

    // Publish this instance before listening.
    writeCurrentState();

    // OpenCode V2 execution lifecycle events.
    const EXECUTION_ACTIVE_EVENTS = new Set([
      "session.execution.started",
      "session.retry.scheduled",
      "session.step.started",
      "session.step.streamed",
      "session.text.started",
      "session.text.delta",
      "session.reasoning.started",
      "session.reasoning.delta",
      "session.tool.called",
      "session.tool.input.started",
      "session.tool.input.delta",
      "session.tool.progress",
    ]);

    const EXECUTION_TERMINAL_EVENTS = new Set([
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
    ]);

    const SHELL_ACTIVE_EVENTS = new Set([
      "session.shell.started",
    ]);

    const SHELL_TERMINAL_EVENTS = new Set([
      "session.shell.ended",
      "session.shell.failed",
    ]);

    const COMPACTION_ACTIVE_EVENTS = new Set([
      "session.compaction.started",
      "session.compaction.delta",
    ]);

    const COMPACTION_TERMINAL_EVENTS = new Set([
      "session.compaction.ended",
      "session.compaction.failed",
    ]);

    // Execution, independent shells, and compaction must be tracked separately.
    const sessionActivities = new Map();
    const pendingQueries = new Set();
    let needsDiscovery = true;
    let discovering = false;
    const newActivity = () => ({
      execution: false,
      shell: new Set(),
      compaction: false,
      updatedAt: Date.now(),
      revision: 0,
      syncing: false,
    });

    // Bound queries even if the API ignores cancellation; a timeout is not idle.
    const query = async (run) => {
      const controller = new AbortController();
      let cancel;
      const cancelled = new Promise((_, reject) => {
        cancel = () => {
          controller.abort();
          reject(new Error("Status query cancelled"));
        };
      });
      pendingQueries.add(cancel);
      const timer = setTimeout(cancel, syncTimeoutMs);
      try {
        return await Promise.race([run({ signal: controller.signal }), cancelled]);
      } finally {
        clearTimeout(timer);
        pendingQueries.delete(cancel);
      }
    };

    const publish = (sessionID, act) => {
      if (act.execution || act.shell.size || act.compaction) {
        sessionActivities.set(sessionID, act);
        state.sessions[sessionID] = { status: "running", updatedAt: act.updatedAt };
      } else {
        sessionActivities.delete(sessionID);
        delete state.sessions[sessionID];
      }
    };

    const syncActivity = async (sessionID, act) => {
      if (cleanedUp || act.syncing) return;
      act.syncing = true;
      const revision = act.revision;
      try {
        const [messages] = await Promise.all([
          act.shell.size
            ? query((options) => ctx.session.context({ sessionID }, options))
            : null,
          act.execution || act.compaction
            ? query((options) => ctx.session.wait({ sessionID }, options))
            : null,
        ]);
        if (cleanedUp || sessionActivities.get(sessionID) !== act || act.revision !== revision) return;
        if (messages !== null) {
          if (!Array.isArray(messages)) throw new Error("Invalid session context");
          for (const message of messages) {
            if (message.type === "shell" && ["exited", "timeout", "killed"].includes(message.status)) {
              act.shell.delete(message.shellID);
            }
          }
        }
        act.execution = false;
        act.compaction = false;
        publish(sessionID, act);
        writeCurrentState();
      } catch (error) {
        // Only explicit NotFound confirms deletion; transport errors retain Busy.
        if (!cleanedUp && sessionActivities.get(sessionID) === act && act.revision === revision && error?._tag === "SessionNotFoundError") {
          sessionActivities.delete(sessionID);
          delete state.sessions[sessionID];
          writeCurrentState();
        }
      } finally {
        act.syncing = false;
      }
    };

    const discover = async () => {
      if (cleanedUp || discovering || !needsDiscovery) return;
      discovering = true;
      needsDiscovery = false;
      try {
        let cursor;
        do {
          // ponytail: scan history on reconnect; use a host process-owned active API if history becomes large.
          const page = await query((options) => ctx.session.list({ limit: 50, cursor }, options));
          if (cleanedUp) return;
          for (const session of page.data) {
            if (typeof session.id !== "string" || !session.id.startsWith("ses")) continue;
            let act = sessionActivities.get(session.id);
            if (!act) {
              act = newActivity();
              act.execution = true;
              publish(session.id, act);
            }
            void syncActivity(session.id, act);
          }
          writeCurrentState();
          cursor = page.cursor?.next;
        } while (cursor && !cleanedUp);
      } catch {
        needsDiscovery = true;
      } finally {
        discovering = false;
      }
    };

    const handleEvent = (event) => {
      if (!event || typeof event !== "object") return false;
      const { type, data } = event;
      if (!data || typeof data !== "object") return false;
      const sessionID = data.sessionID;
      if (typeof sessionID !== "string" || !sessionID.startsWith("ses")) return false;
      if (sessionID === "__proto__" || sessionID === "constructor" || sessionID === "prototype") return false;

      const now = Date.now();

      if (type === "session.deleted") {
        sessionActivities.delete(sessionID);
        if (Object.hasOwn(state.sessions, sessionID)) {
          delete state.sessions[sessionID];
          return true;
        }
        return false;
      }

      let act = sessionActivities.get(sessionID);
      if (!act) {
        act = newActivity();
      }

      let matched = false;

      if (EXECUTION_ACTIVE_EVENTS.has(type)) {
        act.execution = true;
        act.updatedAt = now;
        matched = true;
      } else if (EXECUTION_TERMINAL_EVENTS.has(type)) {
        act.execution = false;
        // Compaction belongs to the execution being terminated.
        act.compaction = false;
        matched = true;
      } else if (SHELL_ACTIVE_EVENTS.has(type)) {
        act.shell.add(data.shell?.id ?? null);
        act.updatedAt = now;
        matched = true;
      } else if (SHELL_TERMINAL_EVENTS.has(type)) {
        if (data.shell?.id) act.shell.delete(data.shell.id);
        else act.shell.clear();
        matched = true;
      } else if (COMPACTION_ACTIVE_EVENTS.has(type)) {
        act.compaction = true;
        act.updatedAt = now;
        matched = true;
      } else if (COMPACTION_TERMINAL_EVENTS.has(type)) {
        act.compaction = false;
        matched = true;
      }

      if (!matched) return false;

      act.revision += 1;
      publish(sessionID, act);
      void syncActivity(sessionID, act);
      return true;
    };

    const minBackoffMs = 250;
    let backoffMs = minBackoffMs;
    const maxBackoffMs = 5000;
    let cancelBackoff = null;

    const sleepCancellable = (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          cancelBackoff = null;
          resolve();
        }, ms);
        cancelBackoff = () => {
          clearTimeout(timer);
          cancelBackoff = null;
          resolve();
        };
      });

    const listenEvents = async () => {
      while (!cleanedUp) {
        abortController = new AbortController();
        let receivedEventsInThisConn = 0;
        try {
          const stream = await ctx.event.subscribe({ signal: abortController.signal });
          if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
            throw new Error("event.subscribe did not return an AsyncIterable");
          }
          needsDiscovery = true;
          void discover();
          for (const [sessionID, act] of sessionActivities) void syncActivity(sessionID, act);

          // Reset backoff only after a valid event, independently of heartbeats.
          for await (const event of stream) {
            if (cleanedUp) break;

            // Ignore malformed events before updating stream health.
            if (!event || typeof event !== "object" || typeof event.type !== "string" || event.type.trim() === "") {
              continue;
            }

            receivedEventsInThisConn += 1;

            const wasHealthy = streamHealthy;
            if (!streamHealthy) {
              streamHealthy = true;
            }

            const stateChanged = handleEvent(event);

            // Coalesce activity and heartbeat into one write per event.
            if (!wasHealthy || stateChanged) {
              writeCurrentState();
            }
          }
        } catch {
          // Handle disconnects and backoff below without persisting raw errors.
        } finally {
          abortController = null;
        }

        if (cleanedUp) break;

        // Both errors and normal EOF require resubscription.
        streamHealthy = false;

        // Slow EOF without a valid event must not reset exponential backoff.
        if (receivedEventsInThisConn > 0) {
          backoffMs = minBackoffMs;
        } else {
          backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        }

        await sleepCancellable(backoffMs);
      }
    };

    // Start the event listener.
    void listenEvents();

    // Heartbeats mean process liveness, not stream progress or confirmed idle.
    const heartbeatTimer = setInterval(() => {
      if (cleanedUp) return;
      void discover();
      for (const [sessionID, act] of sessionActivities) void syncActivity(sessionID, act);
      writeCurrentState();
    }, pollIntervalMs);

    if (heartbeatTimer.unref) {
      heartbeatTimer.unref();
    }

    const onExit = () => {
      try {
        unlinkSync(stateFile);
      } catch {
        // Best effort.
      }
    };

    process.once("exit", onExit);

    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(heartbeatTimer);
      for (const cancel of pendingQueries) cancel();
      process.removeListener("exit", onExit);
      if (cancelBackoff) {
        cancelBackoff();
        cancelBackoff = null;
      }
      if (abortController) {
        abortController.abort();
      }
      try {
        unlinkSync(stateFile);
      } catch {
        // Best effort.
      }
    };

    return cleanup;
  },
};

export default plugin;
