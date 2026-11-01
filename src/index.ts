/**
 * dsh-session-bus — the thin client for the Local Session Bus (`dsh-busd`).
 *
 * Design rules. Each one exists because its opposite already cost us something:
 *
 *  1. THIN. This plugin owns no state. It never opens `bus.db`, never allocates a
 *     seq, never reads or writes a session log. Every fact it returns came from
 *     `dsh-busd` over loopback HTTP. A second owner of the mailbox would have to
 *     agree with the first on ordering, and `seq` is exactly the kind of number
 *     that two writers get subtly wrong instead of loudly wrong.
 *
 *  2. ZERO runtime dependencies (node builtins only). Compiling against a dsh
 *     package means pinning a version, and a `file:` dependency is hardlinked
 *     into the profile — "rebuild dist" then writes straight into production.
 *     Not importing anything keeps that whole problem out of this package.
 *
 *  3. FAIL EXPLICITLY. When the daemon is not running the tools answer a
 *     structured `UNAVAILABLE`, never a throw for a predictable condition and
 *     never an empty success. "You have no messages" and "I cannot reach the
 *     bus" must not be the same answer: the first invites the model to conclude
 *     nobody wrote to it, which is a lie worth avoiding at any cost.
 *
 *  4. DELIVERY SEMANTICS ARE LOAD-BEARING. Both sides agreed on one sentence:
 *
 *       queued_at non-null only means "it reached the mailbox";
 *                       only acked_at non-null means "a model read it".
 *
 *     `read_by_model` is therefore derived from `acked_at` ALONE. Do not
 *     "improve" it by inferring a read from `queued_at`, and do not let a
 *     renderer phrase a queued message as delivered.
 *
 *  5. WINDOWS HAS NO 0600. Measured on this host: `fs.chmodSync(file, 0o600)`
 *     reads back as mode 666 and `icacls` still lists SYSTEM, Administrators and
 *     the user with (F). Go's `os.Chmod` only toggles the read-only bit there.
 *     So this plugin never claims to set a mode: it asserts that the token path
 *     resolves INSIDE the bus home, and leaves confidentiality to the profile
 *     ACL that already exists. Claiming a permission we did not set is worse
 *     than having none, because the next reader stops checking.
 *
 * The HTTP surface below is PROPOSED: `dsh-busd` belongs to the GAS side, and
 * M1 is theirs. The five route constants live in one object so a rename is a
 * one-line change here and not a grep across the package.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export const name = 'session-bus'
export const inject = ['tools']

/** Contractual body ceiling; the daemon is the authority, this is an early mirror. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Wire contract, taken from `GAS/tools/dshbus` commit `a911af4` — not guessed.
 * The daemon's own constants win over my proposal, and the four places where
 * they differ are exactly where a fake client would break:
 *
 *   - query key is `session`, not `session_id`      (bus.go:174, :332)
 *   - list filter is `running=1`, not `running_only` (bus.go:206)
 *   - inbox paging is `since`, not `since_seq`      (bus.go:336)
 *   - ack body is `{session, up_to}`, not `{session_id, up_to_seq}` (bus.go:354)
 *
 * Errors arrive as `{"error":{"code","message"}}` (bus.go:165), not `{code}`.
 */
const ROUTES = {
  whoami: '/v1/whoami',
  /** GET lists sessions; POST is the registration/heartbeat that `send` requires. */
  sessions: '/v1/sessions',
  messages: '/v1/messages',
  inbox: '/v1/inbox',
  ack: '/v1/ack',
  rooms: '/v1/rooms',
} as const

/** Room paths are parameterised, so they are builders rather than table entries. */
const roomPath = (room: string, suffix = ''): string => `/v1/rooms/${encodeURIComponent(room)}${suffix}`

/**
 * Server-side codes worth passing through verbatim: the caller can act on each.
 *
 * `NO_GRANT` is here because it was missing and that produced a real misreport:
 * the daemon answers `403 NO_GRANT` when the *target* has not granted the sender
 * that method, and this client collapsed it into "your bearer token is wrong,
 * re-read <token file>". The operator then re-reads a token that was never the
 * problem — the same wrong-answer-that-looks-authoritative failure that adding
 * NOT_MEMBER was meant to end. A 403 cannot tell the two apart; only the
 * daemon's own code can, so it has to survive.
 */
const PASSTHROUGH_CODES = new Set(['INVALID_ENVELOPE', 'NEED_CONTENT_REF', 'UNKNOWN_SESSION', 'UNAUTHORIZED', 'NO_GRANT', 'ROOM_NOT_FOUND', 'NOT_MEMBER'])

const DEFAULT_TIMEOUT_MS = 5_000
const SEND_TIMEOUT_MS = 15_000

// --- minimal DSH tool surface (kept local: no dsh package imports) ---
type Json = null | boolean | number | string | Json[] | { [k: string]: Json | undefined }

interface Tool {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, Json>; required?: string[] }
  output: {
    schema: Json
    render: (args: Json, value: Json) => { type: 'text'; text: string }[]
  }
  timeoutMs?: number
  isConcurrencySafe?: () => boolean
  execute: (args: Json, exec: unknown) => Promise<Json>
}

interface Ctx {
  tools: { register: (tool: Tool) => void }
  /** Inject-free official service read; a direct property read throws without `inject`. */
  get?: (name: string) => unknown
  /** Register a callback against a child scope that HAS the named services. */
  inject?: (deps: string[], callback: (scope: unknown) => unknown) => unknown
  effect?: (fn: () => void) => unknown
  on?: (event: 'dispose', fn: () => void) => unknown
}

/** Configuration is optional everywhere: defaults are the live-host layout. */
export interface BusOptions {
  /** Overrides `$DSH_HOME` and `~/.dsh`. */
  dshHome?: string
  /** Overrides the port file entirely, e.g. `http://127.0.0.1:7331`. */
  baseUrl?: string
  /** Refresh interval for the registry/wake tick. Tests use it to avoid waiting a minute. */
  heartbeatMs?: number
  /** Overrides `<bus home>/token`. */
  tokenFile?: string
  timeoutMs?: number
}

type BusErrorCode =
  | 'UNAVAILABLE'
  | 'UNAUTHORIZED'
  | 'TIMEOUT'
  | 'MISCONFIGURED'
  | 'NO_SESSION_ID'
  | 'INVALID_RESPONSE'
  | 'BUS_ERROR'
  // Passed through from the daemon: each one tells the caller to do something
  // different, so collapsing them into BUS_ERROR would throw away the recovery.
  | 'INVALID_ENVELOPE'
  | 'NEED_CONTENT_REF'
  | 'UNKNOWN_SESSION'
  // Rooms. NOT_MEMBER is 403 for a reason (bus.go): the room exists and the
  // daemon knows which room you asked about — you are simply not in it. Folding
  // that into UNAUTHORIZED sends the caller to re-read a token file for a problem
  // that has nothing to do with tokens.
  | 'ROOM_NOT_FOUND'
  | 'NOT_MEMBER'
  // Grant. NO_GRANT is 403 too, and it is **not** a token problem: the sender's
  // identity is fine, the target simply never granted it this method. The
  // recovery is "ask the target to grant it" or "send without declaring a
  // method" — never "re-read the token file".
  | 'NO_GRANT'

type BusOk = { ok: true; status: number; body: Json }
type BusFail = { ok: false; code: BusErrorCode; message: string; details?: Json }
type BusOutcome = BusOk | BusFail

const fail = (code: BusErrorCode, message: string, details?: Json): BusFail => ({ code, message, ok: false, ...(details === undefined ? {} : { details }) })

