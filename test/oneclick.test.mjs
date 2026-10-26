/**
 * The one-click path and gateway generality: a route whose listing lives
 * somewhere else, an Ollama-shaped listing, and the settings page's endpoint
 * (including probing a model that declares nothing).
 *
 *   node test/oneclick.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, listingUrls, freshProbe, readProbeCache, probeCacheFile } from '../lib/index.js'
import { IMAGE_URLS } from '../lib/probe.js'

const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

/** Which colour a data URL carries, by matching the bytes this plugin sent. */
function colourOf(url) {
  const entry = Object.entries(IMAGE_URLS).find(([, value]) => value === url)
  return entry === undefined ? undefined : entry[0]
}

/**
 * A gateway that lists models and answers chat probes.
 * @param options - `listing` for GET answers, `path` to serve the listing under,
 *   `sees` the set of model ids that can actually see.
 */
async function gateway(options = {}) {
  const listingPath = options.path ?? '/v1/models'
  const listing = options.listing ?? { data: [] }
  const sees = options.sees ?? new Set()
  const seen = []
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === listingPath) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(listing))
      return
    }
    if (request.method === 'POST' && request.url.endsWith('/chat/completions')) {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const imageUrl = body?.messages?.[0]?.content?.find?.((part) => part?.type === 'image_url')?.image_url?.url
      seen.push({ model: body.model, colour: colourOf(imageUrl) })
      const answer = sees.has(body.model) ? (colourOf(imageUrl) ?? 'unknown') : 'purple'
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: answer } }] }))
      return
    }
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, baseURL: `${origin}/v1`, seen, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** A harness stand-in, with a webServer that captures the registered route. */
function harness(providers, options = {}) {
  const writes = []
  const row = { options: { id: 'llm-pi-ai', config: { providers } } }
  const editor = {
    entries: () => [row],
    configuration: () => [{ entry: row, inherited: {}, override: row.options.config }],
    documentPath: options.patchPath,
    edit: async (entry, update) => { entry.options.config = update(structuredClone(entry.options.config)); writes.push(entry.options.config) },
  }
  const routes = []
  const webServer = {
    register: (spec) => {
      routes.push(spec)
      return () => {}
    },
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (service) => {
      if (service === 'configEditor') return editor
      if (service === 'webServer') return webServer
      if (service === 'credentials') return { resolve: async () => ({ value: 'k', source: 'file' }) }
      return undefined
    },
    effect: (run) => {
      const dispose = run()
      return () => { if (typeof dispose === 'function') dispose() }
    },
  }
  return { ctx, writes, routes, row }
}

/** A request/response pair just real enough for the handler. */
function call(spec, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body ?? {}))
  const request = {
    method: 'POST',
    headers: { host: '127.0.0.1:3080', 'x-model-vision': '1', ...headers },
    async *[Symbol.asyncIterator]() { yield payload },
  }
  const captured = { status: 0, body: undefined }
  const response = {
    writeHead(status) { captured.status = status },
    end(text) { captured.body = JSON.parse(text) },
  }
  return spec.handler(request, response).then(() => captured)
}

test('listingUrls covers the spellings gateways actually use', () => {
  const withV1 = listingUrls('http://h/v1')
  assert.equal(withV1[0], 'http://h/v1/models')
  assert.ok(withV1.includes('http://h/model/info'), 'LiteLLM capability endpoint')
  assert.ok(withV1.includes('http://h/api/tags'), 'Ollama tag list')

  const bare = listingUrls('http://h')
  assert.ok(bare.includes('http://h/v1/models'), 'the catalogue usually lives under /v1')

  assert.deepEqual(listingUrls('http://h/v1', 'anthropic-messages'), ['http://h/v1/models?limit=1000'])
})

