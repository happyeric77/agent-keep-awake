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

## Limitations

- On battery power, `caffeinate -s` (system sleep) is ignored by macOS —
  only idle sleep is prevented. This is an Apple design decision.
- Closing the laptop lid still forces sleep regardless of `caffeinate`.
- The daemon checks the *agent status* reported by Herdr; it cannot see
  in-flight work of an agent that Herdr still considers idle.
- Keeping the display on drains battery noticeably (the display is the most
  power-hungry component). Set `KEEP_AWAKE_DISPLAY=0` if you prefer battery
  life over a lit screen.

## License

MIT
