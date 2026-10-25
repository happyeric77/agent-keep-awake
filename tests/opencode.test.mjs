import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import plugin from "../opencode-plugin.mjs";
import { getOpenCodeStatus } from "../opencode.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, message, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`Timed out: ${message}`);
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "keep-awake-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createContext({ listed = [], messages = {} } = {}) {
  const streams = new Set();
  const waits = new Map();
  const running = new Set();
  let subscribes = 0;

  const context = {
    event: {
      subscribe({ signal }) {
        subscribes += 1;
        let stopped = false;
        let wake;
        const queue = [];
        const stream = {
          push(event) {
            queue.push(event);
            wake?.();
            wake = null;
          },
          stop() {
            stopped = true;
            wake?.();
            wake = null;
          },
        };
        streams.add(stream);
        signal?.addEventListener("abort", stream.stop);
        return (async function* () {
          try {
            while (!stopped) {
              if (queue.length > 0) yield queue.shift();
              else await new Promise((resolve) => (wake = resolve));
            }
          } finally {
            streams.delete(stream);
          }
        })();
      },
    },
    session: {
      list: async () => ({ data: listed.map((id) => ({ id })) }),
      wait: async ({ sessionID }) => {
        if (running.has(sessionID)) await new Promise((resolve) => waits.set(sessionID, resolve));
      },
      context: async ({ sessionID }) => messages[sessionID] ?? [],
    },
  };

  return {
    context,
    listed,
    running,
    waits,
    emit: (type, data) => [...streams].forEach((stream) => stream.push({ type, data })),
    disconnect: () => [...streams].forEach((stream) => stream.stop()),
    count: () => subscribes,
  };
}

async function setup(t, mock, id = "instance") {
  const dir = tempDir(t);
  t.after(await plugin.setup(mock.context, { stateDir: dir, id }));
  const status = () => getOpenCodeStatus({ opencodeDir: dir, isPidAlive: () => true });
  return { dir, status, snapshot: () => JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) };
}

test("tracks background sessions, not only the focused one", async (t) => {
  const mock = createContext();
  const app = await setup(t, mock);
  mock.emit("session.execution.started", { sessionID: "ses_focused" });
  mock.emit("session.shell.started", { sessionID: "ses_focused", shell: { id: "sh_1" } });
  mock.emit("session.shell.ended", { sessionID: "ses_focused", shell: { id: "sh_1" } });
  mock.emit("session.execution.started", { sessionID: "ses_background" });
  await waitFor(() => app.status().working, "both sessions must be active");
  assert.deepEqual(app.snapshot().sessions, ["ses_background", "ses_focused"]);
  mock.emit("session.execution.succeeded", { sessionID: "ses_focused" });
  await waitFor(() => !app.status().activeSessions.includes("ses_focused"), "first turn ends");
  assert.equal(app.status().working, true, "the background session still works");
  mock.emit("session.execution.succeeded", { sessionID: "ses_background" });
  await waitFor(() => !app.status().working, "all work ends");
});

test("reconnects keep work and silence never expires it", async (t) => {
  const mock = createContext();
  const app = await setup(t, mock);
  mock.emit("session.execution.started", { sessionID: "ses_slow" });
  await waitFor(() => app.status().working, "work starts");
  mock.disconnect();
  await waitFor(() => mock.count() >= 2, "the stream reconnects");
  await sleep(1200);
  assert.equal(app.status().working, true, "silent work survives the reconnect");
  mock.emit("session.execution.succeeded", { sessionID: "ses_slow" });
  await waitFor(() => !app.status().working, "the completion event clears it");
});

test("recovers a session that started while the stream was down", async (t) => {
  const mock = createContext();
  const app = await setup(t, mock);
  mock.disconnect();
  mock.listed.push("ses_new");
  mock.running.add("ses_new");
  await waitFor(() => mock.count() >= 2, "the stream reconnects");
  await waitFor(() => app.status().activeSessions.includes("ses_new"), "the missed session is found");
  mock.waits.get("ses_new")();
  await waitFor(() => !app.status().working, "confirmed idle clears the session");
});

test("a discovered running shell stays awake until it ends", async (t) => {
  const mock = createContext({
    listed: ["ses_shell"],
    messages: { ses_shell: [{ type: "shell", status: "running" }] },
  });
  const app = await setup(t, mock);
  await waitFor(() => app.status().working, "a running shell stays awake");
  mock.emit("session.shell.ended", { sessionID: "ses_shell" });
  await waitFor(() => !app.status().working, "the ended shell clears");
});

test("instances retry failed writes in silence and clean up only their own snapshot", async (t) => {
  const mock = createContext();
  const dir = tempDir(t);
  const stopA = await plugin.setup(mock.context, { stateDir: dir, id: "a" });
  t.after(await plugin.setup(mock.context, { stateDir: dir, id: "b" }));
  rmSync(join(dir, "b.json"));
  mkdirSync(join(dir, "b.json")); // Block atomic rename without depending on permissions.
  mock.emit("session.execution.started", { sessionID: "ses_shared" });
  const written = (id) => JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")).sessions.length === 1;
  await waitFor(() => written("a"), "the event was processed");

  await stopA();
  rmSync(join(dir, "b.json"), { recursive: true });
  await waitFor(() => getOpenCodeStatus({ opencodeDir: dir }).working, "silent retry publishes b");
  assert.deepEqual(readdirSync(dir), ["b.json"]);
});

test("ignores snapshots from dead processes", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "dead.json"), JSON.stringify({ pid: 111, sessions: ["ses_dead"] }));
  writeFileSync(join(dir, "live.json"), JSON.stringify({ pid: 222, sessions: ["ses_live"] }));

  const status = getOpenCodeStatus({ opencodeDir: dir, isPidAlive: (pid) => pid === 222 });
  assert.deepEqual(status.activeSessions, ["ses_live"]);
  assert.equal(status.instancesCount, 1);
});

test("status command counts unique live sessions globally and prints nothing when idle", (t) => {
  const dir = tempDir(t);
  const command = fileURLToPath(new URL("../opencode-status.mjs", import.meta.url));
  const run = (stateDir = dir) => {
    const result = spawnSync(process.execPath, [command], {
      cwd: dir,
      env: { ...process.env, OPENCODE_STATE_DIR: stateDir },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout;
  };
  const snapshot = (name, sessions) =>
    writeFileSync(join(dir, name), JSON.stringify({ pid: process.pid, sessions }));

  assert.equal(run(), "");
  snapshot("a.json", ["ses_a"]);
  snapshot("b.json", ["ses_a"]);
  writeFileSync(join(dir, "broken.json"), "{");
  writeFileSync(join(dir, "dead.json"), JSON.stringify({ pid: 2147483647, sessions: ["ses_dead"] }));
  assert.equal(run(), "OC: 1 active\n");
  snapshot("b.json", ["ses_a", "ses_b", "ses_c"]);
  assert.equal(run(), "OC: 3 active\n");
  snapshot("a.json", []);
  snapshot("b.json", []);
  assert.equal(run(), "");
  assert.equal(run(join(dir, "missing")), "");
});
