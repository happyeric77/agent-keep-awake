import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import plugin from "../opencode-plugin.mjs";
import { getOpenCodeStatus } from "../opencode.mjs";
import { createMockOpenCodeContext, createTestDir, readJson, repoRoot, sleep, waitFor } from "./helpers.mjs";

test("opencode-plugin: implementation is self-contained without relative imports", () => {
  const code = readFileSync(join(repoRoot, "opencode-plugin.mjs"), "utf8");
  const relativeImportRegex = /from\s+["'](\.\/|\.\.\/)/g;
  const matches = [...code.matchAll(relativeImportRegex)];
  assert.equal(matches.length, 0, "Implementation must not contain relative imports");
  assert.equal(typeof plugin.setup, "function");
  assert.equal(plugin.id, "herdr.keep-awake");
});

test("opencode-plugin: directory entrypoint exports the OpenCode plugin contract", async () => {
  const indexModule = await import("../index.js");
  assert.equal(typeof indexModule.default, "object", "Default export must be an object");
  assert.equal(indexModule.default.id, "herdr.keep-awake", "Plugin ID must match");
  assert.equal(typeof indexModule.default.setup, "function", "Setup must be a function");
  assert.equal(indexModule.plugin, indexModule.default, "Named and default exports must match");
});

test("opencode-plugin: tracks events without the nonexistent ctx.session.active API", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-bug-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/test" });

  // Match the actual V2 Plugin Context rather than inventing an active API.
  assert.equal(context.session.active, undefined, "Plugin Context has no session.active method");

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));
  assert.equal(existsSync(stateFile), true);

  // Start execution.
  emit({
    id: "evt_1",
    type: "session.execution.started",
    created: Date.now(),
    data: { sessionID: "ses_started_1" },
  });

  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_started_1?.status === "running";
  }, "Execution started must record an active session");
});

test("opencode-plugin: same-PID project instances write and clean up independently", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-multi-", t);
  const { context: ctxA, emit: emitA } = createMockOpenCodeContext({ directory: "/project/A" });
  const { context: ctxB, emit: emitB } = createMockOpenCodeContext({ directory: "/project/B" });

  const cleanupA = await plugin.setup(ctxA, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanupA);
  const cleanupB = await plugin.setup(ctxB, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanupB);

  emitA({ id: "evt_a", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_A" } });
  emitB({ id: "evt_b", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_B" } });

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 2, "Same-PID instances need distinct UUID snapshots");

  await waitFor(() => {
    const sessions = files.map((f) => readJson(join(dir, f))).flatMap((s) => Object.keys(s.sessions));
    return sessions.includes("ses_A") && sessions.includes("ses_B");
  }, "Each instance must record its own session");

  await cleanupA();
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 1, "Cleanup A must remove only its file");

  await cleanupB();
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 0, "Cleanup B must remove its file");
});

test("opencode-plugin: tracks execution started and succeeded/failed/interrupted events", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-exec-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/exec" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // Start three sessions.
  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_1" } });
  emit({ id: "e2", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_2" } });
  emit({ id: "e3", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_3" } });

  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_1 && s.sessions.ses_2 && s.sessions.ses_3;
  }, "All three sessions must be active");

  // First session succeeds.
  emit({ id: "e4", type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "ses_1" } });
  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_1 === undefined && s.sessions.ses_2 && s.sessions.ses_3;
  }, "Successful session must leave the active list");

  // Second session fails.
  emit({ id: "e5", type: "session.execution.failed", created: Date.now(), data: { sessionID: "ses_2", error: { message: "fail" } } });
  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_2 === undefined && s.sessions.ses_3;
  }, "Failed session must leave the active list");

  // Third session is interrupted.
  emit({ id: "e6", type: "session.execution.interrupted", created: Date.now(), data: { sessionID: "ses_3", reason: "user" } });
  await waitFor(() => {
    const s = readJson(stateFile);
    return Object.keys(s.sessions).length === 0;
  }, "No active sessions may remain after all finish");
});

