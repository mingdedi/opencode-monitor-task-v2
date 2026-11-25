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
- **Self-hosted web dashboard**: the daemon serves a single-file dashboard at
  its own URL (`GET /`, same port, same auth) — task board with live counters
  and idle auto-stop countdowns, detail drawer with follow-mode log tail,
  stop/keepalive/delete/quota controls, a create form, and one-click jumps to
  the destination session in opencode web. Works in any browser tab alongside
  TUI / web / desktop; no opencode UI dependency (the web build never loads
  plugin GUIs). Sign in with `opencode service get password`.

## Requirements

- Linux/macOS, Node.js ≥ 20
- opencode ≥ 2.2 (shared background service; `--standalone` / remote
  `--server` modes are not supported)

**Field-tested** (Nov 2026) — full end-to-end pass on real machines: daemon
discovery/auto-start, command-injection validation, directory sandbox, port
whitelist, pattern filtering, coalescing, `max_events` cap (SIGTERM at cap),
two-stage idle adjudication, graceful stop,
`update`/`keepalive`/`read_log`/`delete`, and ordered loss-free delivery of
all queued notifications. Verified environments:

- **WSL2** — kernel `6.18.54.1-microsoft-standard-WSL2`, systemd enabled
- **Native Linux (remote Ubuntu servers)** — Ubuntu 26.04.1 LTS, kernel
  `7.0.0-42-generic`; Ubuntu 22.04.5 LTS, kernel `6.8.0-138-generic`

No environment-specific issues found on any of the above.

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
requires a `node_modules` to exist. This holds for the npm-installed
(bundle) form only; a symlink into a source checkout needs one-time setup,
see the caveat under "How the daemon is launched".

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

Caveat (verified on a fresh machine): the source form silently assumes the
repo's devDependencies are installed — `tsx` is resolved from `node_modules`,
and `resolveRuntime` version-checks node but never probes tsx. A source
symlink into a checkout with neither `dist/server.mjs` nor `node_modules/`
present therefore fails all paths: the daemon exits during startup (code 1)
before even creating its state directory, and all you see is a bare
`spawned server exited during startup` diagnostic. On a new machine, run
`npm install && npm run build` in the repo once — after that the bundle form
resolves and no `node_modules` is needed anymore.

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

## Web dashboard

The daemon hosts its own dashboard — open the daemon URL from
`$XDG_STATE_HOME/opencode-monitor-task/service.json` (the `url` field) in any
browser. Same port as the API, same Basic auth:

- **Username**: `monitor`
- **Password**: `opencode service get password` — any registered opencode
  instance's current password works (read live; rotation after an opencode
  restart is picked up automatically). The daemon's own `service.json`
  password remains valid too (that is what the plugin discovery channel uses).

