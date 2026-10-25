# Agent Keep Awake

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![macOS](https://img.shields.io/badge/macOS-only-000000)
![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933)

**Agents working. Mac awake. Even in the background.**

A lightweight keep-awake integration for **Herdr** and **OpenCode v2** on macOS.

Agent Keep Awake prevents your Mac from idling to sleep while a Herdr agent or a tracked OpenCode session is working. Switching to a new, idle OpenCode session doesn't stop protection for work still running in the background. An optional indicator in Herdr's top tab bar shows how many OpenCode sessions are detected as active.

## Overview

<img width="900" alt="Agent Keep Awake demo" src="https://github.com/user-attachments/assets/b4687a08-546c-4736-a5df-3332a47c8bdf" />


Herdr normally reports the state of the selected session. An OpenCode session can continue working after you switch to `/new`, even when Herdr shows **Idle**.

Agent Keep Awake keeps sleep prevention separate from that UI state:

- The **Herdr plugin** manages a small daemon and macOS `caffeinate`.
- The **optional OpenCode plugin** tracks session activity, including background work.
- The **optional tab-bar command** shows a global activity count without changing Herdr's native Working/Idle state.

For example, the top-right status can show:

```text
🖥️ OpenCode sessions: 2 active
```

The indicator is global, not tied to whichever workspace or agent you have selected.

## Features

- **Background-session aware** — keep the Mac awake when an OpenCode session continues working after you switch sessions.
- **Herdr integration** — also respond to any Herdr pane reporting `working`.
- **Global activity indicator** — optionally show `🖥️ OpenCode sessions: N active` in Herdr's top tab bar; hide it when no activity is detected.
- **Automatic sleep control** — start `caffeinate` when work is detected and stop it when tracked work finishes.
- **Resilient tracking** — reconnect to OpenCode events, recover recently started work, and ignore snapshots from dead processes.
- **Small footprint** — Node.js 18+, no npm dependencies, and no additional status daemon.

## Quick Start

### Requirements

- macOS (uses the built-in `caffeinate` command)
- Node.js 18 or newer
- Herdr 0.7.0 or newer
- OpenCode v2 **only if** you want background OpenCode session tracking

### Install the Herdr plugin

Clone the repository and link it to Herdr:

```sh
git clone https://github.com/happyeric77/agent-keep-awake.git
cd agent-keep-awake
herdr plugin link "$PWD"
herdr plugin action invoke herdr.keep-awake.enable
```

Alternatively, for Herdr-only installation:

```sh
herdr plugin install happyeric77/agent-keep-awake
herdr plugin action invoke herdr.keep-awake.enable
```

Verify the registered actions:

```sh
herdr plugin action list --plugin herdr.keep-awake
```

The startup hook also starts the daemon on the next Herdr server start when keep-awake mode is enabled. Background OpenCode tracking requires the additional step below.

### Track OpenCode sessions (optional)

Add the **repository directory**, not `opencode-plugin.mjs`, to the `plugins` array in your OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/agent-keep-awake"]
}
```

If you already have plugins configured, append this path rather than replacing the existing entries. OpenCode must be able to access that directory.

Both integrations use `~/.local/state/herdr-keep-awake/opencode` by default for activity snapshots. If you set `OPENCODE_STATE_DIR`, use the same directory in the Herdr daemon and OpenCode process environments.

### Show activity in Herdr's tab bar (optional)

Add a `command` item to the existing `[ui].tab_bar_right` configuration in `~/.config/herdr/config.toml`:

```toml
[ui]
tab_bar_right = [
  { type = "command", command = "'/absolute/path/to/node' '/absolute/path/to/agent-keep-awake/opencode-status.mjs'", interval_seconds = 5, timeout_seconds = 2 },
]
```

Replace both paths with their actual absolute paths. Run `command -v node` to locate Node.js. Merge the entry into your existing `[ui]` section and `tab_bar_right` array; don't replace other status items.

Reload the configuration:

```sh
herdr server reload-config
```

When active sessions are detected, the right side of the top tab bar shows `🖥️ OpenCode sessions: N active`. When none are detected, the command produces no output and the indicator disappears. It works regardless of the currently selected Herdr workspace or project.

The status command reads the same snapshots as the daemon, but runs independently: a display-command failure cannot change sleep prevention. If using a custom `OPENCODE_STATE_DIR`, also make it available to the status command's environment.

## Usage

Once enabled, the daemon manages sleep prevention automatically.

| Action | Command |
| --- | --- |
| Enable | `herdr plugin action invoke herdr.keep-awake.enable` |
| Disable | `herdr plugin action invoke herdr.keep-awake.disable` |
| Toggle | `herdr plugin action invoke herdr.keep-awake.toggle` |
| Read daemon log | `cat ~/.local/state/herdr/plugins/herdr.keep-awake/daemon.log` |

To add an optional toggle keybinding in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "herdr.keep-awake.toggle"
description = "Toggle keep awake"
```