test("opencode-plugin: retry and progress remain active until execution succeeds", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-retry-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/retry" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // Start the execution.
  emit({
    id: "e1",
    type: "session.execution.started",
    created: Date.now(),
    data: { sessionID: "ses_task" },
  });

  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_task?.status === "running";
  }, "Execution started must mark activity");

  // Provider retry/backoff remains active.
  emit({
    id: "e2",
    type: "session.retry.scheduled",
    created: Date.now(),
    data: { sessionID: "ses_task", assistantMessageID: "msg_1", attempt: 1, at: Date.now() + 5000 },
  });

  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_task?.status === "running";
  }, "Scheduled retry must retain activity");

  // Progress events retain activity.
  emit({
    id: "e3",
    type: "session.tool.progress",
    created: Date.now(),
    data: { sessionID: "ses_task", metadata: { progress: 50 } },
  });

  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_task?.status === "running";
  }, "Tool progress must retain activity");

  // Successful execution becomes idle.
  emit({
    id: "e4",
    type: "session.execution.succeeded",
    created: Date.now(),
    data: { sessionID: "ses_task" },
  });

  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_task === undefined;
  }, "Successful execution must remove the session");
});

test("opencode-plugin: work already silent before disconnect remains working after reconnect", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-silent-before-", t);
  const { context, emit, setStreamFail, getSubscribeCount } = createMockOpenCodeContext({ directory: "/project/silent-before" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 30 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // Start work.
  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_silent_before" } });
  await waitFor(() => readJson(stateFile).sessions.ses_silent_before?.status === "running");

  // A healthy stream can be silent.
  await sleep(160);

  // Silence must not expire activity.
  assert.equal(readJson(stateFile).sessions.ses_silent_before?.status, "running", "Silent work must remain active");

  // Briefly disconnect.
  setStreamFail(true);
  await sleep(40);

  // Observe a real resubscription.
  setStreamFail(false);
  await waitFor(() => getSubscribeCount() >= 2, "Reconnect must trigger a second subscription");

  // Reconnection is not completion.
  const stateAfterReconnect = readJson(stateFile);
  assert.equal(stateAfterReconnect.sessions.ses_silent_before?.status, "running", "Reconnect must retain running work");

  const status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 500 });
  assert.equal(status.working, true, "The reader must retain silent work after reconnect");
  assert.equal(status.activeSessions.includes("ses_silent_before"), true);
});

test("opencode-plugin: a healthy silent stream retains working status", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-healthy-silent-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/healthy-silent" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 25 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_healthy_silent" } });
  await waitFor(() => readJson(stateFile).sessions.ses_healthy_silent?.status === "running");

  // Heartbeats continue without new events.
  await sleep(250);

  const state = readJson(stateFile);
  assert.equal(state.sessions.ses_healthy_silent?.status, "running", "Elapsed silence must not remove work");

  const status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 500 });
  assert.equal(status.working, true, "Silent work must remain working");
  assert.equal(status.activeSessions.includes("ses_healthy_silent"), true);
});

test("opencode-plugin: new activity after reconnect remains working", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-lease-renew-", t);
  const { context, emit, setStreamFail, getSubscribeCount } = createMockOpenCodeContext({ directory: "/project/lease-renew" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 25 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_renew" } });
  await waitFor(() => readJson(stateFile).sessions.ses_renew?.status === "running");

  // Disconnect.
  setStreamFail(true);
  await sleep(40);

  // Reconnect.
  setStreamFail(false);
  await waitFor(() => getSubscribeCount() >= 2, "Reconnect must resubscribe");

  // Emit activity after reconnect.
  emit({ id: "e2", type: "session.tool.progress", created: Date.now(), data: { sessionID: "ses_renew", metadata: {} } });

  // Wait through multiple reconciliation cycles.
  await sleep(180);

  // Activity must remain protected.
  const state = readJson(stateFile);
  assert.equal(state.sessions.ses_renew?.status, "running", "New activity must remain running");

  const status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 500 });
  assert.equal(status.working, true);
  assert.equal(status.activeSessions.includes("ses_renew"), true);
});