**Credential equivalence is a real grant**: any accepted password unlocks the
full API — including task creation, i.e. command execution as your user in any
absolute directory (the plugin's workspace guard does not apply). Treat the
opencode password as shell-equivalent on the daemon host; if that is not what
you want, start the daemon with `--no-alt-passwords` to accept only its own
`service.json` password.

The browser shows its native sign-in dialog on first visit (the daemon sends
`WWW-Authenticate` on 401); afterwards same-origin API calls carry the cached
credentials automatically.

What you get:

- **Board**: all tasks across sessions with state-colored cards (the TUI icon
  set), description-first subjects, scan/hit/sent/drop counters, the idle
  grace (auto-stop) countdown, exit codes; filter by state or session,
  free-text search. Polls every second, paused while the tab is hidden.
- **Detail drawer**: full metadata, log tail (20–1000 lines, follow mode),
  and controls — stop / delete (two-click confirm), keepalive, `max_events`
  adjustment.
- **Create form**: the same parameters as the `monitor` tool; the destination
  instance is picked from the daemon's registry whitelist, `session_id` is
  entered manually (the server verifies it is live). Optional fields left
  empty fall through to server defaults.
- **Session jump**: ↗ opens the notification destination in opencode web
  (`{instance}/server/{base64(instance)}/session/{session_id}`).
- **Settings (⚙)**: language switch, English / 中文. Defaults to the browser
  language; the choice is stored in a cookie on the host (cookies ignore
  ports, so it survives daemon restarts and port changes). Parameter names
  (`command`, `max_events`, …) and raw API error text stay English by design.

Notes: creating a task here is equivalent to calling the API directly — the
plugin's workspace guard does not apply, and `directory` must be an absolute
path. Log tail is only available while the task record lives in the registry.
The dashboard is a pure client of the existing API (no extra endpoints) and
ships inside the single-file bundle; see
[ARCHITECTURE.md §15](docs/ARCHITECTURE.md) for design and security posture.

## Development

Documentation map: [ARCHITECTURE.md](docs/ARCHITECTURE.md) (system design),
[CONTRACT.md](docs/CONTRACT.md) (verified opencode HTTP API semantics),
[PLUGIN-CONTRACT.md](docs/PLUGIN-CONTRACT.md) (plugin host contract).

```sh
npm install
npm run typecheck
npm test
npm run build                              # esbuild bundle → dist/server.mjs
node --import tsx scripts/fetch-spec.ts      # refresh OpenAPI snapshot
node --import tsx scripts/probe-synthetic.ts # verify runtime semantics
node --import tsx scripts/verify-m1.ts       # discovery/spawn/race acceptance
node --import tsx scripts/verify-m2-pre.ts   # synthetic contract probe
node --import tsx scripts/verify-m2.ts       # minimal closed loop
node --import tsx scripts/verify-m4.ts       # idle adjudication + management
node --import tsx scripts/verify-m5.ts       # crash recovery / reattach
node --import tsx scripts/verify-m6.ts       # TUI dataflow acceptance
node --import tsx scripts/verify-m7.ts       # plugin-tools acceptance
node --import tsx scripts/verify-m8.ts       # permission audit acceptance
node --import tsx scripts/verify-ui.ts       # web dashboard acceptance (auth/link/control loop)
node --import tsx scripts/storm-sim.ts       # notification-storm simulation
node scripts/gen-ui.mjs                      # regenerate ui-html.ts after editing ui.html
```

All `verify-*` and `storm-sim` scripts resolve the server form the same way
the plugin does (`scripts/lib/server-entry.ts`): with `dist/server.mjs`
present they exercise the **bundle**, without it the **source** form — the release
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
mode 600). The web dashboard adds no endpoints beyond the API, but it does
widen the credential set: by default the live passwords of registered opencode
instances authenticate too (`opencode service get password` doubles as the
dashboard login — and as full API access, see the equivalence note above;
`--no-alt-passwords` opts out).

Because Basic auth credentials are ambient (the browser attaches cached
credentials to cross-site requests as well, and form navigations reach
loopback), the API enforces CSRF fences: POST/PATCH requests that carry a
`Content-Type` must use `application/json` (415 otherwise — form-encoded
bodies are rejected even when empty), and `Sec-Fetch-Site: cross-site`
state-changing requests are rejected (403). Direct API callers should send
`Content-Type: application/json` with JSON bodies (all first-party clients
do); a bare `curl -X POST` without the header still works for bodyless calls.
All responses carry `X-Content-Type-Options: nosniff`; the dashboard's CSP
pins its inline script by sha256 hash. See
[SECURITY-REVIEW-UI.md](docs/SECURITY-REVIEW-UI.md) for the full audit and
fix record.

Task notifications are wrapped in escaped envelopes; still, do not
monitor streams that untrusted parties can write to — monitored output is
delivered into your agent's context.

File-permission posture (audited by `scripts/verify-m8.ts`, both source and
bundle forms): state and data roots are 0700 (`~/.local/state/opencode-monitor-task/`,
`~/.local/share/opencode-monitor-task/`), `service.json` / lock / `meta.json`
/ task logs are 0600, and `meta.json` never contains credentials — the
opencode password is re-read from the live service.json on every delivery.
The daemon's own log is opt-in: it stays off by default (no file is
created) and is enabled at server start with `--debug` or `DEBUG=1` —
when on, it records ids, counters and errors, never command text.

Command validation (trailing `&`, `$(...)`, backticks, …) is a guard rail,
not a security boundary: the daemon intentionally runs arbitrary bash as
your user, exactly like the agent's own shell tool. The regex caveat above
is the same kind of boundary — read it before feeding it patterns you didn't
write.

## License

[MIT](LICENSE)
