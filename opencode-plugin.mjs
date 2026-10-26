import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXECUTION_ACTIVE = new Set([
  "session.execution.started", "session.retry.scheduled", "session.step.started",
  "session.step.streamed", "session.text.started", "session.text.delta",
  "session.reasoning.started", "session.reasoning.delta", "session.tool.called",
  "session.tool.input.started", "session.tool.input.delta", "session.tool.progress",
]);
const EXECUTION_ENDED = new Set([
  "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
]);
const COMPACTION_ACTIVE = new Set(["session.compaction.started", "session.compaction.delta"]);
const COMPACTION_ENDED = new Set(["session.compaction.ended", "session.compaction.failed"]);

// Newest sessions are enough to recover work that started while disconnected.
const DISCOVERY_LIMIT = 10;

function defaultStateDir() {
  if (process.env.OPENCODE_STATE_DIR) return process.env.OPENCODE_STATE_DIR;
  const stateHome =
    process.env.XDG_STATE_HOME ?? (process.env.HOME ? join(process.env.HOME, ".local", "state") : "");
  return join(stateHome, "herdr-keep-awake", "opencode");
}

function writeSnapshot(filePath, pid, sessions, shells) {
  const tmpPath = `${filePath}.tmp.${randomUUID()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify({ pid, sessions, shells }), "utf8");
    renameSync(tmpPath, filePath);
    return true;
  } catch {
    try { unlinkSync(tmpPath); } catch { /* best effort */ }
  }
}

const newActivity = () => ({ execution: false, shells: new Set(), compaction: false, provisional: false });
const isActive = (a) => a.execution || a.shells.size > 0 || a.compaction || a.provisional;

export const plugin = {
  id: "herdr.keep-awake",

  async setup(ctx, options = {}) {
    // Without an event stream there is no activity source; leave no snapshot.
    if (typeof ctx?.event?.subscribe !== "function") return async () => {};

    const opts = { ...ctx?.options, ...options };
    const stateDir = opts.stateDir ?? defaultStateDir();
    try { mkdirSync(stateDir, { recursive: true }); } catch { /* best effort */ }
    const pid = opts.pid ?? process.pid;
    const stateFile = join(stateDir, `${opts.id ?? randomUUID()}.json`);
    const canDiscover = ["list", "wait", "context"].every(
      (name) => typeof ctx.session?.[name] === "function",
    );

    const sessions = new Map();
    const shellOwners = new Map(); // Global Shell events do not repeat sessionID on exit.
    let disposed = false;
    let controller = null;
    let cancelDelay = null;
    let published = null;

    const publish = () => {
      if (disposed) return;
      const ids = [...sessions].filter(([, a]) => isActive(a)).map(([id]) => id).sort();
      const shells = [...shellOwners.keys()].sort();
      // Publish even when the number of active Sessions stays the same:
      // one Session can start or finish multiple background Shells.
      const key = JSON.stringify([ids, shells]);
      if (key === published) return;
      if (writeSnapshot(stateFile, pid, ids, shells)) published = key;
    };

    // A session found after (re)connecting may have started while events were
    // lost, so keep it until the host confirms it is idle.
    const confirm = async (sessionID, activity) => {
      try {
        await ctx.session.wait({ sessionID });
        const messages = await ctx.session.context({ sessionID });
        const shellRunning =
          Array.isArray(messages) &&
          messages.some((m) => m?.type === "shell" && m.status === "running");
        if (disposed || sessions.get(sessionID) !== activity || shellRunning) return;
        // Activity seen by events while waiting wins over this guess.
        if (activity.execution || activity.shells.size > 0 || activity.compaction) return;
        sessions.delete(sessionID);
        publish();
      } catch (error) {
        if (disposed || sessions.get(sessionID) !== activity) return;
        if (error?._tag === "SessionNotFoundError") {
          sessions.delete(sessionID);
          publish();
        }
        // Any other failure stays active: unconfirmed is not idle.
      }
    };

    const discover = async () => {
      if (!canDiscover) return;
      let page;
      try {
        page = await ctx.session.list({ order: "desc", limit: DISCOVERY_LIMIT });
      } catch {
        return;
      }
      if (disposed) return;
      for (const session of page?.data ?? []) {
        if (typeof session?.id !== "string" || !session.id.startsWith("ses")) continue;
        if (sessions.has(session.id)) continue;
        const activity = { ...newActivity(), provisional: true };
        sessions.set(session.id, activity);
        void confirm(session.id, activity);
      }
      publish();
    };

    const handleEvent = (event) => {
      const { type, data } = event ?? {};

      // Background tool shells emit location-scoped events even after the
      // originating Session execution has become idle. Their metadata links
      // the Shell ID to a Session; terminal events contain only the Shell ID.
      if (type === "shell.created") {
        const shell = data?.info;
        const sessionID = shell?.metadata?.sessionID;
        if (
          typeof shell?.id !== "string" || !shell.id.startsWith("sh_") ||
          shell.status !== "running" ||
          typeof sessionID !== "string" || !sessionID.startsWith("ses")
        ) return;
        const activity = sessions.get(sessionID) ?? newActivity();
        activity.shells.add(shell.id);
        activity.provisional = false;
        sessions.set(sessionID, activity);
        shellOwners.set(shell.id, sessionID);
        return;
      }
      if (type === "shell.exited" || type === "shell.deleted") {
        const id = data?.id;
        const sessionID = shellOwners.get(id);
        if (!sessionID) return;
        shellOwners.delete(id);
        const activity = sessions.get(sessionID);
        if (!activity) return;
        activity.shells.delete(id);
        if (!isActive(activity)) sessions.delete(sessionID);
        return;
      }

      const sessionID = data?.sessionID;
      if (typeof type !== "string" || typeof sessionID !== "string") return;
      if (!sessionID.startsWith("ses")) return;
      if (type === "session.deleted") {
        sessions.delete(sessionID);
        for (const [id, owner] of shellOwners) {
          if (owner === sessionID) shellOwners.delete(id);
        }
        return;
      }

      const activity = sessions.get(sessionID) ?? newActivity();
      if (type === "session.shell.started") {
        const id = data.shell?.id;
        if (typeof id !== "string" || !id.startsWith("sh_")) return;
        activity.shells.add(id);
        shellOwners.set(id, sessionID);
      } else if (type === "session.shell.ended" || type === "session.shell.failed") {
        if (data.shell?.id) {
          activity.shells.delete(data.shell.id);
          shellOwners.delete(data.shell.id);
        } else {
          activity.shells.clear();
          for (const [id, owner] of shellOwners) {
            if (owner === sessionID) shellOwners.delete(id);
          }
        }
      } else if (COMPACTION_ACTIVE.has(type)) activity.compaction = true;
      else if (COMPACTION_ENDED.has(type)) activity.compaction = false;
      else if (EXECUTION_ENDED.has(type)) {
        activity.execution = false;
        activity.compaction = false; // Compaction belongs to the ended execution.
      } else if (EXECUTION_ACTIVE.has(type)) activity.execution = true;
      else return;

      // Events are authoritative for this session; stop guessing.
      activity.provisional = false;
      if (isActive(activity)) sessions.set(sessionID, activity);
      else sessions.delete(sessionID);
    };

    const delay = (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          cancelDelay = null;
          resolve();
        }, ms);
        cancelDelay = () => {
          clearTimeout(timer);
          cancelDelay = null;
          resolve();
        };
      });

    let backoffMs = 250;
    const listen = async () => {
      while (!disposed) {
        controller = new AbortController();
        let receivedEvent = false;
        try {
          const stream = await ctx.event.subscribe({ signal: controller.signal });
          if (!stream?.[Symbol.asyncIterator]) throw new Error("no event stream");
          void discover();
          for await (const event of stream) {
            if (disposed) break;
            if (typeof event?.type === "string") receivedEvent = true;
            handleEvent(event);
            publish();
          }
        } catch {
          // A broken stream says nothing about the work; reconnect below.
        }
        controller = null;
        if (disposed) break;
        backoffMs = receivedEvent ? 250 : Math.min(backoffMs * 2, 5000);
        await delay(backoffMs);
      }
    };

    publish();
    const publishRetry = setInterval(publish, 1000);
    publishRetry.unref();
    void listen();

    const onExit = () => {
      try { unlinkSync(stateFile); } catch { /* best effort */ }
    };
    process.once("exit", onExit);

    return async () => {
      if (disposed) return;
      disposed = true;
      clearInterval(publishRetry);
      process.removeListener("exit", onExit);
      if (controller) controller.abort();
      if (cancelDelay) cancelDelay();
      try { unlinkSync(stateFile); } catch { /* best effort */ }
    };
  },
};

export default plugin;
