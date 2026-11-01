/**
 * Regression: a service method must keep its receiver.
 *
 * Measured on the live host (2026-10-30). The published view used to hold
 * `{ list: persistence.list }` — a copy of the method with no `this`. It type-checked,
 * passed a `typeof === 'function'` guard, and then threw on the first call:
 *
 *   sessionPersistence.list() failed: Cannot read properties of undefined (reading 'pendingEntries')
 *
 * The live store reads its own state off `this`, so detaching the method was enough
 * to break it. This file exists because the other tests' fakes are arrow functions
 * and therefore *cannot* catch this class of bug: they never touch `this`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../dist/index.js'

const SESSION = 'session-receiver-0000'

function makeCtx() {
  const tools = []
  tools.register = (tool) => tools.push(tool)
  return {
    byName: (name) => {
      const tool = tools.find((candidate) => candidate.name === name)
      assert.ok(tool, `tool ${name} was not registered`)
      return tool
    },
    tools,
  }
}

function makeHome(port) {
  const home = mkdtempSync(join(tmpdir(), 'session-bus-receiver-'))
  const busDir = join(home, 'session-bus')
  mkdirSync(busDir, { recursive: true })
  writeFileSync(join(busDir, 'port'), `${port}\n`)
  writeFileSync(join(busDir, 'token'), 'receiver-token\n')
  return home
}

async function startDaemon() {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push({ body: raw === '' ? undefined : JSON.parse(raw), method: req.method, url: new URL(req.url, 'http://127.0.0.1') })
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: true, sessions: [] }))
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return { port: server.address().port, requests, stop: () => new Promise((done) => server.close(done)) }
}

test('publish: service methods are called with their own receiver', async () => {
  const daemon = await startDaemon()
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    // Both objects are `this`-dependent on purpose: that is what the real stores do.
    const persistence = {
      async list() {
        return this.rows
      },
      rows: [{ cwd: 'C:/from-store', id: SESSION }],
    }
    const agents = {
      get(id) {
        return this.live.has(id) ? { session: { header: { cwd: 'C:/from-agent' } } } : undefined
      },
      live: new Set([SESSION]),
    }
    ctx.get = (name) => (name === 'sessionPersistence' ? persistence : name === 'agents' ? agents : undefined)

    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_list').execute({}, { agent: { id: SESSION } })

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.publication.error, null, `publish must not fail: ${result.publication.error}`)
    assert.equal(result.publication.published, 1, 'the live session should have been published')
    assert.equal(result.publication.headers, 1)

    const published = daemon.requests.filter((request) => request.url.pathname === '/v1/sessions' && request.method === 'POST')
    // The same session is registered twice on purpose: the self-heartbeat in
    // `prepare()` (cwd unknown, so '') and the host-view publisher (cwd from the
    // live agent). The upsert makes that harmless; what matters is that the
    // published row carries the real cwd.
    const mine = published.filter((request) => request.body?.session_id === SESSION)
    assert.ok(mine.length >= 1, 'the session was never registered')
    assert.ok(
      mine.some((request) => request.body.cwd === 'C:/from-agent'),
      `no registration carried the live agent cwd: ${JSON.stringify(mine.map((request) => request.body))}`,
    )
    assert.ok(mine.every((request) => request.body.alive === true), 'every registration must declare alive:true')
  } finally {
    await daemon.stop()
    rmSync(home, { force: true, recursive: true })
  }
})

test('publish: a throwing store is reported, not swallowed', async () => {
  const daemon = await startDaemon()
  const home = makeHome(daemon.port)
  try {
    const ctx = makeCtx()
    ctx.get = (name) =>
      name === 'sessionPersistence'
        ? {
            async list() {
              throw new Error('store offline')
            },
          }
        : { get: () => undefined }

    apply(ctx, { dshHome: home })
    const result = await ctx.byName('session_bus_list').execute({}, { agent: { id: SESSION } })
    assert.equal(result.publication.published, 0)
    assert.match(result.publication.error, /store offline/, 'the reason must reach the caller: a bare 0 cannot be debugged')
  } finally {
    await daemon.stop()
    rmSync(home, { force: true, recursive: true })
  }
})
