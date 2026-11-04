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

## Requirements

- Linux/macOS, Node.js ≥ 20
- opencode ≥ 2.2 (shared background service; `--standalone` / remote
  `--server` modes are not supported)

## Development

```sh
npm install
npm run typecheck
npm test
node --import tsx scripts/fetch-spec.ts      # refresh OpenAPI snapshot
node --import tsx scripts/probe-synthetic.ts # verify runtime semantics
```

## Security notes

The daemon listens on 127.0.0.1 only, with random-port + random-password
service discovery (`$XDG_STATE_HOME/opencode-monitor-task/service.json`,
mode 600). Task notifications are wrapped in escaped envelopes; still, do not
monitor streams that untrusted parties can write to — monitored output is
delivered into your agent's context.

## License

[MIT](LICENSE)
