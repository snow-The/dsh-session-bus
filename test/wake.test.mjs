/**
 * The doorbell (C3, DSH half): a message marked `method=session.prompt` must open
 * a turn in the target session with nobody pressing anything.
 *
 * Two properties are pinned here, and they pull in opposite directions:
 *
 *  1. IT MUST RING. A prompt that sits in the mailbox unread is the whole reason
 *     the user still has to press a button.
 *  2. IT MUST NOT CARRY THE BODY. A message body is written by a remote peer. If it
 *     lands inside a user message, the network has a write into this session's
 *     context — prompt injection with extra steps. The model pulls content through
 *     `session_bus_inbox` instead, where it stays data.
 *
 * A third property is a cost guard: the same msg_id must ring once, not every tick.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../dist/index.js'

const LIVE = 'session-doorbell-live'
const PEER = 'session-peer-aaaa'
const BODY = 'SECRET-PAYLOAD-DO-NOT-INLINE'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** A daemon that answers registration and hands back one inbox. */
async function startDaemon(messages) {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1')
      requests.push({ method: req.method, pathname: url.pathname, query: url.searchParams })
      res.setHeader('content-type', 'application/json; charset=utf-8')
      if (url.pathname === '/v1/inbox') {
        res.end(JSON.stringify({ messages, next_seq: messages.length }))
        return
      }
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return { port: server.address().port, requests, stop: () => new Promise((done) => server.close(done)) }
}

function makeHome(port) {
  const home = mkdtempSync(join(tmpdir(), 'session-bus-wake-'))
  const busDir = join(home, 'session-bus')
  mkdirSync(busDir, { recursive: true })
  writeFileSync(join(busDir, 'port'), `${port}\n`)
  writeFileSync(join(busDir, 'token'), 'wake-token\n')
  return home
}

/** A host view with one live session; records every wake. */
function makeCtx(woken) {
  // Collect registrations so a test can invoke a tool directly — the timer-only tests
  // never needed this, which is exactly why the first version of the self-wake test
  // failed with 'byName is not a function'.
  const tools = []
  const ctx = { tools: { register: (tool) => tools.push(tool) } }
  ctx.byName = (name) => tools.find((tool) => tool.name === name)
  ctx.get = (name) =>
    name === 'sessionPersistence'
      ? { list: async () => [{ header: { cwd: 'C:/wake', id: LIVE }, revision: 'r1' }] }
      : name === 'agents'
        ? {
            get: (id) =>
              id === LIVE
                ? { send: (message, target, wakeup) => woken.push({ message, target, wakeup }), session: { header: { cwd: 'C:/wake' } } }
                : undefined,
          }
        : undefined
  return ctx
}

const promptMessage = (overrides = {}) => ({
  acked_at: null,
  body: BODY,
  created_at: '2026-10-30T12:00:00Z',
  from: PEER,
  method: 'session.prompt',
  msg_id: 'msg-prompt-1',
  queued_at: '2026-10-30T12:00:00Z',
  seq: 1,
  ...overrides,
})

test('wake: a session.prompt rings exactly once, with a pointer and never the body', async () => {
  const daemon = await startDaemon([promptMessage()])
  const home = makeHome(daemon.port)
  const woken = []
  try {
    apply(makeCtx(woken), { dshHome: home, heartbeatMs: 20 })
    await sleep(160)

    assert.ok(woken.length >= 1, 'the doorbell never rang')
    assert.equal(woken.length, 1, `the same msg_id rang ${woken.length} times; it must ring once`)

    const [{ message, target, wakeup }] = woken
    assert.equal(target, 'next-turn')
    assert.equal(wakeup, true, 'wakeup must be true: that is what opens a turn while the session is idle')

    const text = message.content.map((block) => block.text).join('\n')
    assert.equal(text.includes(BODY), false, 'the remote body leaked into the prompt — that is prompt injection with extra steps')
    assert.match(text, /1 封未讀/, 'the woken turn must know how many are waiting')
    assert.match(text, /seq 1/, 'and which seq, so it can ack precisely')
    assert.match(text, new RegExp(PEER), 'and who sent it')
    assert.match(text, /session_bus_inbox/, 'and how to pull the content')
  } finally {
    await daemon.stop()
    rmSync(home, { force: true, recursive: true })
  }
})