const textOutput = (): Tool['output'] => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
})

/** The calling session's identity comes from the official handle, not from parsing logs. */
function sessionIdOf(exec: unknown): string | undefined {
  const agent = (exec as { agent?: { id?: unknown } } | null | undefined)?.agent
  const id = agent?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** Absorbed bus environment for one tool call. */
interface BusEnv {
  dshHome: string
  busDir: string
  tokenFile: string
  baseUrl: string
}

/**
 * Resolve the bus environment without guessing.
 *
 * Precedence is explicit-config > env > conventional layout, and `whoami`
 * reports every resolved absolute path back to the caller: when the session
 * list disagrees with the host's own view, the first question is whether both
 * sides are looking at the same directory, and that question must be answerable
 * without reading this source.
 */
function resolveEnv(options: BusOptions | undefined): BusEnv | BusFail {
  const pickString = (...candidates: unknown[]): string | undefined => {
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    }
    return undefined
  }

  const dshHome = resolve(pickString(options?.dshHome, process.env.DSH_HOME) ?? join(homedir(), '.dsh'))
  const busDir = join(dshHome, 'session-bus')
  const tokenFile = resolve(pickString(options?.tokenFile, process.env.DSH_SESSION_BUS_TOKEN) ?? join(busDir, 'token'))

  // A token outside the bus home is not a security bug we can fix here — it is a
  // configuration mistake that must not be silently honoured.
  if (tokenFile !== busDir && !tokenFile.startsWith(busDir + sep)) {
    return fail('MISCONFIGURED', `token file must live inside the bus home: ${tokenFile} is not under ${busDir}`)
  }

  const explicitUrl = pickString(options?.baseUrl, process.env.DSH_SESSION_BUS_URL)
  let baseUrl: string
  if (explicitUrl !== undefined) {
    baseUrl = explicitUrl.replace(/\/+$/, '')
  } else {
    const portFile = join(busDir, 'port')
    let raw: string
    try {
      raw = readFileSync(portFile, 'utf8').trim()
    } catch {
      return fail('UNAVAILABLE', `session bus daemon is not running: no port file at ${portFile}`)
    }
    const port = Number.parseInt(raw, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return fail('MISCONFIGURED', `port file ${portFile} does not contain a usable port: ${JSON.stringify(raw.slice(0, 40))}`)
    }
    baseUrl = `http://127.0.0.1:${port}`
  }

  // v1 is loopback-only by contract. A non-loopback URL means a different trust
  // model, so it is refused here rather than silently sending a bearer token out.
  let host: string
  try {
    host = new URL(baseUrl).hostname
  } catch {
    return fail('MISCONFIGURED', `session bus URL is not a valid URL: ${baseUrl}`)
  }
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
    return fail('MISCONFIGURED', `session bus must be loopback-only in v1, got host ${JSON.stringify(host)} (${baseUrl})`)
  }

  return { baseUrl, busDir, dshHome, tokenFile }
}

function readToken(env: BusEnv): string | BusFail {
  try {
    const token = readFileSync(env.tokenFile, 'utf8').trim()
    if (token === '') return fail('UNAUTHORIZED', `token file ${env.tokenFile} is empty`)
    return token
  } catch {
    return fail('UNAVAILABLE', `session bus token is missing: ${env.tokenFile}`)
  }
}

/** One HTTP round trip. Every predictable failure becomes a code, never a throw. */
async function call(
  env: BusEnv,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  query: Record<string, string | number | undefined>,
  payload: Json | undefined,
  timeoutMs: number,
): Promise<BusOutcome> {
  const url = new URL(env.baseUrl + path)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
  }

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const name0 = (error as { name?: string } | null)?.name ?? ''
    if (name0 === 'TimeoutError' || name0 === 'AbortError') {
      return fail('TIMEOUT', `session bus did not answer ${method} ${path} within ${timeoutMs}ms at ${env.baseUrl}`)
    }
    const cause = (error as { cause?: { code?: string } } | null)?.cause?.code
    return fail(
      'UNAVAILABLE',
      `cannot reach the session bus at ${env.baseUrl} (${cause ?? (name0 === '' ? 'fetch failed' : name0)}); is dsh-busd running?`,
    )
  }

  const text = await response.text()
  let body: Json = null
  if (text !== '') {
    try {
      body = JSON.parse(text) as Json
    } catch {
      return fail('INVALID_RESPONSE', `session bus returned non-JSON (${response.status}) from ${path}`, {
        preview: text.slice(0, 200),
      })
    }
  }

  // The daemon nests its code one level down: {"error":{"code","message"}}.
  const serverCode = (body as { error?: { code?: unknown } } | null)?.error?.code
  const serverMessage = (body as { error?: { message?: unknown } } | null)?.error?.message
  const detail = typeof serverMessage === 'string' && serverMessage !== '' ? serverMessage : text.slice(0, 200)
  const recognised = typeof serverCode === 'string' && PASSTHROUGH_CODES.has(serverCode)

  if (response.status === 401 || response.status === 403) {
    // 403 carries TWO meanings: "your token is wrong" and "you are not in this
    // room". Only the daemon's code can tell them apart, so a recognised code
    // outranks the status. Collapsing both into UNAUTHORIZED (which this client
    // did until rooms existed) points the caller at the token file for a
    // membership problem — a wrong answer that looks authoritative.
    if (recognised && serverCode !== 'UNAUTHORIZED') {
      return fail(serverCode as BusErrorCode, `${serverCode} (HTTP ${response.status}) at ${path}: ${detail}`, { body, status: response.status })
    }
    return fail('UNAUTHORIZED', `session bus rejected the bearer token (${response.status}); re-read ${env.tokenFile}`, { status: response.status })
  }
  if (!response.ok) {
    if (recognised) {
      return fail(serverCode as BusErrorCode, `${serverCode} (HTTP ${response.status}) at ${path}: ${detail}`, { body, status: response.status })
    }
    return fail('BUS_ERROR', `session bus answered ${response.status} at ${path}: ${typeof serverCode === 'string' ? serverCode : detail}`, {
      body,
      status: response.status,
    })
  }
  return { body, ok: true, status: response.status }
}

/**
 * The ONE registration body. Both registration sites (self-heartbeat and the
 * host-view publisher) go through it, because the last time this body was written
 * twice the two copies disagreed on `alive`.
 */
const registrationBody = (sessionId: string, cwd: string): Json => ({ alive: true, cwd, session_id: sessionId })

/**
 * Registration is not optional. The daemon refuses to deliver to a session it
 * has never seen — `send` answers UNKNOWN_SESSION for an unregistered target
 * (`bus.go:275`) — so a client that skips this can read its own mailbox but can
 * never receive anything. `POST /v1/sessions` is that registry write plus the
 * heartbeat that decides `running` (`isRunning(hb)`), and it is additive on the
 * wire: the GAS side added it after the five routes I proposed.
 *
 * `cwd` is deliberately empty. From inside a plugin, the host process cwd is not
 * the session's cwd, and a plausible wrong path is worse than none: a wrong cwd
 * makes the registry look correct. The host's own session view is the authority
 * for cwd, and `session_bus_list` says so rather than guessing.
 */
async function heartbeat(env: BusEnv, token: string, sessionId: string, timeoutMs: number): Promise<BusFail | undefined> {
  const outcome = await call(env, token, 'POST', ROUTES.sessions, {}, registrationBody(sessionId, ''), timeoutMs)
  return isFail(outcome) ? outcome : undefined
}