test("opencode-plugin: EOF uses bounded backoff and quiet reconnects retain healthy heartbeats", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-eof-", t);
  const { context, emit, closeStream, updateApi, getSubscribeCount } = createMockOpenCodeContext({ directory: "/project/eof" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 40 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // Establish activity before EOF.
  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_eof" } });
  await waitFor(() => readJson(stateFile).sessions.ses_eof?.status === "running");

  const initialCount = getSubscribeCount();
  assert.equal(initialCount, 1, "Initial connection must subscribe once");

  // Close the stream with normal EOF.
  closeStream();

  // Observe an actual reconnect, not merely elapsed time.
  await waitFor(() => getSubscribeCount() >= 2, "EOF must trigger resubscription");

  const countAfterEof = getSubscribeCount();
  assert.equal(countAfterEof <= initialCount + 4, true, "Bounded backoff must prevent a tight loop");

  // A quiet reconnect clears work only after authoritative completion.
  assert.equal(getOpenCodeStatus({ opencodeDir: dir }).working, true);
  updateApi({ type: "session.execution.succeeded", data: { sessionID: "ses_eof" } });
  await waitFor(() => {
    const s = readJson(stateFile);
    return Object.keys(s.sessions).length === 0;
  }, "Authoritative completion must clear the session");

  const status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 500 });
  assert.equal(status.working, false, "Confirmed completion must allow sleep");
});

test("opencode-plugin: progress events recover work started before startup or during disconnect", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-resume-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/resume" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // Recover from progress even if execution.started was missed.
  emit({
    id: "step_1",
    type: "session.step.started",
    created: Date.now(),
    data: { sessionID: "ses_ongoing" },
  });

  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_ongoing?.status === "running";
  }, "Step started must recover existing running work");

  // Text progress retains activity.
  emit({
    id: "text_1",
    type: "session.text.delta",
    created: Date.now(),
    data: { sessionID: "ses_ongoing" },
  });

  await sleep(50);
  assert.equal(readJson(stateFile).sessions.ses_ongoing?.status, "running");

  // Execution failure ends activity.
  emit({
    id: "fail_1",
    type: "session.execution.failed",
    created: Date.now(),
    data: { sessionID: "ses_ongoing", error: { message: "timeout" } },
  });

  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_ongoing === undefined;
  }, "Execution failed must remove the session");
});

test("opencode-plugin: accepts a synchronously returned AsyncIterable", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-sync-", t);
  let queue = [];
  let notify = null;
  let closed = false;

  const syncContext = {
    location: { directory: "/project/sync" },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              while (queue.length === 0) {
                if (closed) return { done: true, value: undefined };
                await new Promise((r) => {
                  notify = r;
                });
              }
              const item = queue.shift();
              return { done: false, value: item };
            },
            async return() {
              closed = true;
              return { done: true, value: undefined };
            },
          };
        },
      }),
    },
  };

  const cleanup = await plugin.setup(syncContext, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  queue.push({ id: "e1", type: "session.execution.started", data: { sessionID: "ses_sync" } });
  if (notify) notify();

  await waitFor(() => readJson(stateFile).sessions.ses_sync?.status === "running", "Synchronous AsyncIterable must process events");
});

test("opencode-plugin: rejects prototype keys and cleanup cancels backoff timers", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-proto-", t);
  const { context, emit, setStreamFail } = createMockOpenCodeContext({ directory: "/project/proto" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // Reject prototype-property injection.
  emit({ id: "p1", type: "session.execution.started", data: { sessionID: "__proto__" } });
  emit({ id: "p2", type: "session.execution.started", data: { sessionID: "constructor" } });
  emit({ id: "p3", type: "session.execution.started", data: { sessionID: "prototype" } });

  await sleep(60);
  const state = readJson(stateFile);
  assert.equal(state.sessions.__proto__, Object.prototype);
  assert.equal(Object.hasOwn(state.sessions, "__proto__"), false);
  assert.equal(Object.hasOwn(state.sessions, "constructor"), false);
  assert.equal(Object.hasOwn(state.sessions, "prototype"), false);

  // Cleanup must cancel a pending backoff without hanging.
  setStreamFail(true);
  await sleep(50); // Enter backoff.

  const cleanupStart = Date.now();
  await cleanup();
  const cleanupDuration = Date.now() - cleanupStart;
  assert.equal(cleanupDuration < 500, true, `Cleanup must promptly cancel backoff (took ${cleanupDuration} ms)`);
});

test("opencode-plugin: session.deleted removes the session", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-del-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/del" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_del" } });
  await waitFor(() => readJson(stateFile).sessions.ses_del?.status === "running");

  emit({ id: "e2", type: "session.deleted", created: Date.now(), data: { sessionID: "ses_del" } });
  await waitFor(() => readJson(stateFile).sessions.ses_del === undefined, "Session deleted must remove the session");
});

