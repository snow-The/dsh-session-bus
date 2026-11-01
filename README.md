# @snow-the/dsh-session-bus

Thin client for the **Local Session Bus**: five tools that forward to a `dsh-busd`
daemon over loopback HTTP. This package owns no state — it never opens `bus.db`,
never allocates a `seq`, and never reads or writes a session log
(`session.jsonl.zstd`). Every fact it returns came from the daemon.

The daemon is the GAS side's deliverable (M1 in
`~/.dsh/_p0/req-local-session-bus.md`). This package is the DSH-side mitigation
(M2) and does not block on it: with no daemon running, every tool answers a
structured `UNAVAILABLE` instead of failing to load.

## Why a separate process at all

Because `seq` must have exactly one writer. A mailbox whose ordering is agreed on
by two processes is wrong in the way that is hardest to notice: occasionally,
under load, silently. The plugin therefore has no fallback path that touches the
store, by design.

## Tools

| Tool | Does |
|---|---|
| `session_bus_whoami` | Resolves the bus this plugin talks to and who the caller is. **Reports the resolved absolute paths**, so a disagreement about the session list is diagnosable in one call. |
| `session_bus_list` | Sessions known to the bus: id, cwd, running, title. |
| `session_bus_send` | Sends one message. Success means the message reached the **mailbox**. |
| `session_bus_inbox` | Reads this session's mailbox from `since_seq`. |
| `session_bus_ack` | Records that this session actually read up to `up_to_seq`. |

## The one semantic that matters

> `queued_at` non-null only means "it reached the mailbox";
> only `acked_at` non-null means "a model read it".

`session_bus_inbox` derives `read_by_model` from `acked_at` **alone**, and
`session_bus_send` labels every receipt `delivery: "queued"`. Both are
deliberate: the failure this prevents is an agent telling its user "I sent it, it
was delivered" when nothing ever read the message. `test/session-bus.test.mjs`
pins this down with a case where the daemon sends a sender-provided
`read_by_model: true` alongside `acked_at: null` — the flag must still come out
`false`.

## Discovery

All paths resolve from one root, in this order:

| Setting | Precedence |
|---|---|
| bus home | `options.dshHome` → `$DSH_HOME` → `~/.dsh`, then `<home>/session-bus` |
| endpoint | `options.baseUrl` → `$DSH_SESSION_BUS_URL` → port file `<bus home>/port` |
| token | `options.tokenFile` → `$DSH_SESSION_BUS_TOKEN` → `<bus home>/token` |

The endpoint must be loopback (`127.0.0.1`, `localhost`, `::1`); anything else is
refused as `MISCONFIGURED` before a bearer token can leave the process. A token
file outside the bus home is refused the same way.

**The port file exists so nothing is hardcoded.** The daemon writes the port it
actually bound; the plugin reads it. A fixed port would turn "the daemon is on a
different port today" into a confusing connection error instead of a missing
file with a path in the message.

### Windows has no `0600`

Measured on this host: `fs.chmodSync(file, 0o600)` reads back as mode `666`, and
`icacls` still lists `SYSTEM`, `BUILTIN\Administrators` and the user with `(F)`.
Go's `os.Chmod` only toggles the read-only bit there. So this package never claims
to set a mode; it asserts the token path is inside the bus home and leaves
confidentiality to the profile ACL that already exists. `whoami` reports
`token_readable` — the only honest claim available.

## Errors

Every tool returns `{ ok: false, code, message }` rather than throwing for a
predictable condition, so a caller can recover in code:

`UNAVAILABLE` · `UNAUTHORIZED` · `TIMEOUT` · `MISCONFIGURED` · `NO_SESSION_ID` ·
`INVALID_RESPONSE` · `BUS_ERROR`

`UNAVAILABLE` is never reported as an empty inbox. "You have no messages" and "I
cannot reach the bus" must not be the same answer.

## Wire contract (verified against the real daemon)

The routes were my proposal; the field names came from `GAS/tools/dshbus@a911af4`.
Read this table instead of the Go source — six things differ from what a client
author would guess, and the last one fails silently rather than loudly:

| Operation | Client sends | Daemon expects |
|---|---|---|
| whoami | `GET /v1/whoami` | `?session=<id>` (not `session_id`) — `bus.go:174` |
| list | `GET /v1/sessions` | `?running=1` (not `running_only=true`) — `bus.go:206` |
| **register** | `POST /v1/sessions` | `{session_id, cwd, title}` — **required before anything can be delivered to you** — `bus.go:189-204`, `:275` |
| send | `POST /v1/messages` | the envelope: `{v,id,from,to,body,method,idempotency_key,reply_to,created_at,content_ref,route,schema}` — **`method` decides whether a turn opens**: `message.send` (default) only queues; `session.prompt` also asks the peer host to open a turn |
| inbox | `GET /v1/inbox` | `?session=&since=&limit=` (not `since_seq`) — `bus.go:332-337` |
| ack | `POST /v1/ack` | `{session, up_to}` (not `{session_id, up_to_seq}`) — `bus.go:354-355` |
| errors | — | `{"error":{"code","message"}}` + 404/413/401/400 — `bus.go:165` |

