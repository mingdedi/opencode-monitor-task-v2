# opencode-monitor-task

Run long shell tasks alongside [opencode](https://opencode.ai) agents — the agent
gets woken up exactly when the output it cares about appears, not before, not after.

```
┌────────────────────┐   task commands    ┌──────────────────────────┐
│  opencode service  │ ─────────────────► │  monitor-task server     │
│  (thin plugin)     │ ◄───────────────── │  (independent daemon)    │
│                    │  HTTP synthetic    │  spawn / tail / filter / │
└────────────────────┘   notifications    │  coalesce / redeliver    │
                                        └──────────────────────────┘
```

**Status: early development.** Architecture: independent daemon process + thin
opencode plugin client. The daemon survives opencode restarts and plugin
hot-reloads; tasks run in their own process groups with file-based pipes
(`meta.json` / `log` / `exit`), so nothing is lost across restarts.

## Highlights

- **Reliable wake-ups**: regex pattern filtering, 500ms coalescing windows,
  token-bucket throttling (burst 5 + 1/s), event caps — a 30-line error storm
  becomes one notification.
- **Two-stage idle adjudication**: silent tasks don't get killed silently —
  the agent is asked (keepalive / stop), with a grace window as backstop.
- **Injection-safe envelopes**: monitored output cannot forge or terminate
  notification envelopes (entity-escaped tags).
- **Official API only**: all opencode interaction goes through documented
  HTTP endpoints (`POST /api/session/:id/synthetic`); see
  [docs/CONTRACT.md](docs/CONTRACT.md) for verified runtime semantics.
- **Crash-safe**: exit codes via EXIT-trap wrappers, pid+starttime identity,
  reattach-on-restart with digest summaries (never line-by-line replay).
- **TUI sidebar panel**: a thin display plugin (`tui.ts` → `src/tui/`) polls the
  daemon over HTTP (`MonitorClient.listTasks`) and renders per-session task
  rows — state icons, adjudication countdowns, exit codes, terminal-task
  folding; `server offline` / `unreachable` states included. Display-only by
  design: a dead panel never affects monitoring.

## Requirements

- Linux/macOS, Node.js ≥ 20
- opencode ≥ 2.2 (shared background service; `--standalone` / remote
  `--server` modes are not supported)

## Plugin tools (MCP)

The plugin registers three tools with the opencode host (server part entry
`index.ts`, registered via the official `ctx.tool.transform` contract). They
are thin wrappers over the daemon's HTTP API — the plugin itself carries no
business logic beyond daemon discovery/startup.

| Tool | Purpose |
|---|---|
| `monitor_server` | Discover or auto-start the daemon; reports health, reattach counts, and the opencode instance whitelist — the data source when you explicitly need cross-instance delivery. |
| `monitor` | Start a monitored task: `command` (required) plus optional `pattern`, `wake_mode`, `delivery`, `coalesce_ms`, `max_events`, `idle_timeout_ms`, `directory`, `description`, and destination overrides (below). |
| `monitor_manage` | Manage tasks: `list` (optional `session_id` filter), `status`, `stop`, `keepalive`, `update` (max_events), `read_log`, `delete`. |

Semantics worth knowing:

- **Auto-start**: every tool call runs discovery first (1s health probe) and
  spawns the daemon if needed — you never have to call `monitor_server`
  first; it stays useful for explicit diagnostics.
- **Notification destinations default to "here"**: `session_id` and
  `opencode_port` are optional. When omitted, the host-authoritative current
  session and the default shared opencode instance are used; pass them
  explicitly only for cross-instance / cross-session delivery (the daemon
  whitelist-checks and liveness-probes both either way).
- **Idle adjudication is a dialogue**: a silent task first gets *asked*
  (`keepalive` or `stop`?) with a grace window as backstop; the adjudication
  envelope names the exact `monitor_manage` call to make.
- **Errors are model-readable text**: expected failures (validation, daemon
  4xx, discovery diagnostics carrying pid / service.json / server.log paths)
  return `error: …` / `hint: …` instead of throwing; unexpected errors throw.

## Development

```sh
npm install
npm run typecheck
npm test
node --import tsx scripts/fetch-spec.ts      # refresh OpenAPI snapshot
node --import tsx scripts/probe-synthetic.ts # verify runtime semantics
node --import tsx scripts/verify-m6.ts       # TUI dataflow acceptance (M6)
node --import tsx scripts/verify-m7.ts       # plugin-tools acceptance (M7)
```

### Local install (development)

Until this is published, load the plugin from a checkout by symlinking it into
opencode's plugin discovery directory — one line, no script needed:

```sh
ln -sfn "$PWD" ~/.config/opencode/plugins/opencode-monitor-task
```

The host discovers both parts from the repo root (`index.ts` server part with
the MCP tools, `tui.ts` panel; see the TUI notes below). `-sfn` makes the
command idempotent — it also repoints an existing link after you move the
clone. Remove the link to uninstall; if tools misbehave after a refactor,
`ls -l` the link first — a stale target silently runs old code.

The TUI panel runs inside the opencode TUI process (plugin entry `tui.ts`,
discovered from `~/.config/opencode/plugins/` or `<project>/.opencode/plugins/`;
no dependencies to install — the host injects `@opentui/solid`'s jsx runtime).
Diagnostics go to `$XDG_STATE_HOME/opencode-monitor-task/tui.log` with
`DEBUG=1`.

## Security notes

The daemon listens on 127.0.0.1 only, with random-port + random-password
service discovery (`$XDG_STATE_HOME/opencode-monitor-task/service.json`,
mode 600). Task notifications are wrapped in escaped envelopes; still, do not
monitor streams that untrusted parties can write to — monitored output is
delivered into your agent's context.

## License

[MIT](LICENSE)