/** Shared preamble: resolve the environment, read the token, identify and register the caller. */
async function prepare(
  options: BusOptions | undefined,
  exec: unknown,
  timeoutMs: number,
): Promise<{ env: BusEnv; token: string; sessionId: string } | BusFail> {
  const env = resolveEnv(options)
  if ('ok' in env) return env
  const token = readToken(env)
  if (typeof token !== 'string') return token
  const sessionId = sessionIdOf(exec)
  if (sessionId === undefined) {
    return fail('NO_SESSION_ID', 'this tool call carries no session identity (exec.agent.id is absent), so the bus cannot address the caller')
  }
  const registered = await heartbeat(env, token, sessionId, timeoutMs)
  if (registered !== undefined) return registered
  return { env, sessionId, token }
}

const isFail = (value: unknown): value is BusFail => typeof value === 'object' && value !== null && (value as BusFail).ok === false

/** Read an official service without declaring `inject` (cordis's proxy throws on direct reads). */
function readService(ctx: unknown, name: string): unknown {
  const read = (ctx as { get?: (service: string) => unknown } | null | undefined)?.get
  if (typeof read !== 'function') return undefined
  try {
    return read.call(ctx, name)
  } catch {
    return undefined
  }
}

interface SessionHeaderLike {
  id?: unknown
  sessionId?: unknown
  cwd?: unknown
}

/**
 * The persisted snapshot is NOT the header: official type is
 * `{ header: SessionHeader, revision, eventCount?, sizeBytes? }`
 * (`dsh-session-persistence/lib/types/index.d.ts:22-33`). Reading `snapshot.id`
 * yields undefined for every row, which looks exactly like "nothing is live".
 * Tolerate both shapes: the flat one costs nothing and survives a wrapper change.
 */
interface SnapshotLike extends SessionHeaderLike {
  header?: SessionHeaderLike
}
interface AgentsLike {
  get?: (id: string) => {
    session?: { header?: { cwd?: unknown } }
    /** Official wake path: "A wake sent while idle always opens its turn boundary" (dsh-agent-loop/lib/types/agent.d.ts:40,46-54). */
    send?: (message: unknown, target: 'next-turn' | 'next-step', wakeup: boolean) => void
    /**
     * `'idle' | 'running'` on the live Agent (dsh-agent `AgentStatus`, runtime-types.d.ts:90).
     * Read it before ringing: a wake aimed at a running session lands as a `role:'user'`
     * message **inside the turn someone is already in** — which is how a notification
     * ends up competing with what a human is typing. Absent on older builds/fakes,
     * and then we keep the old behaviour rather than skipping every ring.
     */
    status?: unknown
  } | undefined
}
interface PersistenceLike {
  list?: (options?: unknown) => Promise<unknown> | unknown
}

/** The two host services that together answer "who is on this machine, and who is alive". */
interface HostView {
  /** Narrowed: `asHostView` only returns a view when both members passed a typeof check. */
  agents: { get: NonNullable<AgentsLike['get']> }
  persistence: { list: NonNullable<PersistenceLike['list']> }
}

const HEARTBEAT_MS = 60_000
const HEARTBEAT_BATCH = 64

/**
 * Resolve the host view from any scope, trying BOTH mechanisms.
 *
 * `ctx.get(name)` is the inject-free official read; `ctx.inject([...], cb)` yields
 * a child scope that carries the services properly. Which one works is a host
 * detail I was already wrong about once — the first live run reported
 * `published: 0` and there was no way to tell why. So `session_bus_list` now
 * reports which mechanism produced the view, and the failure that used to be
 * silent is a field.
 */
function asHostView(scope: unknown): HostView | undefined {
  const persistence = readService(scope, 'sessionPersistence') as PersistenceLike | undefined
  const agents = readService(scope, 'agents') as AgentsLike | undefined
  // Keep the SERVICE objects, never a detached copy of their methods.
  // Measured the hard way: `{ list: persistence.list }` compiles, passes a typeof
  // check, and then throws "Cannot read properties of undefined (reading
  // 'pendingEntries')" on first call, because list() reads this.<state>. A method
  // that escapes its receiver is not the same function.
  return typeof persistence?.list === 'function' && typeof agents?.get === 'function'
    ? { agents: agents as HostView['agents'], persistence: persistence as HostView['persistence'] }
    : undefined
}

/** What the publish attempt actually managed to do. Never a bare number: a number cannot explain itself. */
interface Publication {
  /** Index signature so this object can cross the tool JSON boundary unchanged. */
  [key: string]: Json | undefined
  /** `direct` = ctx.get worked, `inject` = child scope, `none` = neither. */
  via: 'direct' | 'inject' | 'none'
  host_view: boolean
  headers: number
  published: number
  /** Rows whose id could be read (a 0 here means the snapshot shape is wrong, not that nothing is live). */
  with_id: number
  no_id: number
  /** Rows with an id but no live agent — the honest "known but not running" bucket. */
  dead: number
  /** Sessions alive right now; the wake pass uses exactly this list, so the doorbell can only ring for someone who exists. */
  live: string[]
  error: string | null
}

const emptyPublication = (via: Publication['via'], error: string | null = null): Publication => ({
  dead: 0,
  live: [],
  error,
  headers: 0,
  host_view: false,
  no_id: 0,
  published: 0,
  via,
  with_id: 0,
})

/**
 * Publish the host's OWN session view to the bus.
 *
 * The bus can only be as complete as what someone tells it. A session that never
 * called a bus tool does not exist for the daemon, and the daemon must not go
 * looking on its own — reading session logs is the one thing this whole design
 * forbids. This plugin is the only participant that can see the host's live
 * agents, so it publishes them.
 *
 * ONLY live agents are published, and that is not an optimisation. A session
 * registered as alive is claimed alive for the whole heartbeat window, so
 * registering a dead one would not merely add a stale row — it would lie. Between
 * "invisible" and "lying", invisible wins. (The daemon now accepts `alive: false`;
 * publishing the full persisted list is a separate decision, not a bug fix.)
 */
async function publishLiveSessions(view: HostView, via: Publication['via'], env: BusEnv, token: string, timeoutMs: number): Promise<Publication> {
  const out: Publication = { dead: 0, error: null, headers: 0, host_view: true, live: [], no_id: 0, published: 0, via, with_id: 0 }

  let headers: unknown
  try {
    headers = await view.persistence.list()
  } catch (error) {
    out.error = `sessionPersistence.list() failed: ${(error as Error | undefined)?.message ?? String(error)}`
    return out
  }
  if (!Array.isArray(headers)) {
    out.error = `sessionPersistence.list() returned ${typeof headers}, not an array`
    return out
  }
  out.headers = headers.length

  for (const row of headers as SnapshotLike[]) {
    if (out.published >= HEARTBEAT_BATCH) break
    const header = (row?.header ?? row) as SessionHeaderLike
    const id = typeof header?.id === 'string' ? header.id : typeof header?.sessionId === 'string' ? header.sessionId : undefined
    if (id === undefined) {
      out.no_id += 1
      continue
    }
    out.with_id += 1

    let agent: ReturnType<NonNullable<AgentsLike['get']>> | undefined
    try {
      agent = view.agents.get?.(id)
    } catch (error) {
      out.error = `agents.get() threw: ${(error as Error | undefined)?.message ?? String(error)}`
      return out
    }
    if (agent === undefined) {
      out.dead += 1
      continue // not live: never claim it
    }

    const headerCwd = typeof header?.cwd === 'string' ? header.cwd : ''
    const cwd = typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : headerCwd
    // `alive: true` is explicit: the daemon reads it as "stamp a heartbeat now".
    const outcome = await call(env, token, 'POST', ROUTES.sessions, {}, registrationBody(id, cwd), timeoutMs)
    if (isFail(outcome)) {
      out.error = `registering ${id} failed: ${outcome.code} ${outcome.message}`
      return out
    }
    out.published += 1
    out.live.push(id)
  }
  return out
}

