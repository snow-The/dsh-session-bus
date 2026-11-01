// src/index.ts
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
var name = "session-bus";
var inject = ["tools"];
var MAX_BODY_BYTES = 64 * 1024;
var ROUTES = {
  whoami: "/v1/whoami",
  /** GET lists sessions; POST is the registration/heartbeat that `send` requires. */
  sessions: "/v1/sessions",
  messages: "/v1/messages",
  inbox: "/v1/inbox",
  ack: "/v1/ack",
  rooms: "/v1/rooms"
};
var roomPath = (room, suffix = "") => `/v1/rooms/${encodeURIComponent(room)}${suffix}`;
var PASSTHROUGH_CODES = /* @__PURE__ */ new Set(["INVALID_ENVELOPE", "NEED_CONTENT_REF", "UNKNOWN_SESSION", "UNAUTHORIZED", "NO_GRANT", "ROOM_NOT_FOUND", "NOT_MEMBER"]);
var DEFAULT_TIMEOUT_MS = 5e3;
var SEND_TIMEOUT_MS = 15e3;
var fail = (code, message, details) => ({ code, message, ok: false, ...details === void 0 ? {} : { details } });
var textOutput = () => ({
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }]
});
function sessionIdOf(exec) {
  const agent = exec?.agent;
  const id = agent?.id;
  return typeof id === "string" && id !== "" ? id : void 0;
}
function resolveEnv(options) {
  const pickString = (...candidates) => {
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
    }
    return void 0;
  };
  const dshHome = resolve(pickString(options?.dshHome, process.env.DSH_HOME) ?? join(homedir(), ".dsh"));
  const busDir = join(dshHome, "session-bus");
  const tokenFile = resolve(pickString(options?.tokenFile, process.env.DSH_SESSION_BUS_TOKEN) ?? join(busDir, "token"));
  if (tokenFile !== busDir && !tokenFile.startsWith(busDir + sep)) {
    return fail("MISCONFIGURED", `token file must live inside the bus home: ${tokenFile} is not under ${busDir}`);
  }
  const explicitUrl = pickString(options?.baseUrl, process.env.DSH_SESSION_BUS_URL);
  let baseUrl;
  if (explicitUrl !== void 0) {
    baseUrl = explicitUrl.replace(/\/+$/, "");
  } else {
    const portFile = join(busDir, "port");
    let raw;
    try {
      raw = readFileSync(portFile, "utf8").trim();
    } catch {
      return fail("UNAVAILABLE", `session bus daemon is not running: no port file at ${portFile}`);
    }
    const port = Number.parseInt(raw, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return fail("MISCONFIGURED", `port file ${portFile} does not contain a usable port: ${JSON.stringify(raw.slice(0, 40))}`);
    }
    baseUrl = `http://127.0.0.1:${port}`;
  }
  let host;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return fail("MISCONFIGURED", `session bus URL is not a valid URL: ${baseUrl}`);
  }
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") {
    return fail("MISCONFIGURED", `session bus must be loopback-only in v1, got host ${JSON.stringify(host)} (${baseUrl})`);
  }
  return { baseUrl, busDir, dshHome, tokenFile };
}
function readToken(env) {
  try {
    const token = readFileSync(env.tokenFile, "utf8").trim();
    if (token === "") return fail("UNAUTHORIZED", `token file ${env.tokenFile} is empty`);
    return token;
  } catch {
    return fail("UNAVAILABLE", `session bus token is missing: ${env.tokenFile}`);
  }
}
async function call(env, token, method, path, query, payload, timeoutMs) {
  const url = new URL(env.baseUrl + path);
  for (const [key, value] of Object.entries(query)) {
    if (value !== void 0 && value !== "") url.searchParams.set(key, String(value));
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...payload === void 0 ? {} : { "content-type": "application/json" }
      },
      ...payload === void 0 ? {} : { body: JSON.stringify(payload) },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const name0 = error?.name ?? "";
    if (name0 === "TimeoutError" || name0 === "AbortError") {
      return fail("TIMEOUT", `session bus did not answer ${method} ${path} within ${timeoutMs}ms at ${env.baseUrl}`);
    }
    const cause = error?.cause?.code;
    return fail(
      "UNAVAILABLE",
      `cannot reach the session bus at ${env.baseUrl} (${cause ?? (name0 === "" ? "fetch failed" : name0)}); is dsh-busd running?`
    );
  }
  const text = await response.text();
  let body = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      return fail("INVALID_RESPONSE", `session bus returned non-JSON (${response.status}) from ${path}`, {
        preview: text.slice(0, 200)
      });
    }
  }
  const serverCode = body?.error?.code;
  const serverMessage = body?.error?.message;
  const detail = typeof serverMessage === "string" && serverMessage !== "" ? serverMessage : text.slice(0, 200);
  const recognised = typeof serverCode === "string" && PASSTHROUGH_CODES.has(serverCode);
  if (response.status === 401 || response.status === 403) {
    if (recognised && serverCode !== "UNAUTHORIZED") {
      return fail(serverCode, `${serverCode} (HTTP ${response.status}) at ${path}: ${detail}`, { body, status: response.status });
    }
    return fail("UNAUTHORIZED", `session bus rejected the bearer token (${response.status}); re-read ${env.tokenFile}`, { status: response.status });
  }
  if (!response.ok) {
    if (recognised) {
      return fail(serverCode, `${serverCode} (HTTP ${response.status}) at ${path}: ${detail}`, { body, status: response.status });
    }
    return fail("BUS_ERROR", `session bus answered ${response.status} at ${path}: ${typeof serverCode === "string" ? serverCode : detail}`, {
      body,
      status: response.status
    });
  }
  return { body, ok: true, status: response.status };
}
var registrationBody = (sessionId, cwd) => ({ alive: true, cwd, session_id: sessionId });
async function heartbeat(env, token, sessionId, timeoutMs) {
  const outcome = await call(env, token, "POST", ROUTES.sessions, {}, registrationBody(sessionId, ""), timeoutMs);
  return isFail(outcome) ? outcome : void 0;
}
async function prepare(options, exec, timeoutMs) {
  const env = resolveEnv(options);
  if ("ok" in env) return env;
  const token = readToken(env);
  if (typeof token !== "string") return token;
  const sessionId = sessionIdOf(exec);
  if (sessionId === void 0) {
    return fail("NO_SESSION_ID", "this tool call carries no session identity (exec.agent.id is absent), so the bus cannot address the caller");
  }
  const registered = await heartbeat(env, token, sessionId, timeoutMs);
  if (registered !== void 0) return registered;
  return { env, sessionId, token };
}
var isFail = (value) => typeof value === "object" && value !== null && value.ok === false;
function readService(ctx, name2) {
  const read = ctx?.get;
  if (typeof read !== "function") return void 0;
  try {
    return read.call(ctx, name2);
  } catch {
    return void 0;
  }
}
var HEARTBEAT_MS = 6e4;
var HEARTBEAT_BATCH = 64;
function asHostView(scope) {
  const persistence = readService(scope, "sessionPersistence");
  const agents = readService(scope, "agents");
  return typeof persistence?.list === "function" && typeof agents?.get === "function" ? { agents, persistence } : void 0;
}
var emptyPublication = (via, error = null) => ({
  dead: 0,
  live: [],
  error,
  headers: 0,
  host_view: false,
  no_id: 0,
  published: 0,
  via,
  with_id: 0
});
async function publishLiveSessions(view, via, env, token, timeoutMs) {
  const out = { dead: 0, error: null, headers: 0, host_view: true, live: [], no_id: 0, published: 0, via, with_id: 0 };
  let headers;
  try {
    headers = await view.persistence.list();
  } catch (error) {
    out.error = `sessionPersistence.list() failed: ${error?.message ?? String(error)}`;
    return out;
  }
  if (!Array.isArray(headers)) {
    out.error = `sessionPersistence.list() returned ${typeof headers}, not an array`;
    return out;
  }
  out.headers = headers.length;
  for (const row of headers) {
    if (out.published >= HEARTBEAT_BATCH) break;
    const header = row?.header ?? row;
    const id = typeof header?.id === "string" ? header.id : typeof header?.sessionId === "string" ? header.sessionId : void 0;
    if (id === void 0) {
      out.no_id += 1;
      continue;
    }
    out.with_id += 1;
    let agent;
    try {
      agent = view.agents.get?.(id);
    } catch (error) {
      out.error = `agents.get() threw: ${error?.message ?? String(error)}`;
      return out;
    }
    if (agent === void 0) {
      out.dead += 1;
      continue;
    }
    const headerCwd = typeof header?.cwd === "string" ? header.cwd : "";
    const cwd = typeof agent?.session?.header?.cwd === "string" ? agent.session.header.cwd : headerCwd;
    const outcome = await call(env, token, "POST", ROUTES.sessions, {}, registrationBody(id, cwd), timeoutMs);
    if (isFail(outcome)) {
      out.error = `registering ${id} failed: ${outcome.code} ${outcome.message}`;
      return out;
    }
    out.published += 1;
    out.live.push(id);
  }
  return out;
}
async function publishQuietly(view, via, options, timeoutMs) {
  if (view === void 0) return emptyPublication(via, "host view unavailable");
  try {
    const env = resolveEnv(options);
    if ("ok" in env) return emptyPublication(via, env.message);
    const token = readToken(env);
    if (typeof token !== "string") return emptyPublication(via, token.message);
    return await publishLiveSessions(view, via, env, token, timeoutMs);
  } catch (error) {
    return emptyPublication(via, String(error?.message ?? error));
  }
}
function apply(ctx, options) {
  const tickMs = typeof options?.heartbeatMs === "number" && options.heartbeatMs >= 10 ? options.heartbeatMs : HEARTBEAT_MS;
  const timeoutMs = typeof options?.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  let view = asHostView(ctx);
  let via = view === void 0 ? "none" : "direct";
  if (view === void 0 && typeof ctx.inject === "function") {
    try {
      ctx.inject(["agents", "sessionPersistence"], (scope) => {
        view = asHostView(scope);
        if (view !== void 0) via = "inject";
      });
    } catch {
      via = "none";
    }
  }
  const wakeEnv = resolveEnv(options);
  const woken = loadWoken("ok" in wakeEnv ? "" : wakeEnv.busDir);
  let lastWake = null;
  let lastTick = null;
  ctx.tools.register({
    name: "session_bus_whoami",
    description: "Resolve which session bus this plugin talks to and who the caller is. The resolved absolute paths are part of the answer: when the bus session list disagrees with the host view, compare these first.",
    parameters: { properties: {}, type: "object" },
    output: textOutput(),
    execute: async (_args, exec) => {
      const env = resolveEnv(options);
      if ("ok" in env) return env;
      const token = readToken(env);
      const sessionId = sessionIdOf(exec);
      const bus = {
        base_url: env.baseUrl,
        bus_dir: env.busDir,
        dsh_home: env.dshHome,
        // Windows has no mode bits (see the header note), so "present" is the
        // only honest claim: the file was readable.
        token_file: env.tokenFile,
        token_readable: typeof token === "string"
      };
      if (sessionId === void 0) {
        return { bus, code: "NO_SESSION_ID", message: "this tool call carries no session identity (exec.agent.id is absent)", ok: false, session_id: null };
      }
      if (typeof token !== "string") return { ...token, bus, session_id: sessionId };
      const registered = await heartbeat(env, token, sessionId, timeoutMs);
      if (registered !== void 0) return { ...registered, bus, session_id: sessionId };
      const outcome = await call(env, token, "GET", ROUTES.whoami, { session: sessionId }, void 0, timeoutMs);
      if (isFail(outcome)) return { ...outcome, bus, session_id: sessionId };
      return { bus, ok: true, session_id: sessionId, registration: outcome.body };
    },
    isConcurrencySafe: () => true
  });
  ctx.tools.register({
    name: "session_bus_wake",
    description: "Wake policy for the caller session. quiet = this session is never woken by an incoming session.prompt (use it while a human is typing here); auto = normal doorbell, and it also overrides the quiet-directory rule for this session; list = show the policy and how it applies to you. Only the caller can be changed: a session cannot silence another one.",
    parameters: {
      properties: {
        action: { description: "quiet | auto | list", enum: ["quiet", "auto", "list"], type: "string" }
      },
      required: ["action"],
      type: "object"
    },
    output: textOutput(),
    execute: async (args, exec) => {
      const env = resolveEnv(options);
      if ("ok" in env) return env;
      const sessionId = sessionIdOf(exec);
      if (sessionId === void 0) {
        return fail("NO_SESSION_ID", "this tool call carries no session identity (exec.agent.id is absent), so the policy cannot name a session");
      }
      const raw = args?.action;
      const action = typeof raw === "string" ? raw : "";
      const policy = readWakePolicy(env.busDir, env.dshHome);
      if (action === "list") {
        return {
          action,
          allow: policy.allow,
          ok: true,
          quiet: policy.quiet,
          quiet_cwd: policy.quietCwd,
          session_id: sessionId,
          state: policy.allow.includes(sessionId) ? "always" : policy.quiet.includes(sessionId) ? "never" : "by-directory"
        };
      }
      if (action !== "quiet" && action !== "auto") {
        return fail("BUS_ERROR", `action must be quiet, auto or list; got ${JSON.stringify(raw ?? null)}`);
      }
      const next = {
        allow: policy.allow.filter((id) => id !== sessionId),
        quiet: policy.quiet.filter((id) => id !== sessionId),
        quietCwd: policy.quietCwd
      };
      if (action === "quiet") next.quiet.push(sessionId);
      else next.allow.push(sessionId);
      writeWakePolicy(env.busDir, next);
      return { action, ok: true, policy_file: wakePolicyPath(env.busDir), session_id: sessionId };
    }
  });
  ctx.tools.register({
    name: "session_bus_list",
    description: "List the sessions the local session bus knows about (id, cwd, whether a turn is running, title when available). Use this to find a target for session_bus_send. A session missing from this list may still exist in the host \u2014 check session_bus_whoami paths before concluding otherwise.",
    parameters: {
      properties: {
        running_only: { description: "Only sessions currently running.", type: "boolean" }
      },
      type: "object"
    },
    output: textOutput(),
    execute: async (args, exec) => {
      const prepared = await prepare(options, exec, timeoutMs);
      if (isFail(prepared)) return prepared;
      const publication = view === void 0 ? emptyPublication(via, "host view unavailable: neither ctx.get() nor ctx.inject() produced sessionPersistence + agents") : await publishLiveSessions(view, via, prepared.env, prepared.token, timeoutMs);
      const runningOnly = args.running_only === true ? "1" : void 0;
      const outcome = await call(prepared.env, prepared.token, "GET", ROUTES.sessions, { running: runningOnly }, void 0, timeoutMs);
      if (isFail(outcome)) return outcome;
      if (view !== void 0) {
        lastWake = await wakePendingPrompts(view, prepared.env, prepared.token, timeoutMs, woken, publication.live, prepared.sessionId);
      }
      return { ok: true, publication, sessions: outcome.body, tick: lastTick, wake: lastWake };
    },
    isConcurrencySafe: () => true
  });
  ctx.tools.register({
    name: "session_bus_send",
    description: `Send one message to a session on this host. Success means the message reached the MAILBOX (queued_at), NOT that any model read it (acked_at) \u2014 never tell the user it was delivered. Bodies over ${MAX_BODY_BYTES} bytes are refused with NEED_CONTENT_REF: attach content_ref instead of truncating.`,
    parameters: {
      properties: {
        to: { description: "Target session id, exactly as returned by session_bus_list.", type: "string" },
        body: { description: "Message body, UTF-8, at most 65536 bytes.", type: "string" },
        idempotency_key: {
          description: "Optional client-chosen key. Re-sending the same key yields the same msg_id and the same seq instead of a second message.",
          type: "string"
        },
        reply_to: { description: "Optional msg_id this message answers.", type: "string" },
        method: {
          description: "message.send (default) only queues the message. session.prompt ALSO asks the target host to open a turn. Without it the peer may sit on the message indefinitely: delivery is not a wake (see the bus README, A8).",
          enum: ["message.send", "session.prompt"],
          type: "string"
        },
        content_ref: {
          description: "Optional external content: {sha256, bytes, name, path}. sha256 present means blob transfer; sha256 null with path means a filesystem fallback; both empty is INVALID_ENVELOPE.",
          type: "object"
        }
      },
      required: ["to", "body"],
      type: "object"
    },
    output: textOutput(),
    execute: async (args, exec) => {
      const prepared = await prepare(options, exec, timeoutMs);
      if (isFail(prepared)) return prepared;
      const input = args;
      const to = typeof input.to === "string" ? input.to.trim() : "";
      if (to === "") return fail("BUS_ERROR", "send requires a non-empty target session id in `to`");
      if (typeof input.body !== "string") return fail("BUS_ERROR", "send requires `body` as a string");
      const bytes = Buffer.byteLength(input.body, "utf8");
      if (bytes > MAX_BODY_BYTES) {
        return fail(
          "BUS_ERROR",
          `body is ${bytes} bytes, over the ${MAX_BODY_BYTES}-byte envelope limit; attach content_ref instead of truncating (NEED_CONTENT_REF)`,
          { bytes, limit: MAX_BODY_BYTES, server_code: "NEED_CONTENT_REF" }
        );
      }
      const payload = {
        body: input.body,
        content_ref: input.content_ref ?? null,
        from: prepared.sessionId,
        // Default stays message.send: the bus is a mailbox, not a doorbell, and a
        // message that always rang would turn every reply into a paid turn.
        method: typeof input.method === "string" ? input.method : "message.send",
        idempotency_key: typeof input.idempotency_key === "string" ? input.idempotency_key : null,
        reply_to: typeof input.reply_to === "string" ? input.reply_to : null,
        to
      };
      const outcome = await call(prepared.env, prepared.token, "POST", ROUTES.messages, {}, payload, SEND_TIMEOUT_MS);
      if (isFail(outcome)) return outcome;
      const receipt = outcome.body;
      const msgId = typeof receipt?.msg_id === "string" ? receipt.msg_id : void 0;
      const seq = typeof receipt?.seq === "number" ? receipt.seq : void 0;
      return {
        // Restate the semantics next to the receipt: a caller that skims this
        // object must not read "ok: true" as "delivered".
        delivery: "queued",
        note: "queued_at means the message reached the mailbox; only a non-null acked_at means a model read it.",
        ok: true,
        receipt: outcome.body,
        ...msgId === void 0 ? {} : { msg_id: msgId },
        ...seq === void 0 ? {} : { seq }
      };
    }
  });
  ctx.tools.register({
    name: "session_bus_inbox",
    description: "Read this session's mailbox from since_seq (exclusive) upward. Each message carries queued_at (reached the mailbox) and acked_at (a model read it); read_by_model is true ONLY when acked_at is set. Call session_bus_ack afterwards to record that you actually read them.",
    parameters: {
      properties: {
        since_seq: { description: "Return messages with seq greater than this. Omit for everything unread.", type: "number" },
        limit: { description: "Maximum messages to return (server cap applies).", type: "number" }
      },
      type: "object"
    },
    output: textOutput(),
    execute: async (args, exec) => {
      const prepared = await prepare(options, exec, timeoutMs);
      if (isFail(prepared)) return prepared;
      const input = args;
      const sinceSeq = typeof input.since_seq === "number" && Number.isFinite(input.since_seq) ? input.since_seq : void 0;
      const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : void 0;
      const outcome = await call(
        prepared.env,
        prepared.token,
        "GET",
        ROUTES.inbox,
        { limit, session: prepared.sessionId, since: sinceSeq },
        void 0,
        timeoutMs
      );
      if (isFail(outcome)) return outcome;
      const body = outcome.body;
      const messages = Array.isArray(body?.messages) ? body?.messages : [];
      const annotated = messages.map((message) => {
        const ackedAt = message?.acked_at ?? null;
        return { ...message, read_by_model: ackedAt !== null };
      });
      return { messages: annotated, next_seq: body?.next_seq ?? null, ok: true };
    }
  });
  ctx.tools.register({
    name: "session_bus_thread",
    description: 'Read the conversation with ONE peer: both directions in the order the bus ordered them (queued_at), each message tagged direction "in"/"out" and read (whether the RECIPIENT read it \u2014 for an "out" message that is the peer, for an "in" message that is you; read_scope names which). `limit` keeps the MOST RECENT N (the bus caps from the oldest end, so this tool asks for the whole thread and keeps the tail; total/truncated say what was left out). seq is NOT one timeline: an "out" message carries the peer\'s seq (server field seq_is).',
    parameters: {
      properties: {
        peer: { description: "The other session id.", type: "string" },
        limit: { description: "Keep only the most recent N messages. Omit for the whole thread.", type: "number" }
      },
      required: ["peer"],
      type: "object"
    },
    output: textOutput(),
    execute: async (args, exec) => {
      const input = args;
      const peer = typeof input.peer === "string" ? input.peer.trim() : "";
      if (peer === "") return fail("BUS_ERROR", "thread requires a non-empty peer session id");
      const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : void 0;
      const prepared = await prepare(options, exec, timeoutMs);
      if (isFail(prepared)) return prepared;
      const outcome = await call(
        prepared.env,
        prepared.token,
        "GET",
        ROUTES.inbox,
        { peer, session: prepared.sessionId },
        void 0,
        timeoutMs
      );
      if (isFail(outcome)) return outcome;
      const body = outcome.body;
      const messages = Array.isArray(body?.messages) ? body?.messages : [];
      const annotated = messages.map((message) => {
        const row = message ?? {};
        const direction = row.direction === "out" ? "out" : "in";
        return { ...row, read_scope: direction === "out" ? "peer" : "me" };
      });
      const total = annotated.length;
      const shown = limit !== void 0 && limit > 0 && total > limit ? annotated.slice(total - limit) : annotated;
      return {
        count: shown.length,
        messages: shown,
        ok: true,
        peer,
        // Two directions do not share a seq space; the server says so and the
        // caller must not read the numbers as one timeline.
        seq_is: body?.seq_is ?? null,
        total,
        truncated: shown.length < total ? true : false
      };
    },
    isConcurrencySafe: () => true
  });
  ctx.tools.register({
    name: "session_bus_room",
    description: "Rooms on the bus: a shared place several sessions talk in, where the daemon assigns ONE monotonic room_seq (clients never compute it). action: create | list | join | leave | members | send | read | ack. visibility is open|member (moderated is not implemented by the daemon and is refused). A room never carries a decision \u2014 attach `contract_ref` instead. NOT_MEMBER is a 403 about membership, not about your token.",
    parameters: {
      properties: {
        action: {
          description: "create | list | join | leave | members | send | read | ack",
          enum: ["create", "list", "join", "leave", "members", "send", "read", "ack"],
          type: "string"
        },
        room: { description: "Room id (room-\u2026). Required by everything except create and list.", type: "string" },
        name: { description: "create: room name.", type: "string" },
        purpose: { description: "create: chat | work. Decisions are contracts, not purposes.", enum: ["chat", "work"], type: "string" },
        visibility: { description: "create: open | member.", enum: ["open", "member"], type: "string" },
        body: { description: "send: message body.", type: "string" },
        content_ref: { description: "send: attach instead of truncating (same envelope as the mailbox).", type: "object" },
        mentions: { description: "send: array of session ids, role:<name>, or all.", type: "array" },
        contract_ref: { description: "send: reference a contract; the room itself never holds the decision.", type: "string" },
        since_room_seq: { description: "read: return messages after this room_seq.", type: "number" },
        limit: { description: "read: keep only the most recent N (the daemon caps from the oldest end, so this tool reads the slice and keeps its tail).", type: "number" },
        up_to_room_seq: { description: "ack: highest room_seq actually read. Moves forward only.", type: "number" }
      },
      required: ["action"],
      type: "object"
    },
    output: textOutput(),
    execute: async (args, exec) => {
      const input = args;
      const ACTIONS = ["create", "list", "join", "leave", "members", "send", "read", "ack"];
      const action = typeof input.action === "string" ? input.action : "";
      if (!ACTIONS.includes(action)) {
        return fail("BUS_ERROR", `session_bus_room requires action to be one of ${ACTIONS.join(", ")}; got ${JSON.stringify(input.action ?? null)}`);
      }
      const room = typeof input.room === "string" ? input.room.trim() : "";
      if (action !== "create" && action !== "list" && room === "") {
        return fail("BUS_ERROR", `action=${action} requires \`room\` (a room-\u2026 id)`);
      }
      if (action === "send" && typeof input.body !== "string" && input.content_ref === void 0) {
        return fail("BUS_ERROR", "action=send requires `body` (or a `content_ref` when the payload is large)");
      }
      if (action === "ack" && !(typeof input.up_to_room_seq === "number" && Number.isFinite(input.up_to_room_seq))) {
        return fail("BUS_ERROR", "action=ack requires `up_to_room_seq` as a number");
      }
      const prepared = await prepare(options, exec, timeoutMs);
      if (isFail(prepared)) return prepared;
      const { token } = prepared;
      const { env } = prepared;
      const session = prepared.sessionId;
      if (action === "create") {
        const payload = {
          name: typeof input.name === "string" ? input.name : "",
          purpose: typeof input.purpose === "string" ? input.purpose : "chat",
          session,
          ...typeof input.visibility === "string" ? { visibility: input.visibility } : {}
        };
        const outcome2 = await call(env, token, "POST", ROUTES.rooms, {}, payload, timeoutMs);
        if (isFail(outcome2)) return outcome2;
        return { ok: true, receipt: outcome2.body };
      }
      if (action === "list") {
        const outcome2 = await call(env, token, "GET", ROUTES.rooms, { session }, void 0, timeoutMs);
        if (isFail(outcome2)) return outcome2;
        return { ok: true, result: outcome2.body };
      }
      if (action === "join" || action === "leave") {
        const outcome2 = await call(env, token, "POST", roomPath(room, `/${action}`), {}, { session }, timeoutMs);
        if (isFail(outcome2)) return outcome2;
        return { action, ok: true, receipt: outcome2.body, room };
      }
      if (action === "members") {
        const outcome2 = await call(env, token, "GET", roomPath(room, "/members"), {}, void 0, timeoutMs);
        if (isFail(outcome2)) return outcome2;
        return { ok: true, result: outcome2.body, room };
      }
      if (action === "send") {
        const payload = {
          ...input.content_ref === void 0 ? {} : { content_ref: input.content_ref },
          ...Array.isArray(input.mentions) ? { mentions: input.mentions } : {},
          ...typeof input.contract_ref === "string" ? { contract_ref: input.contract_ref } : {},
          ...typeof input.body === "string" ? { body: input.body } : {},
          session
        };
        const outcome2 = await call(env, token, "POST", roomPath(room, "/messages"), {}, payload, timeoutMs);
        if (isFail(outcome2)) return outcome2;
        const receipt = outcome2.body;
        return {
          note: "room_seq is assigned by the daemon; a client must never compute it.",
          ok: true,
          receipt: outcome2.body,
          room,
          ...typeof receipt?.room_seq === "number" ? { room_seq: receipt.room_seq } : {}
        };
      }
      if (action === "read") {
        const outcome2 = await call(
          env,
          token,
          "GET",
          roomPath(room, "/messages"),
          { since_room_seq: typeof input.since_room_seq === "number" ? input.since_room_seq : void 0 },
          void 0,
          timeoutMs
        );
        if (isFail(outcome2)) return outcome2;
        const body = outcome2.body;
        const all = Array.isArray(body?.messages) ? body?.messages : [];
        const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : void 0;
        const total = all.length;
        const shown = limit !== void 0 && limit > 0 && total > limit ? all.slice(total - limit) : all;
        return {
          messages: shown,
          next_room_seq: body?.next_room_seq ?? null,
          ok: true,
          returned: shown.length,
          room,
          total,
          truncated: shown.length < total
        };
      }
      const upTo = input.up_to_room_seq;
      const outcome = await call(env, token, "POST", roomPath(room, "/ack"), {}, { session, up_to_room_seq: upTo }, timeoutMs);
      if (isFail(outcome)) return outcome;
      return { ok: true, receipt: outcome.body, room, up_to_room_seq: upTo };
    },
    isConcurrencySafe: () => true
  });
  ctx.tools.register({
    name: "session_bus_ack",
    description: 'Record that this session has read everything up to up_to_seq. This is the ONLY action that sets acked_at; without it a sender sees "queued" forever and cannot tell reading from transport failure.',
    parameters: {
      properties: {
        up_to_seq: { description: "Highest seq this session has actually read.", type: "number" }
      },
      required: ["up_to_seq"],
      type: "object"
    },
    output: textOutput(),
    execute: async (args, exec) => {
      const prepared = await prepare(options, exec, timeoutMs);
      if (isFail(prepared)) return prepared;
      const upToSeq = args.up_to_seq;
      if (typeof upToSeq !== "number" || !Number.isFinite(upToSeq) || upToSeq < 0) {
        return fail("BUS_ERROR", "ack requires `up_to_seq` as a non-negative number");
      }
      const outcome = await call(
        prepared.env,
        prepared.token,
        "POST",
        ROUTES.ack,
        {},
        { session: prepared.sessionId, up_to: upToSeq },
        timeoutMs
      );
      if (isFail(outcome)) return outcome;
      return { ok: true, receipt: outcome.body, up_to_seq: upToSeq };
    },
    isConcurrencySafe: () => true
  });
  const timer = setInterval(() => {
    const at = () => (/* @__PURE__ */ new Date()).toISOString();
    lastTick = { at: at(), stage: "fired" };
    void (async () => {
      const publication = await publishQuietly(view, via, options, timeoutMs);
      lastTick = { ...lastTick, published: publication.published, stage: "published" };
      if (view === void 0) {
        lastTick = { ...lastTick, stage: "no-view" };
        return;
      }
      if (!publication.host_view) {
        lastTick = { ...lastTick, note: publication.error, stage: "no-host-view" };
        return;
      }
      const env = resolveEnv(options);
      if ("ok" in env) {
        lastTick = { ...lastTick, note: env.message, stage: "env-failed" };
        return;
      }
      const token = readToken(env);
      if (typeof token !== "string") {
        lastTick = { ...lastTick, note: token.message, stage: "no-token" };
        return;
      }
      lastWake = await wakePendingPrompts(view, env, token, timeoutMs, woken, publication.live);
      lastTick = { ...lastTick, stage: "woke", woken: lastWake.woken.length };
    })().catch((error) => {
      lastTick = { ...lastTick, note: String(error?.message ?? error), stage: "threw" };
    });
  }, tickMs);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  const dispose = Object.assign(stop, { [Symbol.toStringTag]: "sessionBusHeartbeat" });
  ctx.effect?.(() => stop);
  ctx.on?.("dispose", dispose);
}
var WAKE_METHOD = "session.prompt";
var WAKE_BATCH = 4;
var WAKE_MEMORY_MAX = 512;
var wokenPath = (busDir) => join(busDir, "woken.json");
function loadWoken(busDir) {
  if (busDir === "") return /* @__PURE__ */ new Set();
  try {
    const raw = JSON.parse(readFileSync(wokenPath(busDir), "utf8"));
    return new Set(stringList(raw.ids));
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function saveWoken(busDir, woken) {
  if (busDir === "") return;
  try {
    writeFileSync(wokenPath(busDir), `${JSON.stringify({ ids: [...woken].slice(-WAKE_MEMORY_MAX) })}
`, "utf8");
  } catch {
  }
}
var wakePolicyPath = (busDir) => join(busDir, "wake-policy.json");
var normalizeDir = (value) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
var stringList = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
function readWakePolicy(busDir, dshHome) {
  const fallback = { allow: [], quiet: [], quietCwd: [normalizeDir(dshHome)] };
  try {
    const raw = JSON.parse(readFileSync(wakePolicyPath(busDir), "utf8"));
    return {
      allow: stringList(raw.allow),
      quiet: stringList(raw.quiet),
      // An explicit empty array means "no directory rule" — do not silently restore the default.
      quietCwd: raw.quietCwd === void 0 ? fallback.quietCwd : stringList(raw.quietCwd).map(normalizeDir)
    };
  } catch {
    return fallback;
  }
}
function writeWakePolicy(busDir, policy) {
  writeFileSync(wakePolicyPath(busDir), `${JSON.stringify(policy, null, 2)}
`, "utf8");
}
function quietReason(policy, id, cwd) {
  if (policy.allow.includes(id)) return "allow";
  if (policy.quiet.includes(id)) return "quiet";
  if (cwd !== "" && policy.quietCwd.some((dir) => normalizeDir(cwd) === dir)) return "quiet-cwd";
  return void 0;
}
async function wakePendingPrompts(view, env, token, timeoutMs, woken, live, except) {
  const report = { at: (/* @__PURE__ */ new Date()).toISOString(), deferred: [], note: null, quiet: [], woken: [] };
  const policy = readWakePolicy(env.busDir, env.dshHome);
  let budget = WAKE_BATCH;
  for (const id of live) {
    if (budget <= 0) break;
    if (id === except) continue;
    const agent = view.agents.get(id);
    if (agent === void 0) continue;
    const sessionCwd = typeof agent.session?.header?.cwd === "string" ? agent.session.header.cwd : "";
    const wakeRule = quietReason(policy, id, sessionCwd);
    if (wakeRule !== void 0 && wakeRule !== "allow") {
      report.quiet.push(id);
      continue;
    }
    if (typeof agent.send !== "function") {
      report.note = "agents.get(id).send is absent on this host build \u2014 the doorbell cannot ring";
      continue;
    }
    if (agent.status === "running") {
      report.deferred.push(id);
      continue;
    }
    const outcome = await call(env, token, "GET", ROUTES.inbox, { limit: 50, order: "newest", session: id, since: 0 }, void 0, timeoutMs);
    if (isFail(outcome)) {
      report.note = `${outcome.code} while reading ${id}: ${outcome.message}`;
      continue;
    }
    const body = outcome.body;
    const messages = Array.isArray(body?.messages) ? body?.messages : [];
    const prompts = messages.filter((m) => m?.method === WAKE_METHOD && m?.acked_at === null && typeof m?.msg_id === "string");
    const fresh = prompts.filter((m) => !woken.has(m.msg_id));
    if (fresh.length === 0) continue;
    const seqs = fresh.map((m) => Number(m.seq)).filter((n) => Number.isFinite(n));
    const peers = [...new Set(fresh.map((m) => String(m.from ?? "?")))];
    const range = seqs.length === 0 ? "?" : seqs.length === 1 ? `seq ${seqs[0]}` : `seq ${Math.min(...seqs)}..${Math.max(...seqs)}`;
    const text = [
      `[session bus] \u4F60\u6709 ${fresh.length} \u5C01\u672A\u8B80\u7684\u56DE\u5408\u8ACB\u6C42\uFF08${range}\uFF0C\u4F86\u81EA ${peers.join("\u3001")}\uFF09\u3002`,
      "\u5167\u5BB9\u4E0D\u5728\u9019\u88E1\uFF1A\u7528 session_bus_inbox \u8B80\uFF0C\u8B80\u5B8C\u7528 session_bus_ack \u8A18\u9304\u3002",
      "\u63D0\u9192\uFF1Aqueued_at \u53EA\u4EE3\u8868\u9032\u4E86\u4FE1\u7BB1\uFF0Cacked_at \u624D\u4EE3\u8868\u8B80\u904E\u3002"
    ].join("\n");
    try {
      agent.send(
        { content: [{ text, type: "text" }], id: `bus-wake-${String(fresh[0].msg_id)}`, role: "user", source: { kind: "user" } },
        "next-turn",
        true
      );
    } catch (error) {
      report.note = `send threw for ${id}: ${error?.message ?? String(error)}`;
      continue;
    }
    for (const m of fresh) {
      const msgId = String(m.msg_id);
      woken.add(msgId);
      report.woken.push(msgId);
    }
    if (woken.size > WAKE_MEMORY_MAX) {
      for (const stale of [...woken].slice(0, woken.size - WAKE_MEMORY_MAX)) woken.delete(stale);
    }
    saveWoken(env.busDir, woken);
    budget -= 1;
  }
  return report;
}
export {
  apply,
  inject,
  name
};