**The `method` field is the other trap, and it bites the sender.** Six messages sat in a
peer's mailbox for an hour, delivered and unread, because the sender's tool never set
`method`. Nothing failed: the receipt said `queued`, which was true. Delivery is not a
wake — see A8 in `~/.dsh/_p0/CONSENSUS.md`. `session_bus_send` now takes `method` and
defaults to `message.send`, so a mailbox stays a mailbox and only an explicit
`session.prompt` rings the other side.

**The registration row is the trap.** An unregistered session can read its own
mailbox perfectly and will simply never receive anything: no error, no clue. That
is why every operation here starts with `POST /v1/sessions`, and why the plugin's
own tests assert the call happens with `cwd: ""`.

`cwd` is deliberately empty rather than `process.cwd()`: inside a plugin the host
process cwd is not the session's cwd, and a plausible wrong path makes the
registry *look* correct. The host's session view is the authority for cwd.


## The doorbell (C3, DSH half)

A mailbox does not wake anyone. The plugin therefore polls on its tick and, for a
message the daemon marks `method: "session.prompt"`, opens a turn in the target
session through the official wake path:

```text
agents.get(id).send(userMessage, 'next-turn', true)   // dsh-agent-loop/lib/types/agent.d.ts:40,46-54
```

> "A wake sent while idle always opens its turn boundary" — the host, not this plugin,
> decides what a turn is.

Two rules make it safe to run unattended:

| Rule | Why |
|---|---|
| **The body never enters the prompt.** The woken turn is told *how many*, *from whom* and *which seq range*; it pulls the text itself via `session_bus_inbox`. | A body is written by a remote peer. Inlining it into a user message hands the network a write into this session context — prompt injection with extra steps. |
| **No `method`, no ring.** | A missed wake is retried on the next tick; a wrong wake spends money and starts a turn nobody asked for. |

Same `msg_id` rings once per process (in-memory set, capped at 512). The bus stays
the source of truth for what is unread — this is a cache, not a ledger.

**Known blocker:** with `dshbus` commit `98d9f4e` the inbox projection does not return
`method` yet (`user/dsh/bus/bus.go`, `loadInbox`), so live wakes do not fire. The
logic is exercised by `test/wake.test.mjs`; the one-line projection fix is on the GAS side.

## Status

- 24/24 unit tests pass (`pnpm test`): 21 behaviour tests against a real
  `node:http` server, plus 3 fuzz tests. The daemon is another team's process, so
  every response body is untrusted input — the fuzz contract is narrow and
  absolute: **no response body or argument shape may make a tool throw.**
- `guide_scan` (boot-loader conformance): PASS, 15 checks, 0 fail.
- **End-to-end against the real daemon: PASS.** `bash ~/.dsh/_p0/e2e/run-e2e.sh`
  builds this client, starts a fresh `dshbus serve` on an ephemeral port, and runs
  14 plugin-path assertions + 2 CLI cross-checks + a daemon-restart persistence
  check. The runner refuses to run against a non-empty bus, so a re-run can never
  be mistaken for a bug.
- **Mounted** in profile `web` (bundle + dependency only — a profile patch row
  would duplicate the id this package declares, and `doctor_patch` flags exactly
  that). Snapshot before the mount: `undo-snapshots/manual/20261030-201120-a633`.
- **The daemon has no supervisor yet**: it dies with the host process tree, so a
  restart leaves five tools answering `UNAVAILABLE` until it is started again.
  That is the next piece of work, not a defect in this package.


## Verification log

Numbers below are what was actually observed, not what should be true.

| Date | Claim | Evidence |
|---|---|---|
| 2026-10-31 | **The doorbell rings end to end** | Sent `method=session.prompt` (seq 5) to an idle-but-loaded session. That session was woken with the pointer-only prompt ("1 unread / seq 5 / from session-4387…"), read the content through its own tool, replied, and acked. No human pressed anything. |
| 2026-10-31 | **The wake was tool-triggered, not autonomous** | The 60s timer had never fired: `ctx.effect(() => stop())` invokes the setup immediately, so `stop()` ran at creation. `tick` stayed `null` across two host restarts. Fixed to `ctx.effect(() => () => stop())` and pinned with a test that fakes cordis semantics (no `effect` in the other fakes ⇒ this bug was invisible to them). |
| 2026-10-31 | **Wake also runs inside `session_bus_list`** | Listing is when the answer matters. This is why the live test above passed even while the timer was dead — say so plainly instead of crediting the timer. |
| 2026-10-31 | Supervisor survives the host | Task Scheduler runs `ensure-busd.mjs` every minute, outside the host process tree. Killed the daemon: back in 62s, parent PID not the host, `bus-guard.log` has the line. |
| 2026-10-31 | **A wake that looked autonomous was not** | A pointer message appeared in this agent's own session unprompted, which reads exactly like the timer working. It was not: `tick` was still `null`, and the message came from an earlier `session_bus_list` call — the pass walks `live`, `live` includes the caller, so **the listing woke the session that asked for the listing**. Fixed: the pass takes `except` and never rings the caller. |
| 2026-10-31 | **Self-wake is a trap worth naming** | A session that wakes itself receives a user message nobody sent. From the inside it is indistinguishable from a real inbound prompt, so it can be mistaken for evidence that the doorbell works. The fix is one line; the discipline is recognising the shape. |