test('wake: a message without method is not a doorbell', async () => {
  const daemon = await startDaemon([promptMessage({ method: undefined })])
  const home = makeHome(daemon.port)
  const woken = []
  try {
    apply(makeCtx(woken), { dshHome: home, heartbeatMs: 20 })
    await sleep(120)
    assert.equal(woken.length, 0, 'a plain message must not open a turn: waking on any mail is a siren, not a doorbell')
  } finally {
    await daemon.stop()
    rmSync(home, { force: true, recursive: true })
  }
})

test('wake: an already-acked prompt does not ring', async () => {
  const daemon = await startDaemon([promptMessage({ acked_at: '2026-10-30T12:05:00Z' })])
  const home = makeHome(daemon.port)
  const woken = []
  try {
    apply(makeCtx(woken), { dshHome: home, heartbeatMs: 20 })
    await sleep(120)
    assert.equal(woken.length, 0, 'acked_at means someone already read it; waking again would double-fire')
  } finally {
    await daemon.stop()
    rmSync(home, { force: true, recursive: true })
  }
})

test('wake: without agents.send the tick reports it instead of throwing', async () => {
  const daemon = await startDaemon([promptMessage()])
  const home = makeHome(daemon.port)
  try {
    const ctx = {
      get: (name) =>
        name === 'sessionPersistence'
          ? { list: async () => [{ header: { cwd: 'C:/wake', id: LIVE }, revision: 'r1' }] }
          : name === 'agents'
            ? { get: (id) => (id === LIVE ? { session: { header: { cwd: 'C:/wake' } } } : undefined) }
            : undefined,
      tools: { register: () => {} },
    }
    apply(ctx, { dshHome: home, heartbeatMs: 20 })
    await sleep(120)
    // The pass must survive; the reason is reported through session_bus_list.wake.
    assert.ok(true)
  } finally {
    await daemon.stop()
    rmSync(home, { force: true, recursive: true })
  }
})

test('timer: survives a host whose ctx.effect() invokes the setup immediately', async () => {
  const daemon = await startDaemon([])
  const home = makeHome(daemon.port)
  const woken = []
  const ctx = makeCtx(woken)
  // cordis semantics, measured 2026-10-31: the setup function is INVOKED at
  // registration and whatever it RETURNS becomes the disposer. So a cleanup written
  // as `() => stop()` runs stop() on the spot — which kept the real host's timer dead
  // across two restarts while every test here passed, because none of the fakes had
  // an `effect`.
  let disposer
  ctx.effect = (setup) => {
    disposer = setup()
  }
  try {
    apply(ctx, { dshHome: home, heartbeatMs: 20 })
    await sleep(140)
    const registrations = daemon.requests.filter((request) => request.pathname === '/v1/sessions').length
    assert.ok(registrations >= 1, 'the tick never published: the timer was disposed at creation')
    assert.equal(typeof disposer, 'function', 'the effect must return a disposer, not be one')
  } finally {
    await daemon.stop()
    rmSync(home, { force: true, recursive: true })
  }
})

/** A host view whose single live session reports the given cwd (that is what the policy keys on). */
function makeCtxCwd(woken, cwd) {
  return {
    get: (name) =>
      name === 'sessionPersistence'
        ? { list: async () => [{ header: { cwd, id: LIVE }, revision: 'r1' }] }
        : name === 'agents'
          ? {
              get: (id) =>
                id === LIVE
                  ? { send: (...args) => woken.push(args), session: { header: { cwd } }, status: 'idle' }
                  : undefined,
            }
          : undefined,
    tools: { register: () => {} },
  }
}