test("opencode-plugin: never persists sensitive errors or raw payloads", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-sensitive-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/sec" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  emit({
    id: "e1",
    type: "session.retry.scheduled",
    created: Date.now(),
    data: {
      sessionID: "ses_sec",
      attempt: 1,
      secretToken: "sk-super-secret-token",
      prompt: "Tell me the secret recipe",
      errorMessage: "Sensitive error from upstream provider",
    },
  });

  await waitFor(() => readJson(stateFile).sessions.ses_sec?.status === "running");

  const rawContent = readFileSync(stateFile, "utf8");
  assert.equal(rawContent.includes("sk-super-secret"), false);
  assert.equal(rawContent.includes("secret recipe"), false);
  assert.equal(rawContent.includes("Sensitive error"), false);

  const parsed = JSON.parse(rawContent);
  assert.equal(parsed.sessions.ses_sec.status, "running");
  assert.equal(parsed.sessions.ses_sec.secretToken, undefined);
  assert.equal(parsed.sessions.ses_sec.prompt, undefined);
});

test("opencode-plugin: hung or late events cannot block cleanup or recreate snapshots", { timeout: 3000 }, async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-late-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/late" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));
  assert.equal(existsSync(stateFile), true);

  const start = Date.now();
  await cleanup();
  assert.equal(Date.now() - start < 1000, true, "Cleanup must not hang");
  assert.equal(existsSync(stateFile), false, "Cleanup must remove the snapshot");

  // Emit a late event after cleanup.
  emit({ id: "e_late", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_late" } });
  await sleep(100);

  assert.equal(existsSync(stateFile), false, "Late events must not recreate a cleaned snapshot");
});

test("opencode-plugin: persistent stream failure is not process death; heartbeats and Busy remain", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-expire-", t);
  const { context, emit, setStreamFail } = createMockOpenCodeContext({ directory: "/project/expire" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 30 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // Start an active session.
  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_expire" } });
  await waitFor(() => readJson(stateFile).sessions.ses_expire?.status === "running");

  // Establish initial working status.
  let status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 100 });
  assert.equal(status.working, true);
  assert.equal(status.activeSessions.includes("ses_expire"), true);

  const firstHeartbeat = readJson(stateFile).heartbeat;

  // Fail the stream and subsequent subscription attempts.
  setStreamFail(true);

  // Wait beyond the reader's stale-heartbeat threshold.
  await sleep(150);

  const stateAfterFailures = readJson(stateFile);
  assert.ok(stateAfterFailures.heartbeat > firstHeartbeat, "A live plugin must keep heartbeating");

  // Stream failure must not remove protection from running work.
  status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 100 });
  assert.equal(status.working, true, "Stream failure must not be interpreted as idle");
});

test("opencode-plugin: malformed or unrelated events do not change sessions or heartbeat", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-val-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/val" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 500 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  emit({ id: "init", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_init" } });
  await waitFor(() => readJson(stateFile).sessions.ses_init?.status === "running");
  const snapshotBefore = readJson(stateFile);

  const invalidEvents = [
    null,
    undefined,
    {},
    { type: "session.execution.started" }, // Missing data.
    { type: "session.execution.started", data: null },
    { type: "session.execution.started", data: { sessionID: 12345 } }, // Not a string.
    { type: "session.execution.started", data: { sessionID: "invalid_prefix" } }, // Invalid prefix.
    { type: "unrelated.event", data: { sessionID: "ses_other" } },
  ];

  for (const invalid of invalidEvents) {
    emit(invalid);
  }

  await sleep(60);

  const snapshotAfter = readJson(stateFile);
  assert.deepEqual(snapshotAfter.sessions, snapshotBefore.sessions, "Invalid events must not change sessions");
  assert.equal(snapshotAfter.heartbeat, snapshotBefore.heartbeat, "Invalid events must not update the heartbeat");
});

