# Herdr Keep Awake

Prevent your Mac from sleeping while a Herdr agent or OpenCode session is working.

> **macOS only.** Uses the built-in `caffeinate` command.

Requires Node.js 18+. Zero npm dependencies.

## How it works

A startup hook starts a daemon. Every 15 seconds it checks two independent sources:

1. `herdr pane list`, with a bounded command timeout, for `agent_status: working`.
2. OpenCode plugin snapshots for active sessions, including sessions not focused in the UI.

If **either** source is working, the daemon keeps `caffeinate -i -s -d` running.
It stops caffeinate only when both sources are idle. Herdr `blocked` panes do not
count as working. Herdr CLI failures do not disable protection for active OpenCode
sessions. Without the optional OpenCode plugin, Herdr detection still works.

### OpenCode tracking and reconnects

The plugin subscribes through `ctx.event.subscribe` and independently tracks:

- **Agent execution:** execution, retry, step, text, reasoning, and tool progress
  mark a session active. Execution succeeded/failed/interrupted ends the turn.
- **Shells:** each `session.shell.started` adds its Shell ID; ended/failed removes
  only that shell. One shell finishing cannot clear another shell or an active turn.
- **Compaction:** started/delta marks active; ended/failed clears compaction, not
  the containing turn. An execution terminal event also clears its compaction.

A session is `running` while any tracked activity remains. Permission/form waits
inside a turn remain active until the user responds or interrupts the turn.

**Silence is not completion. There is no Busy lease or time-based Busy expiry.**
Reconciliation was verified against OpenCode **2.1.2**:

- Startup and every resubscription discover sessions through unfiltered,
  paginated `ctx.session.list`, then recheck all known activities. Checks retry
  every 10 seconds, with a five-second query timeout.
- `ctx.session.wait({ sessionID })` confirms that this host's foreground Agent
  loop has finished, including retry/backoff. It does **not** wait for independent
  shells. Those require a persisted terminal message in `ctx.session.context`
  with the **same Shell ID** and status `exited`, `timeout`, or `killed`.
  A missing message or a completed Agent wait does not establish shell completion.
- Revision checks prevent an old asynchronous idle response from clearing newer
  activity. Terminal events and explicit `SessionNotFoundError` also clear work.
- API failures/timeouts retain unconfirmed Busy and retry. API recovery can clear
  a lost idle event without relying on another event. If both the API and terminal
  events remain unavailable indefinitely, protection remains conservatively active
  until recovery, an explicit terminal event, or process exit; time cannot prove
  that work finished.
- Heartbeats indicate a live plugin process, not event-stream progress. Stream
  failures use bounded exponential backoff (250 ms to five seconds) without
  allowing active work to expire through a stale heartbeat.

**API scope matters:** the session list is database-wide, across projects and
directories; it does not prove process ownership. Agent waits are process-local.
`ctx.location` is the plugin load location, not an event/session access boundary.
HTTP `/api/session/active` reports only this process's foreground drains as
`running`, excludes independent shells, and is not exposed in Plugin Context.
Do not substitute the V1 busy/retry/idle API.

Each plugin instance writes its own UUID snapshot to
`~/.local/state/herdr-keep-awake/opencode/<uuid>.json`, even when several instances
share a PID. Snapshots contain only instance identity, heartbeat, and sanitized
running session IDs, never prompts, commands, tokens, or raw errors. Writes use an
atomic temporary-file rename. Missing event subscription support creates no file.
Cleanup removes only the instance's own file. After a crash, the reader ignores a
dead PID immediately; stale heartbeats exclude a hung plugin. The reader does not
unlink files, avoiding replacement races.

## Setup

### Herdr

```sh
herdr plugin install happyeric77/agent-keep-awake
# Or use a local checkout:
herdr plugin link /path/to/agent-keep-awake

CONFIG_DIR="$(herdr plugin config-dir herdr.keep-awake)"
mkdir -p "$CONFIG_DIR"
cp .env.example "$CONFIG_DIR/.env"
herdr plugin action list --plugin herdr.keep-awake
```