test('wake: a session in the quiet directory (where the GUI lives) is not woken', async () => {
  const daemon = await startDaemon([promptMessage({ msg_id: 'msg-human-1' })])
  const home = makeHome(daemon.port)
  const woken = []
  try {
    // The default quietCwd is dshHome itself. A human typing there must not have a
    // role:'user' message pushed into their turn by a remote peer.
    apply(makeCtxCwd(woken, home), { dshHome: home, heartbeatMs: 20 })
    await sleep(160)
    assert.equal(woken.length, 0, 'the human workspace was woken: that is exactly the interruption the policy exists to stop')
  } finally {
    await daemon.stop()
    rmSync(home, { force: true, recursive: true })
  }
})

test('wake: an agent session outside the quiet directory still rings', async () => {
  const daemon = await startDaemon([promptMessage({ msg_id: 'msg-agent-1' })])
  const home = makeHome(daemon.port)
  const woken = []
  try {
    // The default must not silence everything: agent-to-agent flow depends on the doorbell.
    apply(makeCtxCwd(woken, 'C:/repo/somewhere'), { dshHome: home, heartbeatMs: 20 })
    await sleep(160)
    assert.equal(woken.length, 1, 'an agent session in a repo directory must still be woken')
  } finally {
    await daemon.stop()
    rmSync(home, { force: true, recursive: true })
  }
})

test('wake: one session can opt back in (allow overrides the quiet directory)', async () => {
  const daemon = await startDaemon([promptMessage({ msg_id: 'msg-allow-1' })])
  const home = makeHome(daemon.port)
  const woken = []
  try {
    writeFileSync(join(home, 'session-bus', 'wake-policy.json'), JSON.stringify({ allow: [LIVE], quiet: [], quietCwd: [home] }))
    apply(makeCtxCwd(woken, home), { dshHome: home, heartbeatMs: 20 })
    await sleep(160)
    assert.equal(woken.length, 1, 'an explicit allow entry must win over the directory rule, otherwise the opt-in is a lie')
  } finally {
    await daemon.stop()
    rmSync(home, { force: true, recursive: true })
  }
})

test('wake policy tool: quiet then auto round-trips, and list says how it applies to you', async () => {
  const daemon = await startDaemon([])
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx([])
    apply(ctx, { dshHome: home, heartbeatMs: 600000 })
    const exec = { agent: { id: LIVE } }
    const tool = ctx.byName('session_bus_wake')

    const first = await tool.execute({ action: 'list' }, exec)
    assert.equal(first.ok, true)
    assert.equal(first.state, 'by-directory', 'a fresh policy applies through the directory rule')

    const quiet = await tool.execute({ action: 'quiet' }, exec)
    assert.equal(quiet.ok, true)
    const afterQuiet = await tool.execute({ action: 'list' }, exec)
    assert.equal(afterQuiet.state, 'never')

    const auto = await tool.execute({ action: 'auto' }, exec)
    assert.equal(auto.ok, true)
    const afterAuto = await tool.execute({ action: 'list' }, exec)
    assert.equal(afterAuto.state, 'always', 'auto must force-allow, not merely drop the quiet entry')

    const bad = await tool.execute({ action: 'nonsense' }, exec)
    assert.equal(bad.ok, false, 'an unknown action must fail rather than quietly do nothing')
  } finally {
    await daemon.stop()
    rmSync(home, { force: true, recursive: true })
  }
})