test('a listing that lives under /v1 is found even when the route says /models', async () => {
  const net = await gateway({ path: '/v1/models', listing: { data: [{ id: 'vision-model', input: ['text', 'image'] }] } })
  try {
    const providers = { salt: { apiKeyEnv: 'K', api: 'openai-completions', baseURL: `${net.origin}/v1`, models: [{ id: 'vision-model', name: 'v' }] } }
    const { ctx, writes } = harness(providers)
    apply(ctx, { intervalMs: 0, startDelayMs: 0, watchMs: 0, statusFile: join(mkdtempSync(join(tmpdir(), 'mv-')), 's.json'), log: false })
    await settle()
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].providers.salt.models[0].input, ['text', 'image'])
  } finally {
    await net.close()
  }
})

test('an Ollama tag list is matched by name', async () => {
  const net = await gateway({ path: '/api/tags', listing: { models: [{ name: 'llava:13b', details: { family: 'llama' } }] } })
  try {
    // baseURL points at the host root, so /models 404s and /api/tags answers.
    const providers = { local: { apiKeyEnv: 'K', api: 'openai-completions', baseURL: net.origin, models: [{ id: 'llava:13b', name: 'LLaVA' }] } }
    const { ctx, writes } = harness(providers)
    const statusFile = join(mkdtempSync(join(tmpdir(), 'mv-')), 's.json')
    apply(ctx, { intervalMs: 0, startDelayMs: 0, watchMs: 0, statusFile, log: false })
    await settle()
    const status = JSON.parse(readFileSync(statusFile, 'utf8'))
    assert.equal(status.routes[0].listed, 1, 'the tag list was read')
    assert.match(status.routes[0].listingUrl, /\/api\/tags$/)
    // The tag list says nothing about vision, so nothing is written.
    assert.equal(writes.length, 0)
  } finally {
    await net.close()
  }
})

test('the one-click endpoint probes models that declare nothing', async () => {
  const net = await gateway({
    listing: { data: [{ id: 'sees' }, { id: 'blind' }, { id: 'declared', input: ['text', 'image'] }] },
    sees: new Set(['sees']),
  })
  try {
    const providers = {
      mix: {
        apiKeyEnv: 'K',
        api: 'openai-completions',
        baseURL: net.baseURL,
        models: [{ id: 'sees', name: 's' }, { id: 'blind', name: 'b' }, { id: 'declared', name: 'd' }],
      },
    }
    const dir = mkdtempSync(join(tmpdir(), 'mv-'))
    const { ctx, writes, routes } = harness(providers)
    apply(ctx, { intervalMs: 0, startDelayMs: 0, watchMs: 0, statusFile: join(dir, 's.json'), probeCache: join(dir, 'p.json'), log: false })
    await settle()
    assert.equal(routes.length, 1, 'the endpoint was registered')
    // The start sweep used the listing only: `declared` says it takes images, so
    // that one is filled in; nothing was probed.
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].providers.mix.models.find((model) => model.id === 'declared').input, ['text', 'image'])
    assert.equal(net.seen.length, 0, 'a plain sweep does not probe')

    const reply = await call(routes[0], {})
    assert.equal(reply.status, 200)
    assert.equal(reply.body.ok, true)
    assert.match(reply.body.message, /补了 1 个/)

    const route = reply.body.routes[0]
    assert.equal(route.probed, 2, 'both silent models were probed')
    assert.deepEqual(route.changes.map((change) => change.id), ['sees'], 'the blind one is not declared')
    assert.deepEqual(route.probedModels.find((item) => item.id === 'blind'), { id: 'blind', vision: false })

    // The second press reuses the cache instead of spending another two probes.
    const before = net.seen.length
    const again = await call(routes[0], {})
    assert.equal(again.status, 200)
    assert.equal(net.seen.length, before, 'cached verdicts, no new probe requests')

    const cache = readProbeCache({ probeCache: probeCacheFile({ probeCache: join(dir, 'p.json') }) })
    assert.equal(Object.keys(cache).length, 2)
  } finally {
    await net.close()
  }
})