The daemon starts on the next Herdr server start. To start without restarting:

```sh
herdr plugin action invoke herdr.keep-awake.enable
```

### OpenCode V2 (optional)

The directory entrypoint `index.js` loads the sibling `opencode-plugin.mjs`.
Register the **directory**, not an individual `.mjs` file, in OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/agent-keep-awake"]
}
```

Or link the directory into a project's plugin directory:

```sh
mkdir -p .opencode/plugins
ln -s /path/to/agent-keep-awake .opencode/plugins/keep-awake
```

OpenCode does not read Herdr's `$CONFIG_DIR/.env`. Both components default to the
same snapshot directory. If overriding `OPENCODE_STATE_DIR`, export it in the
environment inherited by **both** Herdr and OpenCode.

## Usage

```sh
herdr plugin action invoke herdr.keep-awake.toggle
cat ~/.local/state/herdr/plugins/herdr.keep-awake/enabled
cat ~/.local/state/herdr/plugins/herdr.keep-awake/daemon.log
```

Outside Herdr, without `HERDR_PLUGIN_STATE_DIR`, daemon files default to
`~/.local/state/herdr-keep-awake/`.

To bind the toggle in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "herdr.keep-awake.toggle"
description = "Toggle keep awake"

[ui.toast]
delivery = "herdr"
```

Reload with `herdr server reload-config`.

## Configuration

The daemon reads `$CONFIG_DIR/.env`:

| Variable | Default | Description |
|---|---|---|
| `KEEP_AWAKE_ENABLED` | `1` | Master switch |
| `KEEP_AWAKE_POLL_INTERVAL` | `15` | Daemon polling interval, seconds |
| `KEEP_AWAKE_DISPLAY` | `1` | Keep the display on; `0` prevents idle sleep without keeping the display lit |
| `OPENCODE_KEEP_AWAKE_ENABLED` | `1` | Read OpenCode snapshots |
| `OPENCODE_HEARTBEAT_TIMEOUT` | `30` | Ignore older heartbeats, seconds; does not delete files |
| `OPENCODE_STATE_DIR` | `~/.local/state/herdr-keep-awake/opencode` | Shared snapshot directory; export for both processes |
| `HERDR_TIMEOUT_MS` | `5000` | Herdr CLI timeout, milliseconds |

## Tests and acceptance

```sh
node --test tests/*.test.mjs
```

Tests cover reconciliation, lost events, retry/backoff, races, multiple sessions
and instances, stale/dead snapshots, and the daemon's Herdr OR OpenCode logic,
including subprocess and caffeinate lifecycle checks.
See [real-host reconnect acceptance](docs/reconnect-acceptance.md) for actual
OpenCode, Herdr, and macOS power-assertion evidence and its limits.

## Limitations

- Natural network faults, real provider retry, real compaction, and actual macOS
  sleep/wake have **not** been accepted end-to-end. Controlled subscription fault
  injection is not a natural network failure.
- The event stream is volatile, without replay. Reconciliation recovers foreground
  drains and shells whose start was observed. Plugin Context provides no
  process-owned shell listing: if an independent shell's start and end are both
  missed, historical database messages cannot safely establish process ownership.
  A missing shell message (including one removed by compaction) conservatively
  retains already known Busy until a terminal event or process exit.
- Detached work outside the monitored host is not tracked. If both sources miss
  activity, the daemon cannot detect it.
- Unanswered permission/form requests can keep the Mac awake indefinitely.
- On battery, macOS ignores `caffeinate -s`; `-i` still prevents idle sleep.
  Closing a laptop lid can force sleep regardless of caffeinate.
- Keeping the display lit drains battery; set `KEEP_AWAKE_DISPLAY=0` to avoid it.

## License

MIT
