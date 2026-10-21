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
      // 忽略錯誤
    }
  }
}

export const plugin = {
  id: "herdr.keep-awake",

  async setup(ctx, options = {}) {
    // B2: 若真實環境缺少事件訂閱 API，在寫入任何狀態檔前直接退出，不留任何磁碟殘留
    if (typeof ctx?.event?.subscribe !== "function") {
      return async () => {};
    }

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
    const sessionLeaseMs = opts.sessionLeaseMs ?? 10_000;

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

    // 寫入初始實例狀態檔
    writeCurrentState();

    // 依據 OpenCode v2.0.26 真實契約定義之最小正確狀態模型
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

    // 記憶體中追蹤每個 session 的各子狀態（turn execution、shell 指令、compaction）
    const sessionActivities = new Map();
    // 追蹤斷線重連後待確認之 session 及其過期時間戳記（僅限斷線未確認項，健康時活動不因靜默刪除）
    const unconfirmedSessions = new Map();

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
        unconfirmedSessions.delete(sessionID);
        if (Object.hasOwn(state.sessions, sessionID)) {
          delete state.sessions[sessionID];
          return true;
        }
        return false;
      }

      let act = sessionActivities.get(sessionID);
      if (!act) {
        act = { execution: false, shell: false, compaction: false, updatedAt: 0 };
      }

      let matched = false;

      if (EXECUTION_ACTIVE_EVENTS.has(type)) {
        act.execution = true;
        act.updatedAt = now;
        matched = true;
      } else if (EXECUTION_TERMINAL_EVENTS.has(type)) {
        act.execution = false;
        // B5: compaction 僅在 execution 內，execution 終止時一併清除 compaction
        act.compaction = false;
        matched = true;
      } else if (SHELL_ACTIVE_EVENTS.has(type)) {
        act.shell = true;
        act.updatedAt = now;
        matched = true;
      } else if (SHELL_TERMINAL_EVENTS.has(type)) {
        act.shell = false;
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

      const isRunning = act.execution || act.shell || act.compaction;
      if (isRunning) {
        sessionActivities.set(sessionID, act);
        state.sessions[sessionID] = { status: "running", updatedAt: act.updatedAt };
        // B1: 若有新活動則清除 unconfirmed lease
        unconfirmedSessions.delete(sessionID);
        return true;
      }

      if (Object.hasOwn(state.sessions, sessionID)) {
        delete state.sessions[sessionID];
        sessionActivities.delete(sessionID);
        unconfirmedSessions.delete(sessionID);
        return true;
      }

      return false;
    };

    // 租約清理：僅清理斷線重連後在寬限期內未獲確認之幽靈 session；健康串流下活躍 session 不受靜默到期影響
    const sweepUnconfirmedLeases = () => {
      if (!streamHealthy || unconfirmedSessions.size === 0) return false;
      const now = Date.now();
      let changed = false;
      for (const [sessionID, expiresAt] of unconfirmedSessions) {
        if (now >= expiresAt) {
          delete state.sessions[sessionID];
          sessionActivities.delete(sessionID);
          unconfirmedSessions.delete(sessionID);
          changed = true;
        }
      }
      return changed;
    };

    // B1: 確認重連時起算賦予有限 lease，不以舊 updatedAt 立即刪除
    const onReconnectConfirmed = () => {
      const now = Date.now();
      for (const sessionID of Object.keys(state.sessions)) {
        unconfirmedSessions.set(sessionID, now + sessionLeaseMs);
      }
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
            throw new Error("event.subscribe 未回傳 AsyncIterable");
          }

          // 注意：首次收到實際合法且具非空 type 事件前，絕不標記 healthy、絕不刷新 heartbeat、絕不 reset backoff
          for await (const event of stream) {
            if (cleanedUp) break;

            // B4: 只有 event 是合法物件且 type 為非空字串時，才可視為收到有效事件
            if (!event || typeof event !== "object" || typeof event.type !== "string" || event.type.trim() === "") {
              continue;
            }

            receivedEventsInThisConn += 1;

            const wasHealthy = streamHealthy;
            if (!streamHealthy) {
              streamHealthy = true;
              onReconnectConfirmed();
            }

            const leasesChanged = sweepUnconfirmedLeases();
            const stateChanged = handleEvent(event);

            // B4: 同一 event 合併狀態和 heartbeat 寫檔
            if (!wasHealthy || stateChanged || leasesChanged) {
              writeCurrentState();
            }
          }
        } catch {
          // 忽略錯誤，由下方統一處理斷線與退避
        } finally {
          abortController = null;
        }

        if (cleanedUp) break;

        // 串流中斷（catch 拋錯或 for-await 正常 EOF）：視為不可信
        streamHealthy = false;

        // 僅當連線期間曾成功接收到實際事件時才重置 backoff；
        // 慢速 EOF 或連線錯誤下，退避必須持續指數累積
        if (receivedEventsInThisConn > 0) {
          backoffMs = minBackoffMs;
        } else {
          backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        }

        await sleepCancellable(backoffMs);
      }
    };

    // 啟動事件監聽工作
    void listenEvents();

    // 心跳定時器：僅在事件串流正常連線時刷新心跳時間戳記與檢查未確認租約
    const sweepIntervalMs = Math.min(pollIntervalMs, Math.max(25, Math.floor(sessionLeaseMs / 3)));
    const heartbeatTimer = setInterval(() => {
      if (cleanedUp || !streamHealthy) return;
      sweepUnconfirmedLeases();
      writeCurrentState();
    }, sweepIntervalMs);

    if (heartbeatTimer.unref) {
      heartbeatTimer.unref();
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
      clearInterval(heartbeatTimer);
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
        // 忽略錯誤
      }
    };

    return cleanup;
  },
};

export default plugin;
