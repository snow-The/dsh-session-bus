/**
 * dsh-session-bus tests — run against the built bundle, with a REAL http server.
 *
 * Nothing about the plugin's transport is mocked: a node:http server plays the
 * daemon, the plugin builds a real request and parses a real response. What is
 * mocked is only the daemon's decisions. That keeps the expensive bugs visible —
 * a wrong header, a lost query parameter, a status mapped to the wrong code.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../dist/index.js'

const SESSION = 'session-11111111-2222-3333-4444-555555555555'
const PEER = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const AGENT_EXEC = { agent: { id: SESSION } }

/** Collect the tools a plugin life registers. */
function makeCtx() {
  const tools = []
  tools.register = (tool) => tools.push(tool)
  const byName = (name) => {
    const tool = tools.find((candidate) => candidate.name === name)
    assert.ok(tool, `tool ${name} was not registered`)
    return tool
  }
  return { byName, tools }
}

/** A throwaway DSH home with the daemon's port and token files. */
function makeHome(port) {
  const home = mkdtempSync(join(tmpdir(), 'session-bus-test-'))
  const busDir = join(home, 'session-bus')
  mkdirSync(busDir, { recursive: true })
  if (port !== undefined) writeFileSync(join(busDir, 'port'), `${port}\n`)
  writeFileSync(join(busDir, 'token'), 'test-token-0123456789\n')
  return home
}

const cleanup = (home) => rmSync(home, { force: true, recursive: true })

/** Start a real server; `handler` decides each response and records each request. */
async function startDaemon(handler) {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const request = { body: raw === '' ? undefined : JSON.parse(raw), headers: req.headers, method: req.method, url: new URL(req.url, 'http://127.0.0.1') }
      requests.push(request)
      handler(request, res)
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  return {
    port,
    requests,
    stop: () => new Promise((done) => server.close(done)),
  }
}

const json = (res, status, body) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