/** Timer path: best effort, never throws, never blocks a tool call. */
async function publishQuietly(view: HostView | undefined, via: Publication['via'], options: BusOptions | undefined, timeoutMs: number): Promise<Publication> {
  if (view === undefined) return emptyPublication(via, 'host view unavailable')
  try {
    const env = resolveEnv(options)
    if ('ok' in env) return emptyPublication(via, env.message)
    const token = readToken(env)
    if (typeof token !== 'string') return emptyPublication(via, token.message)
    return await publishLiveSessions(view, via, env, token, timeoutMs)
  } catch (error) {
    return emptyPublication(via, String((error as Error | undefined)?.message ?? error))
  }
}

export function apply(ctx: Ctx, options?: BusOptions): void {
  const tickMs = typeof options?.heartbeatMs === 'number' && options.heartbeatMs >= 10 ? options.heartbeatMs : HEARTBEAT_MS
  const timeoutMs = typeof options?.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS

  // Resolve the host view once, then keep it: the inject callback may fire after
  // this synchronous body has already returned.
  let view: HostView | undefined = asHostView(ctx)
  let via: Publication['via'] = view === undefined ? 'none' : 'direct'
  if (view === undefined && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['agents', 'sessionPersistence'], (scope) => {
        view = asHostView(scope)
        if (view !== undefined) via = 'inject'
      })
    } catch {
      via = 'none'
    }
  }
  /**
   * Report the exact paths this plugin resolved. This is the whole point of
   * `whoami` on a host where three different `dsh` installations once coexisted:
   * a disagreement about the session list has to be diagnosable in one call.
   */
  // Wake bookkeeping: the bus is the source of truth for what is unread, this only
  // stops the same msg_id from ringing twice. It is now persisted, because an
  // in-memory set resets on every host restart — and an unacked prompt from before
  // the restart would then ring a second time. Disk is the only thing that survives
  // the thing we are protecting against.
  const wakeEnv = resolveEnv(options)
  // `'ok' in env` is the FAILURE shape in this module (BusFail carries ok:false).
  const woken = loadWoken('ok' in wakeEnv ? '' : wakeEnv.busDir)
  let lastWake: WakeReport | null = null
  // Why this exists: on 2026-10-31 the timer published nothing for 70s while the
  // same code passed in unit tests. A tick that cannot say where it stopped is a
  // tick you can only speculate about.
  let lastTick: { [key: string]: Json | undefined } | null = null

  ctx.tools.register({
    name: 'session_bus_whoami',
    description:
      'Resolve which session bus this plugin talks to and who the caller is. The resolved absolute paths are part of the answer: when the bus session list disagrees with the host view, compare these first.',
    parameters: { properties: {}, type: 'object' },
    output: textOutput(),
    execute: async (_args, exec) => {
      const env = resolveEnv(options)
      if ('ok' in env) return env
      const token = readToken(env)
      const sessionId = sessionIdOf(exec)
      const bus: Json = {
        base_url: env.baseUrl,
        bus_dir: env.busDir,
        dsh_home: env.dshHome,
        // Windows has no mode bits (see the header note), so "present" is the
        // only honest claim: the file was readable.
        token_file: env.tokenFile,
        token_readable: typeof token === 'string',
      }
      if (sessionId === undefined) {
        return { bus, code: 'NO_SESSION_ID', message: 'this tool call carries no session identity (exec.agent.id is absent)', ok: false, session_id: null }
      }
      if (typeof token !== 'string') return { ...token, bus, session_id: sessionId }
      const registered = await heartbeat(env, token, sessionId, timeoutMs)
      if (registered !== undefined) return { ...registered, bus, session_id: sessionId }
      const outcome = await call(env, token, 'GET', ROUTES.whoami, { session: sessionId }, undefined, timeoutMs)
      if (isFail(outcome)) return { ...outcome, bus, session_id: sessionId }
      return { bus, ok: true, session_id: sessionId, registration: outcome.body }
    },
    isConcurrencySafe: () => true,
  })

  // ---------------- session_bus_wake ----------------
  ctx.tools.register({
    name: 'session_bus_wake',
    description:
      'Wake policy for the caller session. quiet = this session is never woken by an incoming session.prompt (use it while a human is typing here); auto = normal doorbell, and it also overrides the quiet-directory rule for this session; list = show the policy and how it applies to you. Only the caller can be changed: a session cannot silence another one.',
    parameters: {
      properties: {
        action: { description: 'quiet | auto | list', enum: ['quiet', 'auto', 'list'], type: 'string' },
      },
      required: ['action'],
      type: 'object',
    },
    output: textOutput(),
    execute: async (args, exec) => {
      const env = resolveEnv(options)
      if ('ok' in env) return env
      const sessionId = sessionIdOf(exec)
      if (sessionId === undefined) {
        return fail('NO_SESSION_ID', 'this tool call carries no session identity (exec.agent.id is absent), so the policy cannot name a session')
      }

      const raw = (args as { action?: unknown })?.action
      const action = typeof raw === 'string' ? raw : ''
      const policy = readWakePolicy(env.busDir, env.dshHome)

      if (action === 'list') {
        return {
          action,
          allow: policy.allow,
          ok: true,
          quiet: policy.quiet,
          quiet_cwd: policy.quietCwd,
          session_id: sessionId,
          state: policy.allow.includes(sessionId) ? 'always' : policy.quiet.includes(sessionId) ? 'never' : 'by-directory',
        }
      }
      if (action !== 'quiet' && action !== 'auto') {
        return fail('BUS_ERROR', `action must be quiet, auto or list; got ${JSON.stringify(raw ?? null)}`)
      }

      const next: WakePolicy = {
        allow: policy.allow.filter((id) => id !== sessionId),
        quiet: policy.quiet.filter((id) => id !== sessionId),
        quietCwd: policy.quietCwd,
      }
      if (action === 'quiet') next.quiet.push(sessionId)
      // `auto` also force-allows. Without that, a session whose cwd is the quiet directory
      // (dshHome — exactly where the GUI lives) could never opt back into the doorbell.
      else next.allow.push(sessionId)
      writeWakePolicy(env.busDir, next)
      return { action, ok: true, policy_file: wakePolicyPath(env.busDir), session_id: sessionId }
    },
  })

  ctx.tools.register({
    name: 'session_bus_list',
    description:
      'List the sessions the local session bus knows about (id, cwd, whether a turn is running, title when available). Use this to find a target for session_bus_send. A session missing from this list may still exist in the host — check session_bus_whoami paths before concluding otherwise.',
    parameters: {
      properties: {
        running_only: { description: 'Only sessions currently running.', type: 'boolean' },
      },
      type: 'object',
    },
    output: textOutput(),
    execute: async (args, exec) => {
      const prepared = await prepare(options, exec, timeoutMs)
      if (isFail(prepared)) return prepared
      // Listing is the moment the answer matters, so refresh the view first:
      // the timer may be up to a minute stale.
      const publication =
        view === undefined
          ? emptyPublication(via, 'host view unavailable: neither ctx.get() nor ctx.inject() produced sessionPersistence + agents')
          : await publishLiveSessions(view, via, prepared.env, prepared.token, timeoutMs)
      const runningOnly = (args as { running_only?: unknown }).running_only === true ? '1' : undefined
      const outcome = await call(prepared.env, prepared.token, 'GET', ROUTES.sessions, { running: runningOnly }, undefined, timeoutMs)
      if (isFail(outcome)) return outcome
      // Listing is when the answer matters, so the doorbell rings here as well:
      // the timer is a background convenience, not the only way a wake can happen.
      if (view !== undefined) {
        lastWake = await wakePendingPrompts(view, prepared.env, prepared.token, timeoutMs, woken, publication.live, prepared.sessionId)
      }
      return { ok: true, publication, sessions: outcome.body, tick: lastTick, wake: lastWake }
    },
    isConcurrencySafe: () => true,
  })

  ctx.tools.register({
    name: 'session_bus_send',
    description:
      `Send one message to a session on this host. Success means the message reached the MAILBOX (queued_at), NOT that any model read it (acked_at) — never tell the user it was delivered. Bodies over ${MAX_BODY_BYTES} bytes are refused with NEED_CONTENT_REF: attach content_ref instead of truncating.`,
    parameters: {
      properties: {
        to: { description: 'Target session id, exactly as returned by session_bus_list.', type: 'string' },
        body: { description: 'Message body, UTF-8, at most 65536 bytes.', type: 'string' },
        idempotency_key: {
          description: 'Optional client-chosen key. Re-sending the same key yields the same msg_id and the same seq instead of a second message.',
          type: 'string',
        },
        reply_to: { description: 'Optional msg_id this message answers.', type: 'string' },
        method: {
          description:
            "message.send (default) only queues the message. session.prompt ALSO asks the target host to open a turn. Without it the peer may sit on the message indefinitely: delivery is not a wake (see the bus README, A8).",
          enum: ['message.send', 'session.prompt'],
          type: 'string',
        },
        content_ref: {
          description: 'Optional external content: {sha256, bytes, name, path}. sha256 present means blob transfer; sha256 null with path means a filesystem fallback; both empty is INVALID_ENVELOPE.',
          type: 'object',
        },
      },
      required: ['to', 'body'],
      type: 'object',
    },
    output: textOutput(),
    execute: async (args, exec) => {
      const prepared = await prepare(options, exec, timeoutMs)
      if (isFail(prepared)) return prepared
      const input = args as { to?: unknown; body?: unknown; idempotency_key?: unknown; reply_to?: unknown; method?: unknown; content_ref?: unknown }

      const to = typeof input.to === 'string' ? input.to.trim() : ''
      if (to === '') return fail('BUS_ERROR', 'send requires a non-empty target session id in `to`')
      if (typeof input.body !== 'string') return fail('BUS_ERROR', 'send requires `body` as a string')

      const bytes = Buffer.byteLength(input.body, 'utf8')
      if (bytes > MAX_BODY_BYTES) {
        return fail(
          'BUS_ERROR',
          `body is ${bytes} bytes, over the ${MAX_BODY_BYTES}-byte envelope limit; attach content_ref instead of truncating (NEED_CONTENT_REF)`,
          { bytes, limit: MAX_BODY_BYTES, server_code: 'NEED_CONTENT_REF' },
        )
      }

      const payload: Record<string, Json | undefined> = {
        body: input.body,
        content_ref: (input.content_ref ?? null) as Json,
        from: prepared.sessionId,
        // Default stays message.send: the bus is a mailbox, not a doorbell, and a
        // message that always rang would turn every reply into a paid turn.
        method: typeof input.method === 'string' ? input.method : 'message.send',
        idempotency_key: typeof input.idempotency_key === 'string' ? input.idempotency_key : null,
        reply_to: typeof input.reply_to === 'string' ? input.reply_to : null,
        to,
      }

      const outcome = await call(prepared.env, prepared.token, 'POST', ROUTES.messages, {}, payload as Json, SEND_TIMEOUT_MS)
      if (isFail(outcome)) return outcome
      const receipt = outcome.body as { msg_id?: unknown; seq?: unknown } | null
      // Narrow the receipt instead of trusting the daemon's types: a shape change
      // on the other side must degrade this object, not crash the tool.
      const msgId = typeof receipt?.msg_id === 'string' ? receipt.msg_id : undefined
      const seq = typeof receipt?.seq === 'number' ? receipt.seq : undefined
      return {
        // Restate the semantics next to the receipt: a caller that skims this
        // object must not read "ok: true" as "delivered".
        delivery: 'queued',
        note: 'queued_at means the message reached the mailbox; only a non-null acked_at means a model read it.',
        ok: true,
        receipt: outcome.body,
        ...(msgId === undefined ? {} : { msg_id: msgId }),
        ...(seq === undefined ? {} : { seq }),
      }
    },
  })

  ctx.tools.register({
    name: 'session_bus_inbox',
    description:
      'Read this session\'s mailbox from since_seq (exclusive) upward. Each message carries queued_at (reached the mailbox) and acked_at (a model read it); read_by_model is true ONLY when acked_at is set. Call session_bus_ack afterwards to record that you actually read them.',
    parameters: {
      properties: {
        since_seq: { description: 'Return messages with seq greater than this. Omit for everything unread.', type: 'number' },
        limit: { description: 'Maximum messages to return (server cap applies).', type: 'number' },
      },
      type: 'object',
    },
    output: textOutput(),
    execute: async (args, exec) => {
      const prepared = await prepare(options, exec, timeoutMs)
      if (isFail(prepared)) return prepared
      const input = args as { since_seq?: unknown; limit?: unknown }
      const sinceSeq = typeof input.since_seq === 'number' && Number.isFinite(input.since_seq) ? input.since_seq : undefined
      const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : undefined

      const outcome = await call(
        prepared.env,
        prepared.token,
        'GET',
        ROUTES.inbox,
        { limit, session: prepared.sessionId, since: sinceSeq },
        undefined,
        timeoutMs,
      )
      if (isFail(outcome)) return outcome

      const body = outcome.body as { messages?: unknown; next_seq?: unknown } | null
      const messages = Array.isArray(body?.messages) ? body?.messages : []
      // Derive the one flag that matters from acked_at ALONE (header rule 4).
      const annotated = messages.map((message) => {
        const ackedAt = (message as { acked_at?: unknown } | null)?.acked_at ?? null
        return { ...(message as Record<string, Json>), read_by_model: ackedAt !== null }
      })
      return { messages: annotated as Json, next_seq: (body?.next_seq ?? null) as Json, ok: true }
    },
  })

  /**
   * A 1v1 conversation view, and the reason it lives on the BUS: `acked_at` — the
   * only thing that can say "the other side read it" — exists in the daemon. A
   * local outbox mirror would show every message as sent forever, which is a lie
   * of exactly the kind this project keeps paying for.
   *
   * Ordering is the server's, passed through untouched. The two directions sit in
   * DIFFERENT seq spaces (an "out" message carries the RECIPIENT's seq), so
   * sorting by seq would look like a timeline and be a coincidence.
   */
  ctx.tools.register({
    name: 'session_bus_thread',
    description:
      'Read the conversation with ONE peer: both directions in the order the bus ordered them (queued_at), each message tagged direction "in"/"out" and read (whether the RECIPIENT read it — for an "out" message that is the peer, for an "in" message that is you; read_scope names which). `limit` keeps the MOST RECENT N (the bus caps from the oldest end, so this tool asks for the whole thread and keeps the tail; total/truncated say what was left out). seq is NOT one timeline: an "out" message carries the peer\'s seq (server field seq_is).',
    parameters: {
      properties: {
        peer: { description: 'The other session id.', type: 'string' },
        limit: { description: 'Keep only the most recent N messages. Omit for the whole thread.', type: 'number' },
      },
      required: ['peer'],
      type: 'object',
    },
    output: textOutput(),
    execute: async (args, exec) => {
      // Validate BEFORE resolving the bus: prepare() registers this session with a
      // POST, so a typo in `peer` would otherwise cost a round-trip to learn
      // nothing.
      const input = args as { peer?: unknown; limit?: unknown }
      const peer = typeof input.peer === 'string' ? input.peer.trim() : ''
      if (peer === '') return fail('BUS_ERROR', 'thread requires a non-empty peer session id')
      const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : undefined

      const prepared = await prepare(options, exec, timeoutMs)
      if (isFail(prepared)) return prepared
      const outcome = await call(
        prepared.env,
        prepared.token,
        'GET',
        ROUTES.inbox,
        { peer, session: prepared.sessionId },
        undefined,
        timeoutMs,
      )
      if (isFail(outcome)) return outcome

      const body = outcome.body as { count?: unknown; messages?: unknown; peer?: unknown; seq_is?: unknown } | null
      const messages = Array.isArray(body?.messages) ? body?.messages : []
      const annotated = messages.map((message) => {
        const row = (message as Record<string, Json> | null) ?? {}
        const direction = row.direction === 'out' ? 'out' : 'in'
        // The same `read` field answers two different questions depending on
        // direction. Name whose reading it reports, or a UI will collapse them and
        // start claiming the peer read something it never read.
        return { ...row, read_scope: direction === 'out' ? 'peer' : 'me' }
      })

      // The bus caps from the OLDEST end, which is the wrong end for a
      // conversation. Rather than re-sorting (the bus owns order), ask for the
      // whole thread and keep the tail — the caller said "most recent N" by
      // asking for a chat view.
      const total = annotated.length
      const shown = limit !== undefined && limit > 0 && total > limit ? annotated.slice(total - limit) : annotated
      return {
        count: shown.length as Json,
        messages: shown as Json,
        ok: true,
        peer: peer as Json,
        // Two directions do not share a seq space; the server says so and the
        // caller must not read the numbers as one timeline.
        seq_is: (body?.seq_is ?? null) as Json,
        total: total as Json,
        truncated: shown.length < total ? true : false,
      }
    },
    isConcurrencySafe: () => true,
  })

  /**
   * Rooms — ONE tool with an `action` switch, deliberately.
   *
   * Every registered tool schema is carried in EVERY turn's prompt, for every
   * agent, forever. We are heading for dozens of co-operating sessions, so eight
   * room verbs do not get eight schemas: the caller can read one enum; the prompt
   * bill would be paid on every single turn.
   *
   * The bus owns `room_seq`. A client that computed one would invent an order
   * nobody agreed to (decisions 41 / R3), so this tool never sends one — it only
   * echoes what the daemon assigned.
   */
  ctx.tools.register({
    name: 'session_bus_room',
    description:
      'Rooms on the bus: a shared place several sessions talk in, where the daemon assigns ONE monotonic room_seq (clients never compute it). action: create | list | join | leave | members | send | read | ack. visibility is open|member (moderated is not implemented by the daemon and is refused). A room never carries a decision — attach `contract_ref` instead. NOT_MEMBER is a 403 about membership, not about your token.',
    parameters: {
      properties: {
        action: {
          description: 'create | list | join | leave | members | send | read | ack',
          enum: ['create', 'list', 'join', 'leave', 'members', 'send', 'read', 'ack'],
          type: 'string',
        },
        room: { description: 'Room id (room-…). Required by everything except create and list.', type: 'string' },
        name: { description: 'create: room name.', type: 'string' },
        purpose: { description: 'create: chat | work. Decisions are contracts, not purposes.', enum: ['chat', 'work'], type: 'string' },
        visibility: { description: 'create: open | member.', enum: ['open', 'member'], type: 'string' },
        body: { description: 'send: message body.', type: 'string' },
        content_ref: { description: 'send: attach instead of truncating (same envelope as the mailbox).', type: 'object' },
        mentions: { description: 'send: array of session ids, role:<name>, or all.', type: 'array' },
        contract_ref: { description: 'send: reference a contract; the room itself never holds the decision.', type: 'string' },
        since_room_seq: { description: 'read: return messages after this room_seq.', type: 'number' },
        limit: { description: 'read: keep only the most recent N (the daemon caps from the oldest end, so this tool reads the slice and keeps its tail).', type: 'number' },
        up_to_room_seq: { description: 'ack: highest room_seq actually read. Moves forward only.', type: 'number' },
      },
      required: ['action'],
      type: 'object',
    },
    output: textOutput(),
    execute: async (args, exec) => {
      const input = args as Record<string, unknown>
      const ACTIONS = ['create', 'list', 'join', 'leave', 'members', 'send', 'read', 'ack'] as const
      const action = typeof input.action === 'string' ? input.action : ''
      if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
        return fail('BUS_ERROR', `session_bus_room requires action to be one of ${ACTIONS.join(', ')}; got ${JSON.stringify(input.action ?? null)}`)
      }
      const room = typeof input.room === 'string' ? input.room.trim() : ''
      // Validate BEFORE resolving the bus: prepare() registers this session with a
      // POST, so a missing argument must not cost a round trip to discover.
      if (action !== 'create' && action !== 'list' && room === '') {
        return fail('BUS_ERROR', `action=${action} requires \`room\` (a room-… id)`)
      }
      if (action === 'send' && typeof input.body !== 'string' && input.content_ref === undefined) {
        return fail('BUS_ERROR', 'action=send requires `body` (or a `content_ref` when the payload is large)')
      }
      if (action === 'ack' && !(typeof input.up_to_room_seq === 'number' && Number.isFinite(input.up_to_room_seq))) {
        return fail('BUS_ERROR', 'action=ack requires `up_to_room_seq` as a number')
      }

      const prepared = await prepare(options, exec, timeoutMs)
      if (isFail(prepared)) return prepared
      const { token } = prepared
      const { env } = prepared
      const session = prepared.sessionId

      if (action === 'create') {
        const payload = {
          name: typeof input.name === 'string' ? input.name : '',
          purpose: typeof input.purpose === 'string' ? input.purpose : 'chat',
          session,
          ...(typeof input.visibility === 'string' ? { visibility: input.visibility } : {}),
        }
        const outcome = await call(env, token, 'POST', ROUTES.rooms, {}, payload as Json, timeoutMs)
        if (isFail(outcome)) return outcome
        return { ok: true, receipt: outcome.body }
      }

      if (action === 'list') {
        const outcome = await call(env, token, 'GET', ROUTES.rooms, { session }, undefined, timeoutMs)
        if (isFail(outcome)) return outcome
        return { ok: true, result: outcome.body }
      }

      if (action === 'join' || action === 'leave') {
        const outcome = await call(env, token, 'POST', roomPath(room, `/${action}`), {}, { session } as Json, timeoutMs)
        if (isFail(outcome)) return outcome
        return { action, ok: true, receipt: outcome.body, room }
      }

      if (action === 'members') {
        const outcome = await call(env, token, 'GET', roomPath(room, '/members'), {}, undefined, timeoutMs)
        if (isFail(outcome)) return outcome
        return { ok: true, result: outcome.body, room }
      }

      if (action === 'send') {
        const payload = {
          ...(input.content_ref === undefined ? {} : { content_ref: input.content_ref }),
          ...(Array.isArray(input.mentions) ? { mentions: input.mentions } : {}),
          ...(typeof input.contract_ref === 'string' ? { contract_ref: input.contract_ref } : {}),
          ...(typeof input.body === 'string' ? { body: input.body } : {}),
          session,
        }
        const outcome = await call(env, token, 'POST', roomPath(room, '/messages'), {}, payload as Json, timeoutMs)
        if (isFail(outcome)) return outcome
        const receipt = outcome.body as { room_seq?: unknown } | null
        return {
          note: 'room_seq is assigned by the daemon; a client must never compute it.',
          ok: true,
          receipt: outcome.body,
          room,
          ...(typeof receipt?.room_seq === 'number' ? { room_seq: receipt.room_seq } : {}),
        }
      }

      if (action === 'read') {
        const outcome = await call(
          env,
          token,
          'GET',
          roomPath(room, '/messages'),
          { since_room_seq: typeof input.since_room_seq === 'number' ? input.since_room_seq : undefined },
          undefined,
          timeoutMs,
        )
        if (isFail(outcome)) return outcome
        const body = outcome.body as { messages?: unknown; next_room_seq?: unknown } | null
        const all: Json[] = Array.isArray(body?.messages) ? (body?.messages as Json[]) : []
        const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : undefined
        const total = all.length
        // Same rule as the 1v1 thread: the daemon caps from the oldest end, and a
        // conversation view means the newest end.
        const shown = limit !== undefined && limit > 0 && total > limit ? all.slice(total - limit) : all
        return {
          messages: shown as Json,
          next_room_seq: (body?.next_room_seq ?? null) as Json,
          ok: true,
          returned: shown.length as Json,
          room,
          total: total as Json,
          truncated: shown.length < total,
        }
      }

      // action === 'ack'
      const upTo = input.up_to_room_seq as number
      const outcome = await call(env, token, 'POST', roomPath(room, '/ack'), {}, { session, up_to_room_seq: upTo } as Json, timeoutMs)
      if (isFail(outcome)) return outcome
      return { ok: true, receipt: outcome.body, room, up_to_room_seq: upTo }
    },
    isConcurrencySafe: () => true,
  })

  ctx.tools.register({
    name: 'session_bus_ack',
    description:
      'Record that this session has read everything up to up_to_seq. This is the ONLY action that sets acked_at; without it a sender sees "queued" forever and cannot tell reading from transport failure.',
    parameters: {
      properties: {
        up_to_seq: { description: 'Highest seq this session has actually read.', type: 'number' },
      },
      required: ['up_to_seq'],
      type: 'object',
    },
    output: textOutput(),
    execute: async (args, exec) => {
      const prepared = await prepare(options, exec, timeoutMs)
      if (isFail(prepared)) return prepared
      const upToSeq = (args as { up_to_seq?: unknown }).up_to_seq
      if (typeof upToSeq !== 'number' || !Number.isFinite(upToSeq) || upToSeq < 0) {
        return fail('BUS_ERROR', 'ack requires `up_to_seq` as a non-negative number')
      }
      const outcome = await call(
        prepared.env,
        prepared.token,
        'POST',
        ROUTES.ack,
        {},
        { session: prepared.sessionId, up_to: upToSeq },
        timeoutMs,
      )
      if (isFail(outcome)) return outcome
      return { ok: true, receipt: outcome.body, up_to_seq: upToSeq }
    },
    isConcurrencySafe: () => true,
  })

  /**
   * Refresh the published view on a timer, not only when a tool happens to run.
   *
   * Without this, a live agent looks dead to the bus 120 seconds after its last
   * tool call (`bus.go:374`) — which is precisely the window in which an agent
   * would look at the list, see nobody, and conclude it is alone. A session
   * registry that only stays correct while someone is using it is not a registry.
   */
  const timer = setInterval(() => {
    const at = (): string => new Date().toISOString()
    lastTick = { at: at(), stage: 'fired' }
    void (async () => {
      const publication = await publishQuietly(view, via, options, timeoutMs)
      lastTick = { ...lastTick, published: publication.published, stage: 'published' }
      if (view === undefined) { lastTick = { ...lastTick, stage: 'no-view' }; return }
      if (!publication.host_view) { lastTick = { ...lastTick, note: publication.error, stage: 'no-host-view' }; return }
      const env = resolveEnv(options)
      if ('ok' in env) { lastTick = { ...lastTick, note: env.message, stage: 'env-failed' }; return }
      const token = readToken(env)
      if (typeof token !== 'string') { lastTick = { ...lastTick, note: token.message, stage: 'no-token' }; return }
      lastWake = await wakePendingPrompts(view, env, token, timeoutMs, woken, publication.live)
      lastTick = { ...lastTick, stage: 'woke', woken: lastWake.woken.length }
    })().catch((error: unknown) => {
      lastTick = { ...lastTick, note: String((error as Error | undefined)?.message ?? error), stage: 'threw' }
    })
  }, tickMs)
  // The timer must never be the reason a process cannot exit.
  timer.unref?.()

  const stop = (): void => clearInterval(timer)
  // Both hooks are optional on purpose: a host without them simply keeps an
  // unref'd timer, which is harmless. Name the disposer for stderr readability.
  const dispose = Object.assign(stop, { [Symbol.toStringTag]: 'sessionBusHeartbeat' })
  // cordis calls the setup function IMMEDIATELY and keeps what it RETURNS as the
  // disposer. `() => stop()` therefore stopped the timer at creation (measured
  // 2026-10-31: `tick` stayed null across two host restarts while the same code
  // passed in unit tests, whose fake ctx has no `effect`). The arrow must return
  // the disposer, not be one.
  ctx.effect?.(() => stop)
  ctx.on?.('dispose', dispose)
}