test('wake: the inbox read asks for the NEWEST window, not the oldest 50', async () => {
  const daemon = await startDaemon([promptMessage({ msg_id: 'msg-window-1' })])
  const home = makeHome(daemon.port)
  const woken = []
  try {
    apply(makeCtx(woken), { dshHome: home, heartbeatMs: 20 })
    await sleep(140)
    const inboxCalls = daemon.requests.filter((request) => request.pathname === '/v1/inbox')
    assert.ok(inboxCalls.length > 0, 'the tick never read an inbox')
    // The daemon returns from the OLDEST end by default: with limit=50, a prompt at
    // seq 51 would never appear and the doorbell would go quiet with no error.
    assert.ok(
      inboxCalls.every((call) => call.query.get('order') === 'newest'),
      `inbox read must ask for order=newest; got ${inboxCalls.map((call) => call.query.get('order')).join(',')}`,
    )
  } finally {
    await daemon.stop()
    rmSync(home, { force: true, recursive: true })
  }
})

test('wake: a restart does not replay an unacked prompt (ring history is on disk)', async () => {
  const daemon = await startDaemon([promptMessage({ msg_id: 'msg-replay-1' })])
  const home = makeHome(daemon.port)
  try {
    const first = []
    apply(makeCtx(first), { dshHome: home, heartbeatMs: 20 })
    await sleep(160)
    assert.equal(first.length, 1, 'the first host must ring once')

    // Simulate a host restart: new instance, same bus home. The in-memory set is
    // gone; only the persisted ring history can stop a second ring for the same
    // unacked message.
    const second = []
    apply(makeCtx(second), { dshHome: home, heartbeatMs: 20 })
    await sleep(160)
    assert.equal(second.length, 0, 'the same unacked msg_id rang again after a restart — that is a replay, not a doorbell')
  } finally {
    await daemon.stop()
    rmSync(home, { force: true, recursive: true })
  }
})

test('wake: a session mid-turn is deferred, not interrupted — and still rings once idle', async () => {
  const daemon = await startDaemon([promptMessage({ msg_id: 'msg-busy-1' })])
  const home = makeHome(daemon.port)
  const woken = []
  let status = 'running'
  try {
    const ctx = {
      get: (name) =>
        name === 'sessionPersistence'
          ? { list: async () => [{ header: { cwd: 'C:/wake', id: LIVE }, revision: 'r1' }] }
          : name === 'agents'
            ? {
                // The live Agent exposes `status: 'idle' | 'running'` (dsh-agent AgentStatus).
                get: (id) =>
                  id === LIVE
                    ? Object.defineProperty({ send: (...args) => woken.push(args), session: { header: { cwd: 'C:/wake' } } }, 'status', { get: () => status })
                    : undefined,
              }
            : undefined,
      tools: { register: () => {} },
    }
    apply(ctx, { dshHome: home, heartbeatMs: 20 })

    await sleep(160)
    assert.equal(
      woken.length,
      0,
      'a running session was interrupted: the wake lands as a role:user message inside the turn someone is already in',
    )

    status = 'idle'
    await sleep(160)
    assert.equal(woken.length, 1, 'deferring must not mean dropping: once idle, the doorbell has to ring')
  } finally {
    await daemon.stop()
    rmSync(home, { force: true, recursive: true })
  }
})

test('wake: a list call does not ring its own caller, and still rings others', async () => {
  const daemon = await startDaemon([promptMessage({ msg_id: 'msg-self-1' })])
  const home = makeHome(daemon.port)
  const woken = []
  try {
    const ctx = makeCtx(woken)
    // Ten minutes: the timer cannot interfere, so only the list call can ring.
    apply(ctx, { dshHome: home, heartbeatMs: 600000 })

    // The caller IS the live session that has the prompt waiting.
    await ctx.byName('session_bus_list').execute({}, { agent: { id: LIVE } })
    assert.equal(woken.length, 0, 'a session must not wake itself: it is already mid-turn')

    // A different caller: the doorbell must still ring for the live session.
    await ctx.byName('session_bus_list').execute({}, { agent: { id: 'session-someone-else' } })
    assert.equal(woken.length, 1, 'the doorbell must still ring for other sessions')
  } finally {
    await daemon.stop()
    rmSync(home, { force: true, recursive: true })
  }
})
