/**
 * Probe tests: the image bytes, the request shapes, and the verdict rules —
 * against a fake endpoint that "sees" by matching the bytes it was sent.
 *
 *   node test/probe.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { PALETTE, IMAGE_URLS, solidPng, pickColours, namedColours, probeRequest, replyText, probeVision } from '../lib/probe.js'

test('the probe image is a real, deterministic PNG', () => {
  const png = solidPng([10, 20, 30], 8)
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.ok(png.includes(Buffer.from('IHDR', 'ascii')))
  assert.ok(png.includes(Buffer.from('IDAT', 'ascii')))
  assert.ok(png.includes(Buffer.from('IEND', 'ascii')))
  assert.ok(png.length > 60)
  assert.deepEqual(solidPng([10, 20, 30], 8), png, 'same input, same bytes')
  assert.notDeepEqual(solidPng([30, 20, 10], 8), png)
})

test('every palette colour has a data URL', () => {
  for (const entry of PALETTE) {
    assert.match(IMAGE_URLS[entry.name], /^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
  }
})

test('pickColours never repeats and honours the count', () => {
  for (let round = 0; round < 20; round += 1) {
    const picked = pickColours(2).map((entry) => entry.name)
    assert.equal(new Set(picked).size, picked.length)
  }
  assert.equal(pickColours(99).length, PALETTE.length)
})

test('namedColours understands both languages', () => {
  assert.deepEqual(namedColours('Red'), ['red'])
  assert.deepEqual(namedColours('这张图是红色的。'), ['red'])
  assert.deepEqual(namedColours('blue-ish, maybe green'), ['green', 'blue'])
  assert.deepEqual(namedColours('purple'), [])
  assert.deepEqual(namedColours(''), [])
})

test('probeRequest speaks each protocol, and refuses the one it cannot', () => {
  const chat = probeRequest('openai-completions', 'http://h/v1', 'm', 'data:image/png;base64,AAA')
  assert.equal(chat.url, 'http://h/v1/chat/completions')
  assert.equal(chat.body.messages[0].content[1].image_url.url, 'data:image/png;base64,AAA')
  assert.equal(chat.body.stream, false)

  const messages = probeRequest('anthropic-messages', 'http://h/v1', 'm', 'data:image/png;base64,AAA')
  assert.equal(messages.url, 'http://h/v1/messages')
  assert.equal(messages.body.messages[0].content[0].source.data, 'AAA')
  assert.equal(messages.body.messages[0].content[0].source.media_type, 'image/png')

  assert.equal(probeRequest('openai-responses', 'http://h/v1', 'm', 'data:'), undefined)
})

test('replyText reads every reply shape', () => {
  assert.equal(replyText({ choices: [{ message: { content: 'red' } }] }), 'red')
  assert.equal(replyText({ choices: [{ message: { content: [{ type: 'text', text: 'red' }] } }] }), 'red')
  assert.equal(replyText({ content: [{ type: 'text', text: 'red' }] }), 'red')
  assert.equal(replyText({ output_text: 'red' }), 'red')
  assert.equal(replyText({}), '')
})

/* ── verdicts against a fake endpoint ─────────────────────────────────────── */

/** Which colour a data URL actually carries, by matching the bytes we sent. */
function colourOf(url) {
  const entry = Object.entries(IMAGE_URLS).find(([, value]) => value === url)
  return entry === undefined ? undefined : entry[0]
}

/**
 * A fake OpenAI-compatible endpoint.
 * @param answer - `(colour) => {status, body}` decides the reply.
 */
async function endpoint(answer) {
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      body = {}
    }
    const imageUrl = body?.messages?.[0]?.content?.find?.((part) => part?.type === 'image_url')?.image_url?.url
      ?? 'data:image/png;base64,' + (body?.messages?.[0]?.content?.find?.((part) => part?.type === 'image')?.source?.data ?? '')
    const colour = colourOf(imageUrl)
    const reply = answer(colour)
    response.writeHead(reply.status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(reply.body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((resolve) => server.close(resolve)) }
}

const say = (text) => ({ status: 200, body: { choices: [{ message: { content: text } }] } })

test('a model that names the colour it was shown sees images', async () => {
  const net = await endpoint((colour) => say(colour ?? 'no idea'))
  try {
    const result = await probeVision({ api: 'openai-completions', baseURL: net.baseURL, model: 'm', rounds: 2, timeoutMs: 3000 })
    assert.equal(result.verdict, true)
    assert.equal(result.evidence.filter((line) => line.startsWith('asked')).length, 2)
  } finally {
    await net.close()
  }
})

test('a model that names a different colour is blind', async () => {
  const net = await endpoint(() => say('purple'))
  try {
    const result = await probeVision({ api: 'openai-completions', baseURL: net.baseURL, model: 'm', rounds: 2, timeoutMs: 3000 })
    assert.equal(result.verdict, false)
  } finally {
    await net.close()
  }
})

test('an endpoint that refuses images is blind, not broken', async () => {
  const net = await endpoint(() => ({ status: 400, body: { error: { message: 'this model does not support image input' } } }))
  try {
    const result = await probeVision({ api: 'openai-completions', baseURL: net.baseURL, model: 'm', timeoutMs: 3000 })
    assert.equal(result.verdict, false)
    assert.match(result.evidence.at(-1), /refused images/)
  } finally {
    await net.close()
  }
})

test('a server error says nothing about vision', async () => {
  const net = await endpoint(() => ({ status: 500, body: { error: 'boom' } }))
  try {
    assert.equal((await probeVision({ api: 'openai-completions', baseURL: net.baseURL, model: 'm', timeoutMs: 3000 })).verdict, undefined)
  } finally {
    await net.close()
  }
})

test('a reply that names no colour is inconclusive, never "text only"', async () => {
  const net = await endpoint(() => say("I'm not able to see the image, sorry."))
  try {
    assert.equal((await probeVision({ api: 'openai-completions', baseURL: net.baseURL, model: 'm', rounds: 2, timeoutMs: 3000 })).verdict, undefined)
  } finally {
    await net.close()
  }
})

test('a dead endpoint is inconclusive', async () => {
  const result = await probeVision({ api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', model: 'm', timeoutMs: 600 })
  assert.equal(result.verdict, undefined)
  assert.match(result.evidence.at(-1), /network:/)
})