test("opencode-plugin: repeated setup/cleanup restores listener counts without changing signal handlers", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-listeners-", t);
  const exitBefore = process.listenerCount("exit");
  const sigtermBefore = process.listenerCount("SIGTERM");
  const sigintBefore = process.listenerCount("SIGINT");
  const { context } = createMockOpenCodeContext();

  for (let i = 0; i < 3; i++) {
    const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 100 });
    defer(cleanup);
    assert.equal(process.listenerCount("SIGTERM"), sigtermBefore, "Plugin must not add SIGTERM handlers");
    assert.equal(process.listenerCount("SIGINT"), sigintBefore, "Plugin must not add SIGINT handlers");
    await cleanup();
  }

  // Multiple cleanups must restore the original listener count.
  assert.equal(process.listenerCount("exit"), exitBefore, "Cleanup must restore exit listener count");
  assert.equal(process.listenerCount("SIGTERM"), sigtermBefore);
  assert.equal(process.listenerCount("SIGINT"), sigintBefore);
});

test("opencode-plugin: shell lifecycle tracks activity without making a containing turn falsely idle", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-shell-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/shell" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // Independent shell: started -> running, ended -> idle.
  emit({ id: "sh1", type: "session.shell.started", created: Date.now(), data: { sessionID: "ses_sh_standalone" } });
  await waitFor(() => readJson(stateFile).sessions.ses_sh_standalone?.status === "running");

  emit({ id: "sh2", type: "session.shell.ended", created: Date.now(), data: { sessionID: "ses_sh_standalone" } });
  await waitFor(() => readJson(stateFile).sessions.ses_sh_standalone === undefined, "Independent shell completion must become idle");

  // A shell finishing inside an active turn must not make the turn idle.
  emit({ id: "ex1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_sh_turn" } });
  await waitFor(() => readJson(stateFile).sessions.ses_sh_turn?.status === "running");

  emit({ id: "sh3", type: "session.shell.started", created: Date.now(), data: { sessionID: "ses_sh_turn" } });
  await sleep(40);
  assert.equal(readJson(stateFile).sessions.ses_sh_turn?.status, "running");

  emit({ id: "sh4", type: "session.shell.ended", created: Date.now(), data: { sessionID: "ses_sh_turn" } });
  await sleep(40);
  assert.equal(readJson(stateFile).sessions.ses_sh_turn?.status, "running", "Shell ended must not clear an active turn");

  emit({ id: "ex2", type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "ses_sh_turn" } });
  await waitFor(() => readJson(stateFile).sessions.ses_sh_turn === undefined, "Successful execution becomes idle");
});

test("opencode-plugin: compaction started/delta and ended/failed compose correctly with execution", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-compact-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/compact" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // Compaction lifecycle: started -> delta -> ended.
  emit({ id: "c1", type: "session.compaction.started", created: Date.now(), data: { sessionID: "ses_comp_auto" } });
  await waitFor(() => readJson(stateFile).sessions.ses_comp_auto?.status === "running");

  emit({ id: "c2", type: "session.compaction.delta", created: Date.now(), data: { sessionID: "ses_comp_auto" } });
  await sleep(30);
  assert.equal(readJson(stateFile).sessions.ses_comp_auto?.status, "running");

  emit({ id: "c3", type: "session.compaction.ended", created: Date.now(), data: { sessionID: "ses_comp_auto" } });
  await waitFor(() => readJson(stateFile).sessions.ses_comp_auto === undefined, "Independent compaction completion becomes idle");

  // Failed compaction also ends activity.
  emit({ id: "c4", type: "session.compaction.started", created: Date.now(), data: { sessionID: "ses_comp_fail" } });
  await waitFor(() => readJson(stateFile).sessions.ses_comp_fail?.status === "running");

  emit({ id: "c5", type: "session.compaction.failed", created: Date.now(), data: { sessionID: "ses_comp_fail" } });
  await waitFor(() => readJson(stateFile).sessions.ses_comp_fail === undefined, "Failed compaction becomes idle");

  // Compaction finishing within a turn must not clear the turn.
  emit({ id: "ex1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_comp_turn" } });
  await waitFor(() => readJson(stateFile).sessions.ses_comp_turn?.status === "running");

  emit({ id: "t1", type: "session.tool.input.delta", created: Date.now(), data: { sessionID: "ses_comp_turn" } });
  emit({ id: "c6", type: "session.compaction.started", created: Date.now(), data: { sessionID: "ses_comp_turn" } });
  emit({ id: "c7", type: "session.compaction.delta", created: Date.now(), data: { sessionID: "ses_comp_turn" } });
  await sleep(40);
  assert.equal(readJson(stateFile).sessions.ses_comp_turn?.status, "running");

  emit({ id: "c8", type: "session.compaction.ended", created: Date.now(), data: { sessionID: "ses_comp_turn" } });
  await sleep(40);
  assert.equal(readJson(stateFile).sessions.ses_comp_turn?.status, "running", "Compaction ended must not clear an active turn");

  emit({ id: "ex2", type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "ses_comp_turn" } });
  await waitFor(() => readJson(stateFile).sessions.ses_comp_turn === undefined, "Execution completion becomes idle");
});

