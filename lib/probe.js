/**
 * Active vision probe — ask the model itself whether it can see.
 *
 * Listing metadata is the cheap and preferred answer: a gateway that states its
 * modalities is believed and never probed. But plenty of gateways publish
 * nothing (self-hosted vLLM, LiteLLM without a config, most relays), and then
 * "silence" is all we have. This module settles that case by sending a real
 * image and checking that the answer names the colour it actually is.
 *
 * Why colours and why two rounds: a text-only model asked "what colour is this
 * image?" will often invent "red" — a single probe is a coin flip on a
 * four-colour palette. Two rounds with different colours cut that to ~1/16, and
 * a wrong colour is treated as proof of blindness rather than noise, because a
 * model that is guessing has no reason to name the one we sent.
 *
 * A reply that names no colour at all is *inconclusive*, never "text only": some
 * models answer with a sentence, and refusing to declare is always safer than
 * declaring a capability the endpoint will reject mid-turn.
 *
 * @module dsh-model-vision/probe
 */

import { deflateSync } from 'node:zlib'

/** Colours the probe can send, with the words that count as naming them. */
export const PALETTE = [
  { name: 'red', rgb: [220, 30, 30], words: ['red', '红'] },
  { name: 'green', rgb: [20, 160, 70], words: ['green', '绿'] },
  { name: 'blue', rgb: [30, 70, 200], words: ['blue', '蓝'] },
  { name: 'yellow', rgb: [225, 200, 40], words: ['yellow', '黄'] },
]

/**
 * Build a solid-colour PNG.
 *
 * Hand-rolled so the plugin keeps zero dependencies: one IHDR, one IDAT of
 * filter-0 scanlines, one IEND. 64×64 is large enough that a vision model has no
 * excuse and small enough to stay a few hundred bytes on the wire.
 *
 * @param rgb - `[r, g, b]`.
 * @param size - edge length in pixels.
 * @returns the PNG bytes.
 */
export function solidPng(rgb, size = 64) {
  const crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buffer) => {
    let c = 0xffffffff
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed), 0)
    return Buffer.concat([length, typed, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  const row = Buffer.alloc(1 + size * 3)
  for (let x = 0; x < size; x += 1) {
    row[1 + x * 3] = rgb[0]
    row[2 + x * 3] = rgb[1]
    row[3 + x * 3] = rgb[2]
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Data URLs for every palette entry, built once. */
export const IMAGE_URLS = Object.fromEntries(PALETTE.map((entry) => [entry.name, `data:image/png;base64,${solidPng(entry.rgb).toString('base64')}`]))

/**
 * Pick `count` distinct colours, in random order, so two runs never ask the same
 * question in the same sequence.
 * @param count - how many.
 * @returns palette entries.
 */
export function pickColours(count) {
  const pool = [...PALETTE]
  const picked = []
  for (let i = 0; i < count && pool.length > 0; i += 1) picked.push(...pool.splice(Math.floor(Math.random() * pool.length), 1))
  return picked
}

/**
 * Which palette colour (if any) a reply names.
 * @param text - the reply, already lowercased is fine too.
 * @returns the colour names mentioned.
 */
export function namedColours(text) {
  const lower = String(text ?? '').toLowerCase()
  return PALETTE.filter((entry) => entry.words.some((word) => lower.includes(word))).map((entry) => entry.name)
}

/**
 * Every colour word worth recognising, including colours this probe never sends.
 *
 * A model that answers "purple" when shown red has clearly not seen the image —
 * that is proof of blindness, not noise. Restricting the check to the four
 * palette colours would file "purple" under "said nothing" and lose the verdict.
 */
const OTHER_COLOURS = ['purple', 'orange', 'pink', 'brown', 'black', 'white', 'grey', 'gray', 'cyan', 'magenta', 'teal', 'violet', '紫', '橙', '粉', '黑', '白', '灰', '青']

/**
 * Does a reply name any colour at all?
 * @param text - the reply.
 * @returns whether a colour word appears.
 */
export function mentionsColour(text) {
  const lower = String(text ?? '').toLowerCase()
  return namedColours(lower).length > 0 || OTHER_COLOURS.some((word) => lower.includes(word))
}

/** Error bodies that mean "this endpoint cannot take images", not "it broke". */
const REFUSAL = /(image|vision|multimodal|unsupported|not support|invalid.*(content|type)|不支持|无法.*图)/i

/**
 * Build one probe request for the route's protocol.
 * @param api - the route's protocol.
 * @param baseURL - route base, without a trailing slash.
 * @param model - model id to ask.
 * @param imageUrl - data URL of the colour to send.
 * @returns `{ url, body }`, or `undefined` when this protocol cannot be probed.
 */
export function probeRequest(api, baseURL, model, imageUrl) {
  const prompt = 'What colour is this image? Answer with exactly one English colour word.'
  if (api === 'anthropic-messages') {
    return {
      url: `${baseURL}/messages`,
      body: {
        model,
        max_tokens: 8,
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageUrl.slice(imageUrl.indexOf(',') + 1) } }, { type: 'text', text: prompt }] }],
      },
    }
  }
  if (api === 'openai-completions' || api === undefined) {
    return {
      url: `${baseURL}/chat/completions`,
      body: {
        model,
        max_tokens: 8,
        temperature: 0,
        stream: false,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageUrl } }] }],
      },
    }
  }
  // `openai-responses` spells images differently and is left to the listing:
  // guessing a body shape on a route we cannot test would risk a false verdict.
  return undefined
}

