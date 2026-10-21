# Herdr Keep Awake

Prevent your Mac from sleeping while Herdr agents or OpenCode background sessions are working.

> **macOS only.** This plugin relies on `caffeinate`, which ships with macOS.
> Linux (`systemd-inhibit`) and Windows (`SetThreadExecutionState`) support is a
> possible future addition — pull requests welcome.

Requires Node.js 18+. Zero npm dependencies.

## How it works

A startup hook spawns a small daemon. Every 15 seconds the daemon checks two independent sources:
1. **Herdr panes:** runs `herdr pane list` (with bounded execution timeout) to check if any pane reports `agent_status: working`.
2. **OpenCode sessions:** inspects active OpenCode instances for background or foreground sessions in active execution drain (`running`).

If **either** source is active (logical OR), the daemon keeps `caffeinate -i -s -d` alive — preventing system sleep and keeping the display on. When all Herdr agents and OpenCode sessions become idle, `caffeinate` is stopped and the Mac may sleep again. `blocked` panes and idle sessions are intentionally ignored.

### OpenCode Multi-Session Awareness

When multiple OpenCode sessions exist in the same project or across multiple projects, Herdr pane status only reflects whichever session is currently focused. If Session A is executing a long task in the background while you view idle Session B, Keep Awake uses the OpenCode v2 integration to track Session A independently:

- **Authoritative Active Drains:** OpenCode v2 tracks active foreground session drains via `GET /api/session/active`. In OpenCode engine terms, this guarantees tracking of process-owned foreground drains driving active turns. When an agent turn finishes and awaits user prompt, its drain idles and is omitted from the active snapshot. Note: Retry/backoff real runtime coverage NOT VERIFIED; live plugin load and UI A busy B idle acceptance not performed.
- **Instance Isolation:** Each OpenCode plugin instance assigns itself a unique UUID and writes its active sessions to `~/.local/state/herdr-keep-awake/opencode/<instance-uuid>.json`. Multiple projects running under the same OpenCode server PID remain isolated without state clashing.
- **Resilience & Safe State Invalidation:** If an OpenCode process exits or crashes, the daemon detects process liveness and ignores stale or dead PID state files without unlinking them, avoiding race conditions with filename reuse. Plugin exit owns cleaning up its own state file, and stale heartbeats (default 30s since the last successful authoritative snapshot) automatically expire to prevent staying awake indefinitely. Retained stale or invalid files are ignored safely.
- **Strict Snapshot Validation:** Heartbeats are refreshed only after a successful, valid snapshot. The plugin strictly validates the unwrapped map contract (session IDs prefixed with `ses` and `type: "running"`), rejecting malformed or enveloped responses without refreshing heartbeat or state.
- **Independent Sources & Graceful Fallback:** If Herdr CLI experiences repeated failures while OpenCode sessions are actively running, keep-awake stays alive. If OpenCode or the plugin is not installed, Herdr pane detection continues to work normally.

## Setup

### 1. Herdr Plugin Setup

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

### 2. OpenCode v2 Plugin Setup (Optional, for OpenCode multi-session support)

The plugin file `opencode-plugin.mjs` is completely self-contained with zero dependencies and no relative import requirements.

You can register it in your global OpenCode configuration (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/path/to/agent-keep-awake/opencode-plugin.mjs"
  ]
}
```

Or link/copy it into a project's `.opencode/plugins/` directory:

```bash
mkdir -p .opencode/plugins
ln -s /path/to/agent-keep-awake/opencode-plugin.mjs .opencode/plugins/keep-awake.mjs
```

> **Note on Environment Variables:** OpenCode processes run independently of Herdr and do not read Herdr's `$CONFIG_DIR/.env`. Both the daemon and the OpenCode plugin default to the shared directory `~/.local/state/herdr-keep-awake/opencode/`. If you customize `OPENCODE_STATE_DIR`, export it in your shell environment so both Herdr and OpenCode inherit it.

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

*(When running outside Herdr or without `HERDR_PLUGIN_STATE_DIR`, fallback state is at `~/.local/state/herdr-keep-awake/`)*

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
| `OPENCODE_KEEP_AWAKE_ENABLED` | `1` | Enable OpenCode multi-session tracking |
| `OPENCODE_HEARTBEAT_TIMEOUT` | `30` | Heartbeat timeout in seconds for OpenCode process cleanup |
| `OPENCODE_STATE_DIR` | `~/.local/state/herdr-keep-awake/opencode` | Explicit shared directory for OpenCode state files |
| `HERDR_TIMEOUT_MS` | `5000` | Bounded execution timeout in milliseconds for `herdr pane list` |

## Testing

Run unit and integration tests using Node.js:

```bash
node --test
```

### Test Scope & Limitations

- Node test suite covers daemon subprocess lifecycle, caffeinate signaling, process liveness checks, and OpenCode state file parsing.
- **Verification Limitations:**
  - Retry/backoff real runtime coverage NOT VERIFIED (no concrete installed engine evidence that provider retry backoff preserves active drain state).
  - Live plugin load and UI A busy B idle acceptance not performed.
  - Complete validation is not claimed.

## Limitations

- On battery power, `caffeinate -s` (system sleep) is ignored by macOS —
  only idle sleep is prevented. This is an Apple design decision.
- Closing the laptop lid still forces sleep regardless of `caffeinate`.
- The daemon checks the *agent status* reported by Herdr and OpenCode session status; it cannot see in-flight work of an agent that neither system considers active.
- OpenCode tracking observes foreground Session drains returned by `/api/session/active`. Any external or detached processes spawned outside OpenCode's in-process turn execution (or sessions on other unmonitored servers) are not represented.
- Keeping the display on drains battery noticeably (the display is the most
  power-hungry component). Set `KEEP_AWAKE_DISPLAY=0` if you prefer battery
  life over a lit screen.
- OpenCode multi-session tracking requires OpenCode v2.0+ with `opencode-plugin.mjs` configured.

## License

MIT