/** The daemon marks turn requests with this; anything else is an ordinary message. */
const WAKE_METHOD = 'session.prompt'
/** How many sessions one tick may ring. A doorbell that wakes the whole house is a siren. */
const WAKE_BATCH = 4
const WAKE_MEMORY_MAX = 512

const wokenPath = (busDir: string): string => join(busDir, 'woken.json')

/** Persisted ring history: the only thing that survives the restart an in-memory Set does not. */
function loadWoken(busDir: string): Set<string> {
  if (busDir === '') return new Set()
  try {
    const raw = JSON.parse(readFileSync(wokenPath(busDir), 'utf8')) as { ids?: unknown }
    return new Set(stringList(raw.ids))
  } catch {
    return new Set()
  }
}

function saveWoken(busDir: string, woken: Set<string>): void {
  if (busDir === '') return
  try {
    writeFileSync(wokenPath(busDir), `${JSON.stringify({ ids: [...woken].slice(-WAKE_MEMORY_MAX) })}\n`, 'utf8')
  } catch {
    // Bookkeeping must never silence the doorbell; the bus stays the authority for
    // what is unread, so a lost file costs one duplicate ring, not a missed message.
  }
}

/**
 * Wake policy: **a session a human is looking at is not woken; agents still are.**
 *
 * Why not "nothing is woken": agents rely on the doorbell — a peer sends
 * `session.prompt` precisely to open a turn. Removing it breaks that flow. The only
 * thing worth removing is "a human is typing here and a `role:'user'` message lands
 * inside their turn anyway".
 *
 * Three layers, highest first — the first one is what makes it reversible per session:
 *   allow    : always ring, even inside a quiet directory (one session opting back in)
 *   quiet    : never ring (an explicit id, written by `session_bus_wake quiet`)
 *   quietCwd : never ring for sessions whose working directory is one of these
 *              (default `[dshHome]` — that is where the human opens the GUI)
 *
 * **This is a heuristic, not a credential.** Opening the GUI inside a repo still gets
 * rung. The honest fix is the host telling us "a GUI is watching this session"
 * (CONSENSUS C10's ruling), and that is not implemented yet.
 */