test("opencode-plugin: missing ctx.event.subscribe exits without creating a snapshot", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-nosub-", t);
  const contextWithoutSubscribe = {
    location: { directory: "/project/nosub" },
    event: {}, // No subscribe method.
  };

  const cleanup = await plugin.setup(contextWithoutSubscribe, { stateDir: dir });
  defer(cleanup);

  const jsonFiles = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.equal(jsonFiles.length, 0, "Missing subscription support must not create files");

  // Cleanup must remain callable.
  await assert.doesNotReject(async () => {
    await cleanup();
  });
});

test("opencode-plugin: silent long work remains active after a brief disconnect", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-lease-silent-", t);
  const { context, emit, setStreamFail, getSubscribeCount } = createMockOpenCodeContext({ directory: "/project/lease-silent" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 30 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // Start long work.
  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_silent" } });
  await waitFor(() => readJson(stateFile).sessions.ses_silent?.status === "running");

  // Disconnect briefly (50 ms).
  setStreamFail(true);
  await sleep(50);

  // Reconnect without new activity events.
  setStreamFail(false);
  await waitFor(() => getSubscribeCount() >= 2, "Reconnect must trigger a second subscription");

  // The silent task remains running.
  const state = readJson(stateFile);
  assert.equal(state.sessions.ses_silent?.status, "running", "Silent long work must remain running");

  const status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 500 });
  assert.equal(status.working, true, "Reconnect must not release silent work");
  assert.equal(status.activeSessions.includes("ses_silent"), true);
});

test("opencode-plugin: authoritative API recovers completion during disconnect", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-lease-expire-", t);
  const { context, emit, updateApi, setStreamFail, getSubscribeCount } = createMockOpenCodeContext({ directory: "/project/lease-expire" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 25 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_ghost" } });
  await waitFor(() => readJson(stateFile).sessions.ses_ghost?.status === "running");

  // Disconnect.
  setStreamFail(true);
  await sleep(40);
  updateApi({ type: "session.execution.succeeded", data: { sessionID: "ses_ghost" } });

  // Complete work during disconnect; no terminal event will be replayed.
  setStreamFail(false);
  await waitFor(() => getSubscribeCount() >= 2, "Reconnect must trigger a second subscription");

  // Confirm completion through the API without another event.
  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_ghost === undefined && Object.keys(s.sessions).length === 0;
  }, "Confirmed completion must remove the session", 1000);

  const status = getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 500 });
  assert.equal(status.working, false, "Confirmed completion must allow sleep");
  assert.equal(status.activeSessions.length, 0);
});

test("opencode-plugin: pending or failed first iterator.next does not stop process heartbeats", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-first-event-", t);
  let nextStarted = false;
  let resolveNext = null;

  const mockContext = {
    location: { directory: "/project/first-event" },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              nextStarted = true;
              return new Promise((resolve, reject) => {
                resolveNext = { resolve, reject };
              });
            },
            async return() {
              return { done: true, value: undefined };
            },
          };
        },
      }),
    },
  };

  const cleanup = await plugin.setup(mockContext, { stateDir: dir, pollIntervalMs: 20 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));
  await waitFor(() => nextStarted, "The first next call must occur");

  const initialHeartbeat = readJson(stateFile).heartbeat;

  // Wait several poll cycles while the first next is pending.
  await sleep(80);

  assert.ok(readJson(stateFile).heartbeat > initialHeartbeat, "Heartbeats must continue before any stream event");

  // Fail the first next call.
  resolveNext.reject(new Error("Connection failed"));
  await sleep(50);

  assert.ok(readJson(stateFile).heartbeat > initialHeartbeat, "Stream failure is not process death");
});

