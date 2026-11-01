/**
 * Fuzz the parse boundary: the daemon is another team's process, so every
 * response body is untrusted input. The contract this test enforces is narrow
 * and absolute: NO input may make a tool throw. A predictable failure is a code;
 * an exception is a bug the caller cannot handle.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../dist/index.js'

const SESSION = 'session-fuzz-0000-1111-2222-333333333333'
const AGENT_EXEC = { agent: { id: SESSION } }

/** Deterministic PRNG so a failure is reproducible from the seed alone. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Bodies that are JSON-shaped but hostile to every field the plugin reads. */
const BODIES = [
  'null',
  '[]',
  '{}',
  '{"messages":null}',
  '{"messages":"not an array"}',
  '{"messages":{}}',
  '{"messages":[null]}',
  '{"messages":[{}]}',
  '{"messages":[{"acked_at":null}]}',
  '{"messages":[{"acked_at":0}]}',
  '{"messages":[{"acked_at":{"nested":true}}]}',
  '{"messages":[{"seq":"1","queued_at":[]}]}',
  '{"next_seq":-1}',
  '{"next_seq":"NaN"}',
  '{"msg_id":{},"seq":{}}',
  '{"session_id":123}',
  '{"registered":[]}',
  '{"code":42}',
  '\u0000\u0001\u0002',
  '',
]

async function withDaemon(body, status, run) {
  const server = createServer((_req, res) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(body)
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  const home = mkdtempSync(join(tmpdir(), 'session-bus-fuzz-'))
  const busDir = join(home, 'session-bus')
  mkdirSync(busDir, { recursive: true })
  writeFileSync(join(busDir, 'port'), `${port}\n`)
  writeFileSync(join(busDir, 'token'), 'fuzz-token\n')
  try {
    await run(home)
  } finally {
    await new Promise((done) => server.close(done))
    rmSync(home, { force: true, recursive: true })
  }
}

test('fuzz: no response body makes a tool throw', async () => {
  for (const body of BODIES) {
    for (const status of [200, 201, 500]) {
      await withDaemon(body, status, async (home) => {
        const tools = []
        tools.register = (tool) => tools.push(tool)
        apply({ tools }, { dshHome: home })

        for (const tool of tools) {
          let result
          try {
            result = await tool.execute({ body: 'x', limit: 1, since_seq: 0, to: 'peer', up_to_seq: 1 }, AGENT_EXEC)
          } catch (error) {
            assert.fail(`${tool.name} threw on ${JSON.stringify(body.slice(0, 40))} @${status}: ${error?.message}`)
          }
          assert.equal(typeof result, 'object', `${tool.name} must return an object, not a primitive`)
          assert.equal(typeof result.ok, 'boolean', `${tool.name} must answer a boolean ok`)
        }
      })
    }
  }
})

test('fuzz: random argument shapes are rejected or absorbed, never thrown', async () => {
  const random = mulberry32(0x5eed)
  const junk = () => {
    switch (Math.floor(random() * 6)) {
      case 0:
        return null
      case 1:
        return undefined
      case 2:
        return 'x'.repeat(Math.floor(random() * 40))
      case 3:
        return random() * 1e6
      case 4:
        return { nested: [1, 'two', null] }
      default:
        return random() < 0.5
    }
  }

  await withDaemon('{"messages":[],"next_seq":0}', 200, async (home) => {
    const tools = []
    tools.register = (tool) => tools.push(tool)
    apply({ tools }, { dshHome: home })

    for (let round = 0; round < 200; round += 1) {
      const args = { body: junk(), limit: junk(), since_seq: junk(), to: junk(), up_to_seq: junk() }
      for (const tool of tools) {
        try {
          const result = await tool.execute(args, AGENT_EXEC)
          assert.equal(typeof result.ok, 'boolean')
        } catch (error) {
          assert.fail(`${tool.name} threw on generated args ${JSON.stringify(args)}: ${error?.message}`)
        }
      }
    }
  })
})

test('fuzz: a missing or malformed exec context is reported, not thrown on', async () => {
  await withDaemon('{}', 200, async (home) => {
    const tools = []
    tools.register = (tool) => tools.push(tool)
    apply({ tools }, { dshHome: home })

    for (const exec of [undefined, null, {}, { agent: null }, { agent: {} }, { agent: { id: 42 } }, { agent: { id: '' } }]) {
      for (const tool of tools) {
        const result = await tool.execute({ body: 'x', to: 'peer', up_to_seq: 1 }, exec)
        assert.equal(typeof result.ok, 'boolean', `${tool.name} must survive exec=${JSON.stringify(exec)}`)
        if (result.ok) continue
        assert.equal(typeof result.code, 'string')
      }
    }
  })
})