interface WakePolicy {
  allow: string[]
  quiet: string[]
  quietCwd: string[]
}

const wakePolicyPath = (busDir: string): string => join(busDir, 'wake-policy.json')

/** Compare directories the way the platform resolves them (Windows is case-insensitive). */
const normalizeDir = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

function readWakePolicy(busDir: string, dshHome: string): WakePolicy {
  const fallback: WakePolicy = { allow: [], quiet: [], quietCwd: [normalizeDir(dshHome)] }
  try {
    const raw = JSON.parse(readFileSync(wakePolicyPath(busDir), 'utf8')) as { allow?: unknown; quiet?: unknown; quietCwd?: unknown }
    return {
      allow: stringList(raw.allow),
      quiet: stringList(raw.quiet),
      // An explicit empty array means "no directory rule" — do not silently restore the default.
      quietCwd: raw.quietCwd === undefined ? fallback.quietCwd : stringList(raw.quietCwd).map(normalizeDir),
    }
  } catch {
    return fallback
  }
}

function writeWakePolicy(busDir: string, policy: WakePolicy): void {
  writeFileSync(wakePolicyPath(busDir), `${JSON.stringify(policy, null, 2)}\n`, 'utf8')
}

/** Why this session must not be rung right now, or `undefined` when ringing is allowed. */
function quietReason(policy: WakePolicy, id: string, cwd: string): 'allow' | 'quiet' | 'quiet-cwd' | undefined {
  if (policy.allow.includes(id)) return 'allow'
  if (policy.quiet.includes(id)) return 'quiet'
  if (cwd !== '' && policy.quietCwd.some((dir) => normalizeDir(cwd) === dir)) return 'quiet-cwd'
  return undefined
}

