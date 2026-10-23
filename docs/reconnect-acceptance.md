# Reconnect regression acceptance

## Result

**The previously reproduced 10-second lease false-idle failure is fixed in the
controlled real-host test.** This is not acceptance of natural network failures
or actual macOS sleep/wake. PR #2 remains Draft.

Environment: macOS, OpenCode 2.1.2, Herdr 0.9.5, Node.js 26.12.1.
All timestamps below are UTC (`Z`), copied from recorded observations.

## Contract investigation

The [V2 plugin API](https://opencode.ai/v2/docs/build/plugins) and the isolated
2.1.2 host's `/openapi.json` were checked against live calls:

| API | Observed scope and meaning |
|---|---|
| `ctx.session.list` | Unfiltered, paginated database-wide sessions, across projects/directories; not process ownership |
| `ctx.session.wait` | This process's foreground Agent loop, including retry/backoff; independent shells are excluded |
| `ctx.session.context` | Persisted shell messages identify their Shell ID and terminal status; missing messages do not establish completion |
| HTTP `/api/session/active` | Process-owned foreground drains only, represented as `running`; not exposed in Plugin Context |
| `ctx.event.subscribe` | Volatile in-process event stream without replay; plugin load location is not an event boundary |

While the primary process was genuinely running an Agent turn, a second process
sharing the isolated database listed that session but reported no active drain
and returned immediately from its own wait. The owning process still reported
the turn active. A separate probe created sessions in two temporary Git projects;
the unfiltered list contained both distinct project IDs:
`0686fbcef47ecebecaeab30a7cfbb913f8a9306b` and
`b62c93e81a39f8c59beb89bb1187fec7c6a586dd`.

## Agent Shell Tool: sleep 35, reconnect, and lost terminal events

The real TUI received a natural-language request to execute a foreground
`sleep 35` through the Agent's Shell Tool. This was **not** `!` shell mode or a
direct Shell API call.

- Session: `ses_e970bbeafffeH2No6grUB73Tz3`
- Server PID: `80599`; snapshot UUID: `b061dd08-f46b-4ff0-a058-af48e2813ef5`
- Real daemon PID: `85656`; caffeinate PID: `86179`; sleep PID: `86199`
- Actual tool ran: `2026-10-23T13:30:04.269Z`
- Actual tool completed: `2026-10-23T13:30:39.309Z`, exit `0` (35,040 ms)

A test-only adapter wrapped the real `ctx.event.subscribe`: it aborted the
upstream subscription and forwarded subsequent real events through the plugin's
normal reconnect path. It also deliberately dropped the real execution terminal
events to require API reconciliation. It did not synthesize events or edit snapshots.

| Observation | Timestamp | working | Same caffeinate PID | Actual sleep process |
|---|---|---|---|---|
| Baseline | `2026-10-23T13:29:43.443Z` | false | absent | absent |
| Before disconnect | `2026-10-23T13:30:06.729Z` | true | 86179 | 86199 |
| Abort requested | `2026-10-23T13:30:06.730Z` | true | 86179 | 86199 |
| Real resubscription | `2026-10-23T13:30:07.016Z` | — | — | — |
| More than 14 seconds after reconnect | `2026-10-23T13:30:21.774Z` | true | 86179 | 86199 |
| Last observed running sleep | `2026-10-23T13:30:38.960Z` | true | 86179 | 86199 |
| Completion reconciled despite dropped events | `2026-10-23T13:30:42.167Z` | false | absent | absent |

The monitor checked snapshots, actual OS processes, and `pmset -g assertions`
approximately once per second. There were 21 busy samples more than 10 seconds
after resubscription, all retaining the same caffeinate process. Busy samples
contained the actual session ID; the final snapshot had empty `sessions`.

Power-assertion excerpts at `2026-10-23T13:30:21.774Z`:

```text
86179 85656 caffeinate -i -s -w 85656
pid 86179(caffeinate): [0x0001eb320001853c] 00:00:21 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
    Details: caffeinate asserting on behalf of Process ID 85656
pid 86179(caffeinate): [0x0001eb320007853d] 00:00:21 PreventSystemSleep named: "caffeinate command-line tool"
    Details: caffeinate asserting on behalf of Process ID 85656
```

After completion, PID 86179 and both of its assertions were absent. The system-wide
`PreventSystemSleep` aggregate was **0**, even while the process-owned assertion
existed; this report does not claim effective system-sleep blocking on battery.
Preexisting `powerd` idle assertions remained and were not modified.

The daemon was the actual production daemon using the real Herdr CLI, scoped by
a wrapper to the isolated test workspace. This excluded daily-agent activity
from the idle observation; it was not a separate Herdr server or native plugin
installation test.

## Additional real-host regressions

- **Two processes, shared database:** primary PID 80599 and secondary PID 86886
  were active together at `2026-10-23T13:32:55.617Z`. Secondary session
  `ses_e97091823ffezucI3doowGmeb0` completed first; at
  `2026-10-23T13:33:02.216Z`, the primary Agent turn still kept `working=true`.
- **Independent Shell:** secondary session `ses_e97087e88ffeGj1XydnWGi4eqy`
  executed another real `sleep 35`. Its actual subscription was aborted and
  resubscribed. All 33 running samples retained Busy; both processes were idle
  by `2026-10-23T13:34:09.043Z` after the shell completed.
- **Crash:** secondary session `ses_e9707f315ffeaLveh4ngam6szy` was genuinely
  Busy at `2026-10-23T13:34:10.139Z`. After verifying the owned server's command,
  start time, directory, and port, the harness killed only that test process.
  At `2026-10-23T13:34:10.765Z`, the reader returned `working=false` despite
  the raw Busy snapshots remaining on disk. Crash files were archived as
  evidence, not automatically deleted by the reader.

## Automated regression and cleanup

The final **45 tests passed on both Node.js 18.20.8 and 26.12.1**. Coverage includes
10.5 seconds of real-clock silence after reconnect, API/stream failures and
recovery, lost idle events, paginated startup discovery, stale reply races,
independent parallel shells, retry/backoff, compaction event composition,
dead/stale snapshots, and Herdr OR OpenCode daemon behavior.

Only test-owned resources were stopped: both OpenCode servers, the TUI, daemon,
and caffeinate. Ports 49876/49877 were free and the snapshot directory empty.
The temporary access-only credential and authentication/run files were removed;
databases and evidence were preserved. The test workspace was closed and focus
returned to the original workspace. Main remained clean, daily service PID
24341 remained running, and global configuration was not modified.

Raw local artifacts are retained in the isolated acceptance directory under
`reports/`: `reconnect-fix-host.json`, `reconnect-fix-events.jsonl`,
`reconnect-fix-messages.json`, `reconnect-fix-scope.json`,
`reconnect-fix-project-scope.json`, and `reconnect-fix-cleanup.json`.
This document contains selected sanitized observations, not fabricated test output.

## Remaining risks / not verified

- Natural network failure, actual provider retry/backoff, actual compaction, and
  macOS sleep/wake were not exercised end-to-end. Retry and compaction semantics
  have automated event/API-model coverage only.
- Permanently unavailable status APIs plus lost terminal events conservatively
  retain Busy until recovery or process exit. No timeout can safely prove idle.
- Independent shells whose start and end are both missed cannot be discovered
  safely from cross-process historical messages. A known shell's message removed
  by compaction also cannot confirm completion; terminal events or process exit
  remain necessary in that case.
- Startup/reconnect scans database history; very large histories may need a
  future host-provided process-owned active API.