/**
 * Read the assistant text out of either reply shape.
 * @param body - the parsed response.
 * @returns the text.
 */
export function replyText(body) {
  const choice = body?.choices?.[0]
  const content = choice?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join(' ')
  if (Array.isArray(body?.content)) return body.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join(' ')
  if (typeof body?.output_text === 'string') return body.output_text
  return ''
}

/**
 * Probe one model with real images.
 *
 * @param options - `api`, `baseURL`, `model`, `headers`, `timeoutMs`, `rounds`.
 * @returns `{ verdict, evidence }` where verdict is `true`, `false`, or
 *   `undefined` when nothing conclusive happened.
 */
export async function probeVision(options) {
  const rounds = Math.max(1, options.rounds ?? 2)
  const evidence = []
  const colours = pickColours(rounds)
  if (colours.length === 0) return { verdict: undefined, evidence }
  let passed = 0
  for (const colour of colours) {
    const request = probeRequest(options.api, options.baseURL, options.model, IMAGE_URLS[colour.name])
    if (request === undefined) return { verdict: undefined, evidence: [...evidence, 'protocol-not-probeable'] }
    let response
    try {
      response = await fetch(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(options.headers ?? {}) },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
      })
    } catch (error) {
      evidence.push(`network:${error instanceof Error ? error.message : String(error)}`)
      return { verdict: undefined, evidence }
    }
    const raw = await response.text()
    if (!response.ok) {
      evidence.push(`http ${response.status}${REFUSAL.test(raw) ? ' (refused images)' : ''}`)
      // A refusal that mentions images is proof; any other failure is not.
      return { verdict: REFUSAL.test(raw) ? false : undefined, evidence }
    }
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      evidence.push('unparseable reply')
      return { verdict: undefined, evidence }
    }
    const said = namedColours(replyText(body))
    evidence.push(`asked ${colour.name} -> said ${said.length > 0 ? said.join('/') : 'no colour'}`)
    if (said.includes(colour.name)) {
      passed += 1
      continue
    }
    // Named a different colour — any colour, not just another palette one: it
    // did not see this image.
    if (mentionsColour(replyText(body))) return { verdict: false, evidence }
    // Named nothing: inconclusive, keep trying the next colour.
  }
  return { verdict: passed > 0 ? true : undefined, evidence }
}