test("opencode-plugin: repeated slow EOF/errors accumulate backoff instead of resetting it", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-slow-backoff-", t);
  let subscribeAttempts = 0;
  const attemptTimestamps = [];

  const slowFailContext = {
    location: { directory: "/project/slow-fail" },
    event: {
      subscribe: () => {
        subscribeAttempts += 1;
        attemptTimestamps.push(Date.now());
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                // Each connection ends after 60 ms without a valid event.
                await sleep(60);
                return { done: true, value: undefined };
              },
              async return() {
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    },
  };

  const cleanup = await plugin.setup(slowFailContext, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  // Observe at least three connection attempts.
  await waitFor(() => attemptTimestamps.length >= 3, "Slow EOF must eventually retry three times", 3000);

  // Exponential backoff bounds retry frequency.
  assert.equal(subscribeAttempts >= 3, true, "At least three attempts must occur");
  assert.equal(subscribeAttempts <= 5, true, `Slow EOF must not reset backoff (attempts: ${subscribeAttempts})`);

  // Assert that successive attempt intervals grow.
  const gap1 = attemptTimestamps[1] - attemptTimestamps[0];
  const gap2 = attemptTimestamps[2] - attemptTimestamps[1];
  assert.equal(gap2 > gap1, true, `Second interval (${gap2} ms) must exceed first (${gap1} ms)`);
});

test("opencode-plugin: malformed first events cannot create activity; valid events after reconnect recover", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-malformed-first-", t);
  const { context, emit, closeStream, getSubscribeCount } = createMockOpenCodeContext({
    directory: "/project/malformed",
    autoConnectEvent: false,
  });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 500 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));
  const initialHeartbeat = readJson(stateFile).heartbeat;

  // Emit malformed first events.
  emit(null);
  emit({});
  emit({ type: "" });
  emit({ type: "   " });
  emit({ notType: "some_data" });

  await sleep(80);

  assert.deepEqual(readJson(stateFile).sessions, {}, "Malformed events must not create activity");

  // Close the stream with EOF.
  closeStream();

  // Observe an actual reconnection.
  await waitFor(() => getSubscribeCount() >= 2, "EOF after malformed events must reconnect");

  // Emit a valid event on the new stream.
  emit({
    id: "ok_1",
    type: "session.execution.started",
    created: Date.now(),
    data: { sessionID: "ses_valid_after_retry" },
  });

  await waitFor(() => {
    const s = readJson(stateFile);
    return s.sessions.ses_valid_after_retry?.status === "running" && s.heartbeat > initialHeartbeat;
  }, "Valid events must record activity and update the heartbeat");
});

test("opencode-plugin: execution termination also clears orphaned compaction activity", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-compact-clear-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/compact-clear" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  // Start execution.
  emit({ id: "e1", type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_cc" } });
  await waitFor(() => readJson(stateFile).sessions.ses_cc?.status === "running");

  // Start compaction.
  emit({ id: "c1", type: "session.compaction.started", created: Date.now(), data: { sessionID: "ses_cc" } });
  await sleep(30);
  assert.equal(readJson(stateFile).sessions.ses_cc?.status, "running");

  // Fail execution without emitting compaction.ended.
  emit({ id: "e2", type: "session.execution.failed", created: Date.now(), data: { sessionID: "ses_cc" } });

  // Compaction belongs to the terminated execution, so the session becomes idle.
  await waitFor(() => readJson(stateFile).sessions.ses_cc === undefined, "Execution termination must also clear compaction");
});

test("opencode-plugin: shell.failed ends shell activity", async (t) => {
  const { dir, defer } = createTestDir("opencode-plug-shell-fail-", t);
  const { context, emit } = createMockOpenCodeContext({ directory: "/project/shell-fail" });

  const cleanup = await plugin.setup(context, { stateDir: dir, pollIntervalMs: 50 });
  defer(cleanup);

  const stateFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json")));

  emit({ id: "sh1", type: "session.shell.started", created: Date.now(), data: { sessionID: "ses_sh_fail" } });
  await waitFor(() => readJson(stateFile).sessions.ses_sh_fail?.status === "running");

  emit({ id: "sh2", type: "session.shell.failed", created: Date.now(), data: { sessionID: "ses_sh_fail" } });
  await waitFor(() => readJson(stateFile).sessions.ses_sh_fail === undefined, "Shell failed must end shell activity");
});