interface InboxMessageLike {
  msg_id?: unknown
  seq?: unknown
  method?: unknown
  from?: unknown
  acked_at?: unknown
}

interface WakeReport {
  [key: string]: Json | undefined
  at: string
  /** 這一輪因為對方正在跑回合而延後的會話；下一個 tick 會再試，不會被當成已響過。 */
  deferred: string[]
  /** 這一輪因為喚醒政策（人機會話 / 明確靜音）而不敲的會話。可看見，不是壞掉。 */
  quiet: string[]
  woken: string[]
  note: string | null
}

/**
 * Ring the doorbell: wake a session that has an unread `session.prompt` waiting.
 *
 * THE BODY NEVER ENTERS THE PROMPT. The woken turn is told how many, from whom,
 * and which seq range — never the text. A body is written by a remote peer;
 * inlining it into a user message hands the network a write into this session's
 * context, which is prompt injection with extra steps. The model then pulls the
 * content through `session_bus_inbox`, where it stays data.
 *
 * A message without `method` is NOT a prompt. That is the safe direction: a
 * missed wake is retried on the next tick, while a wrong wake spends money and
 * starts a turn nobody asked for.
 */
async function wakePendingPrompts(
  view: HostView,
  env: BusEnv,
  token: string,
  timeoutMs: number,
  woken: Set<string>,
  live: readonly string[],
  except?: string,
): Promise<WakeReport> {
  const report: WakeReport = { at: new Date().toISOString(), deferred: [], note: null, quiet: [], woken: [] }
  const policy = readWakePolicy(env.busDir, env.dshHome)
  let budget = WAKE_BATCH

  for (const id of live) {
    if (budget <= 0) break
    // Never ring the caller: it is mid-turn by definition, and a self-wake produces a
    // user message nobody sent — indistinguishable, from the inside, from a real one.
    if (id === except) continue
    const agent = view.agents.get(id)
    if (agent === undefined) continue

    // 喚醒政策：人機會話不敲門。這比「正在跑回合」更早判斷——後者是時機問題，
    // 前者是「這個會話本來就不該被叫醒」。'allow' 是明確的反向覆蓋（單一會話自救）。
    const sessionCwd = typeof agent.session?.header?.cwd === 'string' ? agent.session.header.cwd : ''
    const wakeRule = quietReason(policy, id, sessionCwd)
    if (wakeRule !== undefined && wakeRule !== 'allow') {
      report.quiet.push(id)
      continue
    }

    if (typeof agent.send !== 'function') {
      report.note = 'agents.get(id).send is absent on this host build — the doorbell cannot ring'
      continue
    }

    // 有人正在那個回合裡（人在打字，或模型在跑）。此時敲門等於把一則 role:'user' 的訊息
    // 插進人家正在進行的那一回合——那不是「通知」，是插隊。延後，不要打斷：
    // 不記進 woken，所以下一個 tick 還會再試；記進 deferred，讓「沒響」是可看見的，
    // 而不是像壞掉一樣安靜。
    if (agent.status === 'running') {
      report.deferred.push(id)
      continue
    }

    // `order=newest` is not cosmetic. The daemon defaults to returning from the
    // OLDEST end, so `since=0&limit=50` silently stops seeing new prompts once a
    // mailbox holds more than 50 messages: the doorbell just goes quiet, with no
    // error anywhere. Arithmetic is enough to show it — a prompt at seq 51 is not
    // in the oldest-50 window. (Reported by GAS with a live reproduction; the
    // daemon grew `order=newest` for exactly this call.)
    const outcome = await call(env, token, 'GET', ROUTES.inbox, { limit: 50, order: 'newest', session: id, since: 0 }, undefined, timeoutMs)
    if (isFail(outcome)) {
      report.note = `${outcome.code} while reading ${id}: ${outcome.message}`
      continue
    }
    const body = outcome.body as { messages?: unknown } | null
    const messages = Array.isArray(body?.messages) ? (body?.messages as InboxMessageLike[]) : []
    const prompts = messages.filter((m) => m?.method === WAKE_METHOD && m?.acked_at === null && typeof m?.msg_id === 'string')
    const fresh = prompts.filter((m) => !woken.has(m.msg_id as string))
    if (fresh.length === 0) continue

    const seqs = fresh.map((m) => Number(m.seq)).filter((n) => Number.isFinite(n))
    const peers = [...new Set(fresh.map((m) => String(m.from ?? '?')))]
    const range = seqs.length === 0 ? '?' : seqs.length === 1 ? `seq ${seqs[0]}` : `seq ${Math.min(...seqs)}..${Math.max(...seqs)}`
    const text = [
      `[session bus] 你有 ${fresh.length} 封未讀的回合請求（${range}，來自 ${peers.join('、')}）。`,
      '內容不在這裡：用 session_bus_inbox 讀，讀完用 session_bus_ack 記錄。',
      '提醒：queued_at 只代表進了信箱，acked_at 才代表讀過。',
    ].join('\n')

    try {
      agent.send(
        { content: [{ text, type: 'text' }], id: `bus-wake-${String(fresh[0].msg_id)}`, role: 'user', source: { kind: 'user' } },
        'next-turn',
        true,
      )
    } catch (error) {
      report.note = `send threw for ${id}: ${(error as Error | undefined)?.message ?? String(error)}`
      continue
    }

    for (const m of fresh) {
      const msgId = String(m.msg_id)
      woken.add(msgId)
      report.woken.push(msgId)
    }
    if (woken.size > WAKE_MEMORY_MAX) {
      for (const stale of [...woken].slice(0, woken.size - WAKE_MEMORY_MAX)) woken.delete(stale)
    }
    saveWoken(env.busDir, woken)
    budget -= 1
  }
  return report
}
