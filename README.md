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

## Installation

The daemon ships as a single self-contained bundle (`dist/server.mjs`, built
with esbuild — the `@opencode-ai/sdk` client and all workspace sources are
packed in), so the published package has no runtime dependencies beyond a
Node.js ≥ 20 executable. The plugin entry files (`index.ts` / `tui.ts` and
their TypeScript sources) are consumed directly by the opencode host, which
transpiles TypeScript itself.

```sh
npm install -g opencode-monitor-task
ln -sfn "$(npm root -g)/opencode-monitor-task" ~/.config/opencode/plugins/opencode-monitor-task
```

The host discovers both parts from the package root (the `index.ts` server
part with the MCP tools, the `tui.ts` panel). Remove the symlink to
uninstall; re-run the `ln -sfn` line after upgrading to repoint the link.
No `npm install` step is needed inside the plugin directory — nothing there
requires a `node_modules` to exist.

### How the daemon is launched

Every tool call runs daemon discovery first (1s health probe against
`$XDG_STATE_HOME/opencode-monitor-task/service.json`) and starts one if
needed. The launcher (`resolveRuntime` in `packages/plugin/src/runtime.ts`)
never assumes the host process is Node — the opencode CLI is a bun-compiled
binary — and instead resolves, in order:

1. `OMT_SERVER_BIN` — a full server command, trusted as-is (CI/diagnostics)
2. `OMT_NODE` — a specific node executable (still version-checked, ≥ 20)
3. `node` on `PATH` — combined with the server form found in the package:
   `dist/server.mjs` (bundle, published form) if present, otherwise
   `packages/server/src/main.ts` via tsx (source, development form)

If all of that fails you get a structured diagnostic listing every attempt
plus the host's `PATH` verbatim — the single most useful piece of information
when node lives in an fnm/nvm multishell path that a non-shell host didn't
inherit. The daemon is never started at plugin load: on-demand is the only
lifecycle.

### A note on pattern regexes (catastrophic backtracking)

The `pattern` you pass to `monitor` is compiled and executed **synchronously
on the daemon's event loop** against every scanned line (up to 2000 chars
after cleaning). That is deliberate — it keeps matching deterministic and
the output pipeline simple — and it is also the one input that can stall the
*entire daemon*, not just your task: a pathological regex such as
`(a+)+$`, `(a|aa)+$`, or deeply nested quantifiers over overlapping
alternations can exhibit exponential backtracking on modest inputs, freezing
notification delivery, HTTP handling, and the idle adjudication of every
other task the daemon watches.

This is documented rather than mechanically prevented: rejected-regex
subsets (RE2-style) would refuse many legitimate patterns, and per-line
match timeouts would add worker machinery out of proportion to the threat.
Within the threat model an agent only starves itself — the daemon runs as
your user, same as the agent's own shell tool — but the blast radius is
*all tasks on that daemon*, so:

- keep patterns anchored and specific; prefer a few alternations of literals
  over nested quantifiers;
- never build patterns from untrusted input;
- if a monitor task makes the daemon unresponsive, `kill` the daemon
  (`pkill -f 'dist/server.mjs'` or the pid from service.json) — task
  processes keep running in their own groups and get re-attached when the
  daemon restarts.

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
npm run build                              # esbuild bundle → dist/server.mjs
node --import tsx scripts/fetch-spec.ts      # refresh OpenAPI snapshot
node --import tsx scripts/probe-synthetic.ts # verify runtime semantics
node --import tsx scripts/verify-m1.ts       # discovery/spawn/race acceptance (M1)
node --import tsx scripts/verify-m2-pre.ts   # synthetic contract probe (M2-pre)
node --import tsx scripts/verify-m2.ts       # minimal closed loop (M2)
node --import tsx scripts/verify-m4.ts       # idle adjudication + management (M4)
node --import tsx scripts/verify-m5.ts       # crash recovery / reattach (M5)
node --import tsx scripts/verify-m6.ts       # TUI dataflow acceptance (M6)
node --import tsx scripts/verify-m7.ts       # plugin-tools acceptance (M7)
node --import tsx scripts/verify-m8.ts       # permission audit acceptance (M8)
node --import tsx scripts/storm-sim.ts       # notification-storm simulation (M3 payload)
```

All `verify-*` and `storm-sim` scripts resolve the server form the same way
the plugin does (`scripts/lib/server-entry.ts`): with `dist/server.mjs`
present they exercise the **bundle**, without it the **source** form — the M8
gate requires the full set green in both forms (same criteria, zero drift).

### Local install (development)

To load the plugin from a checkout instead of the published package,
symlink it into opencode's plugin discovery directory — one line, no script
needed:

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

File-permission posture (audited by `scripts/verify-m8.ts`, both source and
bundle forms): state and data roots are 0700 (`~/.local/state/opencode-monitor-task/`,
`~/.local/share/opencode-monitor-task/`), `service.json` / lock / `meta.json`
/ task logs are 0600, and `meta.json` never contains credentials — the
opencode password is re-read from the live service.json on every delivery.
The daemon's own log records ids, counters and errors, never command text.

Command validation (trailing `&`, `$(...)`, backticks, …) is a guard rail,
not a security boundary: the daemon intentionally runs arbitrary bash as
your user, exactly like the agent's own shell tool. The regex caveat above
is the same kind of boundary — read it before feeding it patterns you didn't
write.

## License

[MIT](LICENSE)