test('no daemon: every tool answers UNAVAILABLE naming the port file it looked for', async () => {
  const home = makeHome(undefined)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    for (const name of ['session_bus_list', 'session_bus_inbox', 'session_bus_whoami']) {
      const result = await ctx.byName(name).execute({}, AGENT_EXEC)
      assert.equal(result.ok, false, `${name} must fail, not succeed emptily`)
      assert.equal(result.code, 'UNAVAILABLE')
      // The path must be in the message: that is what makes a mis-resolved
      // DSH_HOME diagnosable without reading source.
      assert.match(result.message, /session-bus[\\/]port/)
      assert.match(result.message, new RegExp(home.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&').slice(0, 12)))
    }
  } finally {
    cleanup(home)
  }
})

test('discovery: the port file supplies the endpoint, the token file supplies the bearer', async () => {
  const daemon = await startDaemon((request, res) => json(res, 200, { registered: { session_id: SESSION } }))
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_whoami').execute({}, AGENT_EXEC)

    assert.equal(result.ok, true)
    assert.equal(result.session_id, SESSION)
    assert.equal(result.bus.base_url, `http://127.0.0.1:${daemon.port}`)
    assert.equal(result.bus.token_file, join(home, 'session-bus', 'token'))
    assert.equal(result.bus.token_readable, true)

    // Every operation starts with the registration/heartbeat the daemon requires.
    const registration = daemon.requests.find((request) => request.url.pathname === '/v1/sessions')
    assert.ok(registration, 'the client must register itself before using the bus')
    assert.equal(registration.method, 'POST')
    assert.deepEqual(registration.body, { alive: true, cwd: '', session_id: SESSION }, 'explicit alive:true, and cwd stays empty: a plausible wrong path is worse than none')

    const request = daemon.requests.find((candidate) => candidate.url.pathname === '/v1/whoami')
    assert.equal(request.headers.authorization, 'Bearer test-token-0123456789', 'token file content, trimmed, as a bearer')
    assert.equal(request.url.searchParams.get('session'), SESSION)
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

test('whoami still reports the resolved paths when the daemon is down', async () => {
  const home = makeHome(65001) // nothing listens here
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_whoami').execute({}, AGENT_EXEC)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'UNAVAILABLE')
    assert.equal(result.session_id, SESSION)
    assert.equal(result.bus.base_url, 'http://127.0.0.1:65001')
  } finally {
    cleanup(home)
  }
})

test('send: the sender is the calling agent, and a receipt is labelled queued, never delivered', async () => {
  const daemon = await startDaemon((_request, res) => json(res, 201, { msg_id: 'msg-1', queued_at: '2026-10-30T09:00:00Z', seq: 7 }))
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_send').execute(
      { body: 'hello peer', idempotency_key: 'k-1', reply_to: 'msg-0', to: PEER },
      AGENT_EXEC,
    )

    assert.equal(result.ok, true)
    assert.equal(result.msg_id, 'msg-1')
    assert.equal(result.seq, 7)
    // The single most misread result in the whole bus.
    assert.equal(result.delivery, 'queued')
    assert.match(result.note, /acked_at/)

    const request = daemon.requests.find((candidate) => candidate.url.pathname === '/v1/messages')
    assert.equal(request.method, 'POST')
    // method defaults to message.send: the bus is a mailbox, not a doorbell.
    assert.deepEqual(request.body, {
      body: 'hello peer',
      content_ref: null,
      from: SESSION,
      idempotency_key: 'k-1',
      method: 'message.send',
      reply_to: 'msg-0',
      to: PEER,
    })
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

// 投遞 ≠ 叫醒。沒有 method=session.prompt 的信只會躺在對方的信箱裡，
// 對方不會因此開回合——我這邊六封信就這樣被讀到之前卡了很久（A8）。
test('send: method=session.prompt is forwarded so the peer host opens a turn', async () => {
  const daemon = await startDaemon((_request, res) => json(res, 201, { msg_id: 'msg-2', seq: 8 }))
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_send').execute({ body: 'wake', method: 'session.prompt', to: PEER }, AGENT_EXEC)
    assert.equal(result.ok, true)
    const request = daemon.requests.find((candidate) => candidate.url.pathname === '/v1/messages')
    assert.equal(request.body.method, 'session.prompt')
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

test('send: method is carried through, and a plain message stays plain', async () => {
  const daemon = await startDaemon((_request, res) => json(res, 201, { msg_id: 'm', queued_at: 'now', seq: 1 }))
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })

    await ctx.byName('session_bus_send').execute({ body: 'ring', method: 'session.prompt', to: PEER }, AGENT_EXEC)
    await ctx.byName('session_bus_send').execute({ body: 'quiet', to: PEER }, AGENT_EXEC)

    const sends = daemon.requests.filter((r) => r.url.pathname === '/v1/messages')
    assert.equal(sends[0].body.method, 'session.prompt', 'a turn request must reach the bus as method=session.prompt')
    // The tool always names the method, defaulting to message.send — an explicit
    // 'not a doorbell' is better than an absent field, which every reader guesses at.
    assert.equal(sends[1].body.method, 'message.send', 'a plain message must say message.send explicitly')
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

test('send: an oversized body is refused with NEED_CONTENT_REF and never reaches the network', async () => {
  const daemon = await startDaemon((_request, res) => json(res, 201, {}))
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_send').execute({ body: 'x'.repeat(64 * 1024 + 1), to: PEER }, AGENT_EXEC)

    assert.equal(result.ok, false)
    assert.equal(result.details.server_code, 'NEED_CONTENT_REF')
    assert.equal(result.details.limit, 65536)
    assert.equal(daemon.requests.filter((r) => r.url.pathname === '/v1/messages').length, 0, 'the body must not be sent and then rejected: that would be two semantics for one failure')
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

test('inbox: read_by_model follows acked_at alone, queued_at cannot make it true', async () => {
  const messages = [
    { acked_at: null, body: 'unread', msg_id: 'm1', queued_at: '2026-10-30T09:00:00Z', seq: 1 },
    { acked_at: '2026-10-30T09:05:00Z', body: 'read', msg_id: 'm2', queued_at: '2026-10-30T09:01:00Z', seq: 2 },
    // Adversarial: a sender-provided read flag must not be trusted over acked_at.
    { acked_at: null, body: 'claims a read', msg_id: 'm3', queued_at: '2026-10-30T09:02:00Z', read_by_model: true, seq: 3 },
  ]
  const daemon = await startDaemon((_request, res) => json(res, 200, { messages, next_seq: 4 }))
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_inbox').execute({ limit: 10, since_seq: 0 }, AGENT_EXEC)

    assert.equal(result.ok, true)
    assert.equal(result.next_seq, 4)
    assert.deepEqual(
      result.messages.map((message) => message.read_by_model),
      [false, true, false],
      'only a non-null acked_at means a model read the message',
    )
    assert.equal(result.messages[0].queued_at, '2026-10-30T09:00:00Z', 'the raw timestamps survive so a caller can tell the two apart')

    const request = daemon.requests.find((candidate) => candidate.url.pathname === '/v1/inbox')
    assert.equal(request.url.searchParams.get('session'), SESSION)
    assert.equal(request.url.searchParams.get('since'), '0')
    assert.equal(request.url.searchParams.get('limit'), '10')
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

test('ack posts the calling session and the sequence, and nothing else', async () => {
  const daemon = await startDaemon((_request, res) => json(res, 200, { acked: 3 }))
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_ack').execute({ up_to_seq: 3 }, AGENT_EXEC)

    assert.equal(result.ok, true)
    const request = daemon.requests.find((candidate) => candidate.url.pathname === '/v1/ack')
    assert.deepEqual(request.body, { session: SESSION, up_to: 3 })
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

test('a rejected token surfaces as UNAUTHORIZED with the token path to re-read', async () => {
  const daemon = await startDaemon((_request, res) => json(res, 401, { code: 'UNAUTHORIZED' }))
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_list').execute({}, AGENT_EXEC)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'UNAUTHORIZED')
    assert.match(result.message, /token/)
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

test('a non-loopback endpoint is refused before any token leaves the process', async () => {
  const home = makeHome(undefined)
  try {
    const ctx = makeCtx()
    apply(ctx, { baseUrl: 'http://10.0.0.5:7331', dshHome: home })
    const result = await ctx.byName('session_bus_list').execute({}, AGENT_EXEC)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'MISCONFIGURED')
    assert.match(result.message, /loopback/)
  } finally {
    cleanup(home)
  }
})

test('a token file outside the bus home is refused as MISCONFIGURED', async () => {
  const home = makeHome(undefined)
  const elsewhere = mkdtempSync(join(tmpdir(), 'session-bus-elsewhere-'))
  try {
    const tokenFile = join(elsewhere, 'token')
    writeFileSync(tokenFile, 'nope')
    const ctx = makeCtx()
    apply(ctx, { dshHome: home, tokenFile })
    const result = await ctx.byName('session_bus_list').execute({}, AGENT_EXEC)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'MISCONFIGURED')
  } finally {
    cleanup(home)
    rmSync(elsewhere, { force: true, recursive: true })
  }
})

test('a call without a session identity says so instead of addressing nobody', async () => {
  const daemon = await startDaemon((_request, res) => json(res, 200, {}))
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_list').execute({}, {})
    assert.equal(result.ok, false)
    assert.equal(result.code, 'NO_SESSION_ID')
    assert.equal(daemon.requests.length, 0)
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

test('a daemon that answers non-JSON is INVALID_RESPONSE, not a silent empty inbox', async () => {
  const daemon = await startDaemon((_request, res) => {
    res.statusCode = 200
    res.end('<html>oops</html>')
  })
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_inbox').execute({}, AGENT_EXEC)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'INVALID_RESPONSE')
    assert.match(result.details.preview, /html/)
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

test('publish: the host live view is registered, dead sessions are never claimed', async () => {
  const daemon = await startDaemon((_request, res) => json(res, 200, { ok: true }))
  const home = makeHome(daemon.port)
  const liveId = 'session-live-aaaaaaaa'
  const deadId = 'session-dead-bbbbbbbb'
  try {
    const ctx = makeCtx()
    ctx.get = (name) =>
      name === 'sessionPersistence'
        ? { list: async () => [{ header: { cwd: 'C:/from-header', id: liveId }, revision: 'r1' }, { header: { cwd: 'C:/dead', id: deadId }, revision: 'r2' }] }
        : name === 'agents'
          ? { get: (id) => (id === liveId ? { session: { header: { cwd: 'C:/live/from-agent' } } } : undefined) }
          : undefined
    apply(ctx, { dshHome: home })

    const result = await ctx.byName('session_bus_list').execute({}, AGENT_EXEC)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.publication.published, 1, 'exactly one live session should be published')
    assert.equal(result.publication.via, 'direct')
    assert.equal(result.publication.headers, 2)
    assert.equal(result.publication.with_id, 2, 'both rows must yield an id: the official snapshot nests it under .header')
    assert.equal(result.publication.no_id, 0)

    const registrations = daemon.requests.filter((request) => request.url.pathname === '/v1/sessions' && request.method === 'POST')
    const published = registrations.map((request) => request.body.session_id)
    assert.ok(published.includes(liveId), `live session missing from ${JSON.stringify(published)}`)
    assert.ok(!published.includes(deadId), 'a dead session must not be registered: the daemon would call it running for 120s')

    const live = registrations.find((request) => request.body.session_id === liveId)
    assert.equal(live.body.cwd, 'C:/live/from-agent', "the agent's cwd wins over the persisted header")
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

test('publish: without the host view the tool still lists what the bus has', async () => {
  const daemon = await startDaemon((request, res) =>
    request.method === 'POST' ? json(res, 200, { ok: true }) : json(res, 200, { sessions: [] }),
  )
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx() // no ctx.get at all: the host view is genuinely unavailable
    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_list').execute({}, AGENT_EXEC)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.publication.published, 0)
    assert.equal(result.publication.host_view, false)
    assert.match(result.publication.error, /host view unavailable/)
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

test('registered tool surface: seven tools, all with a schema and a renderer', async () => {
  const home = makeHome(undefined)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    assert.deepEqual(
      ctx.tools.map((tool) => tool.name).sort(),
      // This list is a deliberate surface contract: growing it is a decision, not a side
      // effect. `session_bus_wake` was added so a session can silence the doorbell while
      // a human is typing in it (wake policy: allow > quiet > quietCwd).
      [
        'session_bus_ack',
        'session_bus_inbox',
        'session_bus_list',
        'session_bus_room',
        'session_bus_send',
        'session_bus_thread',
        'session_bus_wake',
        'session_bus_whoami',
      ],
    )
    for (const tool of ctx.tools) {
      assert.equal(tool.parameters.type, 'object', `${tool.name} needs an object parameter schema`)
      assert.equal(typeof tool.output.render, 'function', `${tool.name} needs a renderer`)
    }
  } finally {
    cleanup(home)
  }
})

test('thread: one peer, both directions, and whose reading `read` reports', async () => {
  const daemon = await startDaemon((request, res) => {
    // prepare() registers this session before the tool touches the inbox.
    if (request.url.pathname === '/v1/sessions') return json(res, 200, { registered: { session_id: SESSION } })
    if (request.url.pathname === '/v1/inbox') {
      return json(res, 200, {
        count: 2,
        messages: [
          { acked_at: '2026-10-31T06:44:00Z', body: 'x', direction: 'out', from: SESSION, seq: 40, to: PEER },
          { acked_at: null, body: 'y', direction: 'in', from: PEER, seq: 21, to: SESSION },
        ],
        peer: PEER,
        seq_is: 'recipient',
      })
    }
    return json(res, 404, { error: { code: 'UNKNOWN_SESSION', message: 'nope' } })
  })
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_thread').execute({ peer: PEER }, AGENT_EXEC)
    assert.equal(result.ok, true)
    // BOTH session and peer must be on the query: a thread addressed only by peer
    // silently becomes "everything this peer ever sent anyone".
    const inbox = daemon.requests.find((r) => r.url.pathname === '/v1/inbox')
    assert.equal(inbox.url.searchParams.get('session'), SESSION)
    assert.equal(inbox.url.searchParams.get('peer'), PEER)
    // The order is the server's. Sorting by seq would look like a timeline and be
    // a coincidence: the two directions do not share a seq space.
    assert.deepEqual(result.messages.map((m) => m.seq), [40, 21])
    assert.equal(result.seq_is, 'recipient')
    // `read` means "the RECIPIENT read it", so its scope flips with direction.
    assert.equal(result.messages[0].read_scope, 'peer')
    assert.equal(result.messages[1].read_scope, 'me')
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

test('thread: an empty peer is refused before any request is made', async () => {
  const daemon = await startDaemon((request, res) => json(res, 200, { messages: [] }))
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_thread').execute({ peer: '   ' }, AGENT_EXEC)
    assert.equal(result.ok, false)
    assert.match(result.message, /peer/)
    assert.equal(daemon.requests.length, 0, 'a bad argument must not reach the network')
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

test('thread: limit keeps the most recent N, because the bus caps from the oldest end', async () => {
  const rows = [
    { acked_at: null, body: 'one', direction: 'in', from: PEER, seq: 1, to: SESSION },
    { acked_at: null, body: 'two', direction: 'out', from: SESSION, seq: 2, to: PEER },
    { acked_at: null, body: 'three', direction: 'in', from: PEER, seq: 3, to: SESSION },
  ]
  const daemon = await startDaemon((request, res) => {
    if (request.url.pathname === '/v1/sessions') return json(res, 200, { registered: { session_id: SESSION } })
    return json(res, 200, { count: rows.length, messages: rows, peer: PEER, seq_is: 'recipient' })
  })
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_thread').execute({ limit: 2, peer: PEER }, AGENT_EXEC)
    assert.equal(result.ok, true)
    assert.deepEqual(result.messages.map((m) => m.body), ['two', 'three'])
    assert.equal(result.total, 3)
    assert.equal(result.truncated, true)
    // Ask for the WHOLE thread: passing limit to the bus would hand back the
    // OLDEST N and quietly lose the recent end of the conversation.
    const inbox = daemon.requests.find((r) => r.url.pathname === '/v1/inbox')
    assert.equal(inbox.url.searchParams.get('limit'), null)
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

test('room: NOT_MEMBER (403) is a membership problem, never a token problem', async () => {
  const daemon = await startDaemon((request, res) => {
    if (request.url.pathname === '/v1/sessions') return json(res, 200, { registered: { session_id: SESSION } })
    // The daemon answers 403 for "the room exists, you are simply not in it".
    return json(res, 403, { error: { code: 'NOT_MEMBER', message: 'session is not a member of this room' } })
  })
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_room').execute({ action: 'members', room: 'room-abc123' }, AGENT_EXEC)
    assert.equal(result.ok, false)
    // The whole point: this is NOT UNAUTHORIZED. Sending an operator to re-read
    // the token file for a membership problem is a wrong answer that looks right.
    assert.equal(result.code, 'NOT_MEMBER')
    assert.match(result.message, /NOT_MEMBER/)
    assert.doesNotMatch(result.message, /token/)
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

test('send: NO_GRANT (403) is a permission problem, never a token problem', async () => {
  const daemon = await startDaemon((request, res) => {
    if (request.url.pathname === '/v1/sessions') return json(res, 200, { registered: { session_id: SESSION } })
    // Real daemon behaviour (GAS bus.go): the target has not granted this method.
    // Same status as a bad bearer token, different meaning, different recovery.
    return json(res, 403, { error: { code: 'NO_GRANT', message: 'NO_GRANT' } })
  })
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_send').execute(
      { body: 'hello', method: 'message.send', to: 'session-peer' },
      AGENT_EXEC,
    )
    assert.equal(result.ok, false)
    assert.equal(result.code, 'NO_GRANT')
    assert.match(result.message, /NO_GRANT/)
    // The regression this pins: it used to say "re-read <token file>", which sent
    // the operator to a file that was never the problem.
    assert.doesNotMatch(result.message, /token/i)
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

test('room: create posts the documented body, and defaults purpose to chat', async () => {
  const daemon = await startDaemon((request, res) => {
    if (request.url.pathname === '/v1/sessions') return json(res, 200, { registered: { session_id: SESSION } })
    return json(res, 200, { room_id: 'room-abc123' })
  })
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_room').execute({ action: 'create', name: 'triage' }, AGENT_EXEC)
    assert.equal(result.ok, true)
    const create = daemon.requests.find((r) => r.url.pathname === '/v1/rooms')
    assert.ok(create, 'create must POST /v1/rooms')
    assert.equal(create.method, 'POST')
    assert.equal(create.body.session, SESSION)
    assert.equal(create.body.name, 'triage')
    assert.equal(create.body.purpose, 'chat')
    // visibility is optional; sending it when the caller did not ask would let
    // this client silently pick the weaker, more open default.
    assert.equal(create.body.visibility, undefined)
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

test('room: send never invents a room_seq and echoes the one the daemon assigned', async () => {
  const daemon = await startDaemon((request, res) => {
    if (request.url.pathname === '/v1/sessions') return json(res, 200, { registered: { session_id: SESSION } })
    return json(res, 200, { msg_id: 'm1', room_seq: 7 })
  })
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_room').execute(
      { action: 'send', body: 'hello room', contract_ref: 'c-1', room: 'room-abc123' },
      AGENT_EXEC,
    )
    assert.equal(result.ok, true)
    assert.equal(result.room_seq, 7)
    const post = daemon.requests.find((r) => r.url.pathname === '/v1/rooms/room-abc123/messages')
    assert.ok(post, 'send must POST /v1/rooms/{id}/messages')
    assert.equal(post.body.contract_ref, 'c-1')
    // R3: room_seq has exactly one writer, and it is the daemon. A client that
    // sent one would be inventing an order nobody agreed to.
    assert.equal(post.body.room_seq, undefined)
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})

test('room: a bad action or a missing room is refused before any request is made', async () => {
  const daemon = await startDaemon((request, res) => json(res, 200, { messages: [] }))
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    apply(ctx, { dshHome: home })
    const badAction = await ctx.byName('session_bus_room').execute({ action: 'destroy', room: 'room-1' }, AGENT_EXEC)
    assert.equal(badAction.ok, false)
    assert.match(badAction.message, /action must be one of|requires action/)
    const noRoom = await ctx.byName('session_bus_room').execute({ action: 'read' }, AGENT_EXEC)
    assert.equal(noRoom.ok, false)
    assert.match(noRoom.message, /requires `room`/)
    assert.equal(daemon.requests.length, 0, 'bad arguments must not reach the network')
  } finally {
    await daemon.stop()
    cleanup(home)
  }
})