Reload Herdr after changing the configuration. To receive action feedback in Herdr, enable toast delivery under your existing configuration:

```toml
[ui.toast]
delivery = "herdr"
```

## How It Works

1. Every 15 seconds by default, the daemon queries `herdr pane list` for panes reporting `working`.
2. When OpenCode integration is enabled, an event subscriber tracks executions, running shells, and compaction across sessions. Each plugin instance writes a small atomic snapshot containing its PID and active session IDs.
3. The daemon combines **Herdr working OR OpenCode working** and holds `caffeinate -i -s` (plus `-d` by default) while work is detected. A `blocked` Herdr pane does not count as working.
4. The tab-bar status command deduplicates active session IDs across live-process snapshots. It does not write pane metadata or override Herdr's native agent status.

The OpenCode tracker attempts to recover missed starts by inspecting the ten newest sessions after connecting or reconnecting. It does not expire ongoing work merely because events are temporarily silent.

## Configuration

All settings are optional. To customize them, create a `.env` file in the Herdr plugin configuration directory. From a local checkout:

```sh
CONFIG_DIR="$(herdr plugin config-dir herdr.keep-awake)"
mkdir -p "$CONFIG_DIR"
cp .env.example "$CONFIG_DIR/.env"
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `KEEP_AWAKE_ENABLED` | `1` | Default mode if no saved enable/disable state exists |
| `KEEP_AWAKE_POLL_INTERVAL` | `15` | Herdr polling interval in seconds |
| `KEEP_AWAKE_DISPLAY` | `1` | Also prevent display idle sleep; set `0` to conserve battery |
| `OPENCODE_KEEP_AWAKE_ENABLED` | `1` | Include OpenCode activity when snapshots are available |
| `OPENCODE_STATE_DIR` | `~/.local/state/herdr-keep-awake/opencode` | Shared snapshot location; configure in all relevant process environments |

OpenCode does not read Herdr's plugin `.env` automatically.

## Limitations & Safety

- **Best-effort activity:** missed completion events may leave a session marked active until deletion or process exit. Missed starts outside the newest-ten recovery window can go undetected until another event arrives. The tab-bar count inherits these limits.
- **Global, not pane-local:** the activity count does not identify which Herdr pane owns a session. Herdr may display **Idle** for the selected session while a background OpenCode session still keeps the Mac awake.
- **Opt-in OpenCode coverage:** only OpenCode processes loading this integration write snapshots. Without it, sleep prevention relies on Herdr pane status.
- **macOS sleep behavior:** closing the laptop lid can still put the Mac to sleep. On battery power, macOS ignores `caffeinate -s`; idle-sleep prevention is the relevant protection.
- **Battery use:** keeping the display awake consumes additional power. Set `KEEP_AWAKE_DISPLAY=0` to prevent idle system sleep without forcing the display to stay lit.
- **No session control:** the plugin never changes Herdr Working/Idle reports, session selection, or Session Restore references.

## Development

The project uses native JavaScript modules, Node.js, and the Herdr/OpenCode plugin interfaces. There is no build step or dependency installation.

```sh
node --test tests/*.test.mjs
```

Use isolated OpenCode sessions and temporary snapshot directories for manual tests; do not interrupt running user sessions.

## Contributing

Bug reports and focused pull requests are welcome. Keep changes small and preserve the separation between sleep prevention, session tracking, and UI display.

## License

Agent Keep Awake is licensed under the [MIT License](LICENSE).

This is an independent community integration and is not affiliated with or endorsed by Herdr or OpenCode.
