/**
 * Wiring tests: run the real `apply()` against a fake harness and a local HTTP
 * gateway. No DSH process, no real profile — but the same code path a mounted
 * plugin takes, including both write channels.
 *
 *   node test/wiring.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, readCredentialRef, resolveCredential } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => join(here, 'fixtures', name)
const listing = readFileSync(fixture('ofm-models.json'), 'utf8')

/** A gateway that answers `GET /v1/models` with the recorded OFM listing. */
async function gateway() {
  const server = createServer((request, response) => {
    if (request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(listing)
      return
    }
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { baseURL: `http://127.0.0.1:${port}/v1`, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** The models one route declares, mirroring a fetched list with no `input`. */
const declaredModels = [
  { id: 'trae/deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', contextWindow: 1048576 },
  { id: 'raccoon/sn-deepseek-v4-1-flash-1017', name: 'DeepSeek-V4.1-Flash-1017 · 免费', contextWindow: 1000000, maxTokens: 100000 },
  { id: 'lobsterai/deepseek-flash', name: 'DeepSeek-V4.1-Flash · x0.05', contextWindow: 1000000 },
  { id: 'buddy/deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.11', contextWindow: 1000000, input: ['text'] },
]

/**
 * A harness stand-in with the services this plugin actually asks for.
 * @param baseURL - where the route points.
 * @param options - `editError` to force the patch-file fallback, `patchPath` for it.
 */
function harness(baseURL, options = {}) {
  const patches = []
  const row = {
    options: { id: 'llm-pi-ai', config: { providers: { salt: { apiKeyEnv: 'TEST_KEY', api: 'openai-completions', baseURL, models: declaredModels } } } },
  }
  const editor = {
    entries: () => [row],
    configuration: () => [{ entry: row, inherited: {}, override: row.options.config }],
    documentPath: options.patchPath,
    edit: async (entry, update) => {
      if (options.editError !== undefined) throw new Error(options.editError)
      const next = update(structuredClone(entry.options.config))
      patches.push(structuredClone(next.providers.salt.models))
    },
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (service) => {
      if (service === 'configEditor') return editor
      if (service === 'credentials') return { resolve: async () => ({ value: 'test-key' }) }
      if (service === 'profileContext' && options.profile !== undefined) return { name: options.profile }
      return undefined
    },
    effect: (run) => {
      const dispose = run()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
  return { ctx, patches }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 120))

test('a sweep writes input for the routes the gateway serves images on', async () => {
  const net = await gateway()
  try {
    const statusFile = join(mkdtempSync(join(tmpdir(), 'model-vision-wire-')), 'status.json')
    const { ctx, patches } = harness(net.baseURL)
    apply(ctx, { intervalMs: 0, startDelayMs: 0, statusFile, log: false })
    await settle()

    assert.equal(patches.length, 1, 'exactly one write')
    const written = patches[0]
    const byId = Object.fromEntries(written.map((model) => [model.id, model]))
    assert.deepEqual(byId['trae/deepseek-v4.1-flash'].input, ['text', 'image'])
    assert.equal(byId['raccoon/sn-deepseek-v4-1-flash-1017'].input, undefined, 'text-only route untouched')
    assert.equal(byId['lobsterai/deepseek-flash'].input, undefined, 'silent route untouched')
    assert.deepEqual(byId['buddy/deepseek-v4.1-flash'].input, ['text'], 'explicit declaration respected in fill mode')

    const status = JSON.parse(readFileSync(statusFile, 'utf8'))
    assert.equal(status.phase, 'sweep')
    assert.equal(status.via, 'config-editor')
    assert.equal(status.wrote, true)
    assert.equal(status.routes[0].listed, 10)
    assert.deepEqual(
      status.routes[0].changes.map((change) => ({ id: change.id, to: change.to })),
      [{ id: 'trae/deepseek-v4.1-flash', to: ['text', 'image'] }],
    )
    assert.deepEqual(status.routes[0].held, [{ id: 'buddy/deepseek-v4.1-flash', input: ['text'] }])
    assert.equal(status.error, null)
  } finally {
    await net.close()
  }
})

test('sync mode also corrects a stale declaration', async () => {
  const net = await gateway()
  try {
    const statusFile = join(mkdtempSync(join(tmpdir(), 'model-vision-wire-')), 'status.json')
    const { ctx, patches } = harness(net.baseURL)
    apply(ctx, { mode: 'sync', intervalMs: 0, startDelayMs: 0, statusFile, log: false })
    await settle()

    const byId = Object.fromEntries(patches[0].map((model) => [model.id, model]))
    assert.deepEqual(byId['buddy/deepseek-v4.1-flash'].input, ['text', 'image'])
  } finally {
    await net.close()
  }
})

test('dryRun plans everything and writes nothing', async () => {
  const net = await gateway()
  try {
    const statusFile = join(mkdtempSync(join(tmpdir(), 'model-vision-wire-')), 'status.json')
    const { ctx, patches } = harness(net.baseURL)
    apply(ctx, { dryRun: true, intervalMs: 0, startDelayMs: 0, statusFile, log: false })
    await settle()

    assert.equal(patches.length, 0, 'no write reached the editor')
    const status = JSON.parse(readFileSync(statusFile, 'utf8'))
    assert.equal(status.via, 'dry-run')
    assert.equal(status.wrote, false)
    assert.equal(status.routes[0].changes.length, 1, 'the plan is still recorded')
  } finally {
    await net.close()
  }
})

test('a hot-reloaded plugin falls back to the profile patch', async () => {
  const net = await gateway()
  try {
    const dir = mkdtempSync(join(tmpdir(), 'model-vision-wire-'))
    const patchPath = join(dir, 'cordis.patch.yml')
    copyFileSync(fixture('profile.patch.yml'), patchPath)
    const statusFile = join(dir, 'status.json')

    const { ctx, patches } = harness(net.baseURL, { editError: 'HMR transactions cannot be nested', patchPath })
    apply(ctx, { intervalMs: 0, startDelayMs: 0, statusFile, log: false })
    await settle()

    assert.equal(patches.length, 0, 'the editor refused, as a nested transaction does')
    const after = readFileSync(patchPath, 'utf8')
    assert.match(after, /- id: trae\/deepseek-v4\.1-flash\n            name: [^\n]+\n            contextWindow: 1048576\n            input:\n              - text\n              - image\n/)
    const status = JSON.parse(readFileSync(statusFile, 'utf8'))
    assert.equal(status.via, 'patch-file')
    assert.equal(status.wrote, true)
  } finally {
    await net.close()
  }
})

test('a gateway that is down leaves the profile alone and says why', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-vision-wire-'))
  const statusFile = join(dir, 'status.json')
  const { ctx, patches } = harness('http://127.0.0.1:9/v1')
  apply(ctx, { intervalMs: 0, startDelayMs: 0, timeoutMs: 800, statusFile, log: false })
  await settle()

  assert.equal(patches.length, 0)
  const status = JSON.parse(readFileSync(statusFile, 'utf8'))
  assert.equal(status.wrote, false)
  assert.match(status.routes[0].error, /answered|fetch failed|ECONNREFUSED/i)
})

test('a second sweep over an already-correct profile writes nothing', async () => {
  const net = await gateway()
  try {
    const dir = mkdtempSync(join(tmpdir(), 'model-vision-wire-'))
    const patchPath = join(dir, 'cordis.patch.yml')
    writeFileSync(patchPath, 'placeholder\n', 'utf8')
    const { ctx, patches } = harness(net.baseURL, { patchPath })
    const config = { intervalMs: 0, startDelayMs: 0, statusFile: join(dir, 'status.json'), log: false }

    apply(ctx, config)
    await settle()
    assert.equal(patches.length, 1)

    // Re-apply against the profile the first sweep produced: nothing left to do.
    const corrected = patches[0]
    const second = harness(net.baseURL, { patchPath })
    second.ctx.get('configEditor').configuration = () => [{
      entry: { options: { id: 'llm-pi-ai', config: { providers: { salt: { apiKeyEnv: 'TEST_KEY', api: 'openai-completions', baseURL: net.baseURL, models: corrected } } } } },
      inherited: {},
      override: { providers: { salt: { apiKeyEnv: 'TEST_KEY', api: 'openai-completions', baseURL: net.baseURL, models: corrected } } },
    }]
    second.ctx.get('configEditor').entries = () => [{ options: { id: 'llm-pi-ai', config: { providers: { salt: { models: corrected } } } } }]
    apply(second.ctx, config)
    await settle()
    assert.equal(second.patches.length, 0, 'idempotent')
  } finally {
    await net.close()
  }
})

/* ── credentials ──────────────────────────────────────────────────────────── */

test('a route credential falls back service -> env -> credentials file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-vision-cred-'))
  writeFileSync(join(dir, '.credentials.yaml'), [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    'refs:',
    '  GATEWAY_KEY: ofm-from-file',
    '  QUOTED_KEY: "ofm-quoted"',
    '',
  ].join('\n'), 'utf8')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    assert.equal(readCredentialRef('GATEWAY_KEY'), 'ofm-from-file')
    assert.equal(readCredentialRef('QUOTED_KEY'), 'ofm-quoted')
    assert.equal(readCredentialRef('NOPE'), undefined)

    // the service wins when it answers
    const withService = { get: () => ({ resolve: async () => ({ value: 'ofm-from-service', source: 'file' }) }) }
    assert.deepEqual(await resolveCredential(withService, 'GATEWAY_KEY'), { value: 'ofm-from-service', source: 'service:file' })

    // a service that says nothing falls through to the file, not to a bare request
    const emptyService = { get: () => ({ resolve: async () => undefined }) }
    assert.equal((await resolveCredential(emptyService, 'GATEWAY_KEY')).source, 'service:absent')

    // no service at all: env, then file
    process.env.MODEL_VISION_TEST_KEY = 'ofm-from-env'
    assert.deepEqual(await resolveCredential({ get: () => undefined }, 'MODEL_VISION_TEST_KEY'), { value: 'ofm-from-env', source: 'env' })
    assert.deepEqual(await resolveCredential({ get: () => undefined }, 'GATEWAY_KEY'), { value: 'ofm-from-file', source: 'file' })
    assert.equal((await resolveCredential({ get: () => undefined }, 'MISSING_KEY')).source, 'absent')
    delete process.env.MODEL_VISION_TEST_KEY
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a 401 names the credential source instead of just the status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-vision-cred-'))
  const statusFile = join(dir, 'status.json')
  // no credentials service, no env, no file => the sweep must say so
  const empty = { get: () => undefined }
  const baseURL = 'http://127.0.0.1:9/v1'
  const row = { options: { id: 'llm-pi-ai', config: { providers: { salt: { apiKeyEnv: 'NOPE_KEY', api: 'openai-completions', baseURL, models: [{ id: 'a/b' }] } } } } }
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (service) => (service === 'configEditor' ? { entries: () => [row], configuration: () => [{ entry: row, inherited: {}, override: row.options.config }], edit: async () => {} } : empty.get()),
    effect: (run) => { run() },
  }
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    apply(ctx, { intervalMs: 0, startDelayMs: 0, timeoutMs: 800, statusFile, log: false })
    await settle()
    const status = JSON.parse(readFileSync(statusFile, 'utf8'))
    assert.match(status.routes[0].error, /credential|answered|ECONNREFUSED|fetch failed/i)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a profile edit is noticed by the signature poll, not by a file watcher', async () => {
  const net = await gateway()
  try {
    const dir = mkdtempSync(join(tmpdir(), 'model-vision-watch-'))
    const statusFile = join(dir, 'status.json')
    const models = [{ id: 'trae/deepseek-v4.1-flash', name: 'x', contextWindow: 1048576 }]
    const providers = { salt: { apiKeyEnv: 'TEST_KEY', api: 'openai-completions', baseURL: net.baseURL, models } }
    const row = { options: { id: 'llm-pi-ai', config: { providers } } }
    const editor = {
      entries: () => [row],
      configuration: () => [{ entry: row, inherited: {}, override: row.options.config }],
      edit: async (entry, update) => { entry.options.config = update(structuredClone(entry.options.config)) },
    }
    const ctx = {
      logger: { info: () => {}, warn: () => {} },
      get: (service) => (service === 'configEditor' ? editor : undefined),
      effect: (run) => run(),
    }
    apply(ctx, { intervalMs: 0, startDelayMs: 0, watchMs: 25, statusFile, log: false })
    await settle()

    // The declaration the first sweep wrote is the poll's baseline.
    assert.deepEqual(row.options.config.providers.salt.models[0].input, ['text', 'image'])
    const before = JSON.parse(readFileSync(statusFile, 'utf8'))
    assert.equal(before.reason, 'start')

    // Simulate "Fetch available models" overwriting the declaration: drop it.
    // Resolve the live array each time: the editor's write replaces the objects.
    const live = () => row.options.config.providers.salt.models
    delete live()[0].input
    await new Promise((resolve) => setTimeout(resolve, 120))

    const after = JSON.parse(readFileSync(statusFile, 'utf8'))
    assert.equal(after.reason, 'config-change', 'the poll noticed the edit')
    assert.equal(after.wrote, true, 'and put the declaration back')
    assert.deepEqual(live()[0].input, ['text', 'image'])
  } finally {
    await net.close()
  }
})

test('two profiles writing the same DSH_HOME do not overwrite each other', async () => {
  // Every profile shares one DSH_HOME, so the default status file has to carry
  // the profile name: without it a second `dsh` boot replaces the running one's
  // record with its own pid and its own patch path.
  const net = await gateway()
  const home = mkdtempSync(join(tmpdir(), 'model-vision-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    for (const profile of ['web', 'desktop']) {
      const { ctx } = harness(net.baseURL, { profile })
      apply(ctx, { intervalMs: 0, startDelayMs: 0, log: false })
      await settle()
    }

    const web = JSON.parse(readFileSync(join(home, 'model-vision.web.status.json'), 'utf8'))
    const desktop = JSON.parse(readFileSync(join(home, 'model-vision.desktop.status.json'), 'utf8'))
    assert.equal(web.phase, 'sweep')
    assert.equal(desktop.phase, 'sweep')
    // Each document keeps its own pid, which is the thing a shared file destroyed.
    assert.notEqual(web.pid, undefined)
    assert.equal(existsSync(join(home, 'model-vision.status.json')), false, 'no shared file is written')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await net.close()
  }
})