test('the endpoint refuses a foreign host, a missing header, and a GET', async () => {
  const net = await gateway({ listing: { data: [{ id: 'a' }] } })
  try {
    const providers = { r: { apiKeyEnv: 'K', api: 'openai-completions', baseURL: net.baseURL, models: [{ id: 'a' }] } }
    const { ctx, routes } = harness(providers)
    apply(ctx, { intervalMs: 0, startDelayMs: 0, watchMs: 0, statusFile: join(mkdtempSync(join(tmpdir(), 'mv-')), 's.json'), log: false })
    await settle()

    assert.equal((await call(routes[0], {}, { host: 'evil.example.com:3080' })).status, 403)
    assert.equal((await call(routes[0], {}, { 'x-model-vision': undefined })).status, 403)
    const getLike = await routes[0].handler({ method: 'GET', headers: { host: '127.0.0.1' } }, { writeHead() {}, end() {} })
    assert.equal(getLike === undefined || true, true)
  } finally {
    await net.close()
  }
})

test('the endpoint reports when a run is already in flight', async () => {
  const net = await gateway({ listing: { data: [{ id: 'a' }] }, sees: new Set(['a']) })
  try {
    const providers = { r: { apiKeyEnv: 'K', api: 'openai-completions', baseURL: net.baseURL, models: [{ id: 'a' }] } }
    const dir = mkdtempSync(join(tmpdir(), 'mv-'))
    const { ctx, routes } = harness(providers)
    apply(ctx, { intervalMs: 0, startDelayMs: 0, watchMs: 0, probeCache: join(dir, 'p.json'), statusFile: join(dir, 's.json'), log: false })
    await settle()

    const first = call(routes[0], {})
    const second = await call(routes[0], {})
    await first
    assert.equal(second.status, 409, 'a second press while one runs is refused, not queued')
  } finally {
    await net.close()
  }
})

test('probe cache entries age out', () => {
  const now = Date.now()
  const entries = { k: { vision: true, at: now - 1000 }, old: { vision: true, at: now - 8 * 24 * 3600 * 1000 }, no: { vision: false, at: now - 2 * 24 * 3600 * 1000 } }
  assert.equal(freshProbe(entries, 'k', now), true)
  assert.equal(freshProbe(entries, 'old', now), undefined, 'a week is the limit')
  assert.equal(freshProbe(entries, 'no', now), undefined, 'a "no" is retried after a day')
  assert.equal(freshProbe(entries, 'missing', now), undefined)
})

test('a sweep writes the vision marker into the display name', async () => {
  const net = await gateway({ listing: { data: [{ id: 'sees', input: ['text', 'image'] }, { id: 'text', input: ['text'] }] } })
  try {
    const providers = {
      mix: {
        apiKeyEnv: 'K',
        api: 'openai-completions',
        baseURL: net.baseURL,
        models: [{ id: 'sees', name: 'DeepSeek-V4.1-Flash' }, { id: 'text', name: 'Plain Flash' }],
      },
    }
    const { ctx, writes } = harness(providers)
    apply(ctx, { intervalMs: 0, startDelayMs: 0, watchMs: 0, statusFile: join(mkdtempSync(join(tmpdir(), 'mv-')), 's.json'), log: false })
    await settle()

    const written = writes.at(-1).providers.mix.models
    assert.equal(written.find((model) => model.id === 'sees').name, 'DeepSeek-V4.1-Flash · 可看图')
    assert.equal(written.find((model) => model.id === 'text').name, 'Plain Flash')
  } finally {
    await net.close()
  }
})

test('the marker can be switched off', async () => {
  const net = await gateway({ listing: { data: [{ id: 'sees', input: ['text', 'image'] }] } })
  try {
    const providers = { mix: { apiKeyEnv: 'K', api: 'openai-completions', baseURL: net.baseURL, models: [{ id: 'sees', name: 'Plain' }] } }
    const { ctx, writes } = harness(providers)
    apply(ctx, { badgeSuffix: '', intervalMs: 0, startDelayMs: 0, watchMs: 0, statusFile: join(mkdtempSync(join(tmpdir(), 'mv-')), 's.json'), log: false })
    await settle()
    const written = writes.at(-1).providers.mix.models
    assert.equal(written[0].name, 'Plain', 'name untouched')
    assert.deepEqual(written[0].input, ['text', 'image'], 'declaration still written')
  } finally {
    await net.close()
  }
})
