import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import plugin from "../opencode-plugin.mjs";
import { getOpenCodeStatus } from "../opencode.mjs";
import { createMockOpenCodeContext, createTestDir, readJson, sleep, waitFor } from "./helpers.mjs";

const event = (type, sessionID, shellID = "sh_test") => ({ type, data: { sessionID, shell: { id: shellID } } });
async function setup(t, mock = createMockOpenCodeContext(), options = {}) {
  const { dir, defer } = createTestDir("opencode-resync-", t);
  defer(await plugin.setup(mock.context, { stateDir: dir, pollIntervalMs: 25, syncTimeoutMs: 80, ...options }));
  const file = join(dir, readdirSync(dir).find(name => name.endsWith(".json")));
  return { ...mock, snapshot: () => readJson(file), status: () => getOpenCodeStatus({ opencodeDir: dir, heartbeatTimeoutMs: 150 }) };
}

test("Reconnect preserves silent Agent and independent Shell work beyond 10 seconds and recovers lost idle events", { timeout: 16000 }, async t => {
  const m = await setup(t);
  m.emit(event("session.execution.started", "ses_agent"));
  m.emit(event("session.shell.started", "ses_shell"));
  await waitFor(() => m.status().activeSessions.length === 2);
  m.closeStream();
  await waitFor(() => m.getSubscribeCount() >= 2);
  await sleep(10_500);
  assert.deepEqual(m.status().activeSessions.sort(), ["ses_agent", "ses_shell"]);
  m.updateApi(event("session.execution.succeeded", "ses_agent"));
  m.updateApi(event("session.shell.ended", "ses_shell"));
  await waitFor(() => !m.status().working, "Release Awake only after authoritative completion");
});

test("Stream and API failures retain Busy; API recovery reconciles a lost idle event", async t => {
  const m = await setup(t);
  m.emit(event("session.retry.scheduled", "ses_retry"));
  await waitFor(() => m.status().working);
  m.setApiFail(true);
  m.setStreamFail(true);
  await sleep(250);
  assert.equal(m.status().working, true, "Retry, backoff, and transport errors are not completion");
  m.updateApi(event("session.execution.succeeded", "ses_retry"));
  await sleep(150);
  assert.equal(m.status().working, true, "Retain unconfirmed Busy while the API is unavailable");
  m.setApiFail(false);
  await waitFor(() => !m.status().working, "API recovery clears Busy without another stream event");
});

test("Quiet startup discovers process-owned foreground work across paginated directories, excluding foreign history", async t => {
  const mock = createMockOpenCodeContext({ autoConnectEvent: false });
  mock.updateApi(event("session.execution.started", "ses_other_directory"));
  const calls = [];
  mock.context.session.list = async input => {
    calls.push(input);
    return input.cursor ? { data: [{ id: "ses_other_directory" }], cursor: {} }
      : { data: [{ id: "ses_foreign_process" }], cursor: { next: "page2" } };
  };
  const m = await setup(t, mock);
  await waitFor(() => m.status().activeSessions.includes("ses_other_directory"));
  assert.equal(calls.some(input => input.cursor === "page2"), true);
  assert.equal(calls.every(input => input.directory === undefined && input.project === undefined), true);
  await waitFor(() => !m.status().activeSessions.includes("ses_foreign_process"));
  m.updateApi(event("session.execution.succeeded", "ses_other_directory"));
  await waitFor(() => !m.status().working);
});

test("Only a matching persisted Shell terminal state confirms completion, not missing messages or an Agent wait", async t => {
  const mock = createMockOpenCodeContext();
  let messages = [];
  mock.context.session.context = async () => messages;
  const m = await setup(t, mock);
  m.emit(event("session.shell.started", "ses_shell", "sh_current"));
  await waitFor(() => m.status().working);
  await sleep(120);
  assert.equal(m.status().working, true);
  messages = [{ type: "shell", shellID: "sh_old", status: "exited" }];
  await sleep(120);
  assert.equal(m.status().working, true);
  messages.push({ type: "shell", shellID: "sh_current", status: "exited" });
  await waitFor(() => !m.status().working);
});

test("An old asynchronous idle response cannot clear newer activity", async t => {
  const mock = createMockOpenCodeContext();
  const replies = [];
  mock.context.session.wait = () => new Promise(resolve => replies.push(resolve));
  const m = await setup(t, mock, { syncTimeoutMs: 2000 });
  m.emit(event("session.execution.started", "ses_race"));
  await waitFor(() => replies.length > 0);
  m.emit(event("session.execution.succeeded", "ses_race"));
  m.emit(event("session.execution.started", "ses_race"));
  await sleep(30);
  replies.shift()();
  await sleep(50);
  assert.equal(m.status().working, true);
});

test("Shells in the same session reconcile independently when one finishes", async t => {
  const m = await setup(t);
  m.emit(event("session.shell.started", "ses_parallel", "sh_first"));
  m.emit(event("session.shell.started", "ses_parallel", "sh_second"));
  await waitFor(() => m.status().working);
  m.emit(event("session.shell.ended", "ses_parallel", "sh_first"));
  await sleep(100);
  assert.equal(m.status().working, true);
  m.updateApi(event("session.shell.ended", "ses_parallel", "sh_second"));
  await waitFor(() => !m.status().working);
});

test("Hung status queries retain Busy and retry after timeout; SessionNotFound confirms removal", async t => {
  const mock = createMockOpenCodeContext();
  mock.context.session.wait = () => new Promise(() => {});
  const m = await setup(t, mock);
  m.emit(event("session.execution.started", "ses_hung"));
  await waitFor(() => m.status().working);
  await sleep(220);
  assert.equal(m.status().working, true);
  mock.context.session.wait = async () => { throw Object.assign(new Error("gone"), { _tag: "SessionNotFoundError" }); };
  await waitFor(() => !m.status().working);
});
