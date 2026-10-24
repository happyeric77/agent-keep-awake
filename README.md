# Herdr Keep Awake

Prevent your Mac from sleeping while a Herdr agent is working.

> **macOS only.** This plugin relies on `caffeinate`, which ships with macOS.
> Linux (`systemd-inhibit`) and Windows (`SetThreadExecutionState`) support is a
> possible future addition — pull requests welcome.

Requires Node.js 18+. Zero npm dependencies.

## How it works

A startup hook spawns a small daemon. Every 15 seconds the daemon runs
`herdr pane list`, and if **any** pane reports `agent_status: working` it keeps
`caffeinate -i -s -d` alive — preventing system sleep and keeping the display
on. When no agent is working, `caffeinate` is stopped and the Mac may sleep
again. `blocked` panes are intentionally ignored: a blocked agent means you
should be coming back.

### OpenCode sessions (optional)

Herdr pane state only describes the focused session. With the OpenCode plugin
installed, the daemon also reads small per-instance snapshots written by
`opencode-plugin.mjs`, so background sessions in any project keep the Mac awake:

- The plugin follows `ctx.event.subscribe`, which covers every session in the
  OpenCode process, not just the focused one.
- A session stays awake while an execution, an independent shell, or a
  compaction is running. Silence and reconnects never expire work; only
  completion events, `session.deleted`, or process exit clear it.
- After connecting or reconnecting, the newest sessions are re-checked with
  `session.list`, `session.wait`, and `session.context` so work that started
  while the event stream was down is not missed.
- Snapshots contain only the process ID and running session IDs. The daemon
  ignores snapshots from dead processes.

## Setup

Install from GitHub:

```
herdr plugin install happyeric77/agent-keep-awake
```

Or link a local checkout while developing:

```
herdr plugin link /path/to/agent-keep-awake
```

Create the plugin config:

```
CONFIG_DIR="$(herdr plugin config-dir herdr.keep-awake)"
mkdir -p "$CONFIG_DIR"
cp .env.example "$CONFIG_DIR/.env"
```

Confirm the actions are visible:

```
herdr plugin action list --plugin herdr.keep-awake
```

The daemon starts automatically on the next Herdr server start (startup hook).
To start it without restarting Herdr:

```
herdr plugin action invoke herdr.keep-awake.enable
```

### OpenCode (optional)

Register the **directory**, not an individual file, in your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/agent-keep-awake"]
}
```

OpenCode does not read Herdr's `.env`. Both sides default to
`~/.local/state/herdr-keep-awake/opencode`; if you override `OPENCODE_STATE_DIR`,
export it for both processes.

## Usage

Once enabled, nothing else to do — the daemon keeps your Mac awake while agents
work, and lets it sleep when they finish.

Toggle notifications on/off:

```
herdr plugin action invoke herdr.keep-awake.toggle
```

Check the current mode:

```
cat ~/.local/state/herdr/plugins/herdr.keep-awake/enabled
```

Check the daemon log:

```
cat ~/.local/state/herdr/plugins/herdr.keep-awake/daemon.log
```

## Keybinding

Bind the toggle action from `~/.config/herdr/config.toml`:

```
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "herdr.keep-awake.toggle"
description = "Toggle keep awake"
```

Reload Herdr after changing the config, and enable toasts to see feedback:

```
herdr server reload-config
```

```
[ui.toast]
delivery = "herdr"
```

## Configuration

All settings are read from `$CONFIG_DIR/.env`:

| Variable | Default | Description |
|---|---|---|
| `KEEP_AWAKE_ENABLED` | `1` | Master on/off switch |
| `KEEP_AWAKE_POLL_INTERVAL` | `15` | Poll interval in seconds |
| `KEEP_AWAKE_DISPLAY` | `1` | Keep the display on too while working; set `0` to only prevent system sleep (saves battery) |
| `OPENCODE_KEEP_AWAKE_ENABLED` | `1` | Also read snapshots written by the OpenCode plugin |
| `OPENCODE_STATE_DIR` | `~/.local/state/herdr-keep-awake/opencode` | Shared snapshot directory; export for both Herdr and OpenCode |

## Limitations

- On battery power, `caffeinate -s` (system sleep) is ignored by macOS —
  only idle sleep is prevented. This is an Apple design decision.
- Closing the laptop lid still forces sleep regardless of `caffeinate`.
- The daemon checks the *agent status* reported by Herdr; it cannot see
  in-flight work of an agent that Herdr still considers idle.
- Without the OpenCode plugin, only Herdr panes are visible. With it, activity
  from OpenCode processes is included, but a session whose start *and* finish
  are both missed stays awake until process exit (it never causes a false idle).
- Keeping the display on drains battery noticeably (the display is the most
  power-hungry component). Set `KEEP_AWAKE_DISPLAY=0` if you prefer battery
  life over a lit screen.

## License

MIT
