/**
 * dsh-model-vision — keep each hand-declared pi-ai model's `input` in sync with
 * the vision capability its own gateway publishes.
 *
 * Why this exists: the harness's "Fetch available models" reader
 * (`readListing()` in `@deepseek-ai/dsh-llm-pi-ai`) only keeps `id`, `name`,
 * `contextWindow` and `maxTokens`. Modalities are never parsed, so every model
 * it adopts resolves through `entry.input → installed catalogue → defaultInput`,
 * and `DEFAULT_INPUT` is `["text"]`. A gateway that does serve images — and
 * states so in its own listing — ends up declared text-only, and the request is
 * refused before the image is attached:
 *   LlmError: pi-ai model "<id>" does not support image input (UNSUPPORTED_CONTENT)
 *
 * Writing `input: [text, image]` by hand fixes one model until the next fetch,
 * and nobody re-does it when a route gains models. This plugin reads the
 * gateway's own statement and writes the declaration back through the profile's
 * config editor, so the fetched list stays accurate without being re-edited.
 *
 * Source of truth per listing entry (first source that actually speaks wins):
 *   modality list   input | input_modalities | inputModalities
 *                   | architecture.input_modalities | modalities.input
 *   flat flag       vision | supports_vision | image_input | capabilities.vision
 *
 * Behaviour, deliberately conservative:
 *   - a gateway that says nothing about vision is left alone — silence is not
 *     "text only", and inventing a capability the endpoint refuses costs a
 *     rejected turn after the message is already durable;
 *   - `fill` (default) only writes where the route declares no `input` at all,
 *     so an explicit declaration stays the author's decision;
 *   - `sync` treats the gateway as the owner and also corrects a stale one;
 *   - a model the gateway does not list is never touched;
 *   - only the `input` field is ever written. Comments, `!!js` expressions,
 *     field order and every other key stay byte-identical.
 *
 * Zero third-party imports on purpose: this package lives outside the profile
 * directory, where Node cannot resolve the harness's node_modules.
 *
 * @module dsh-model-vision
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'

import { probeVision } from './probe.js'

export const name = 'model-vision'

/**
 * The service this plugin cannot work without.
 *
 * Everything else is looked up with `ctx.get()` / `ctx.inject()` instead of being
 * declared here: cordis reads an object `inject` as a "name → config" map, so a
 * `{ required, optional }` shape silently waits for services that never exist and
 * the plugin never applies.
 */
export const inject = ['configEditor']

/** Every modality a pi-ai model entry may declare. */
export const MODALITIES = ['text', 'image']

/** Listing fields that carry an explicit modality list, most specific first. */
const MODALITY_FIELDS = [
  (entry) => entry.input,
  (entry) => entry.input_modalities,
  (entry) => entry.inputModalities,
  (entry) => entry.architecture?.input_modalities,
  (entry) => entry.modalities?.input,
]

/** Listing fields that carry a flat boolean instead of a list. */
const FLAG_FIELDS = ['vision', 'supports_vision', 'image_input']

/** Protocols whose model listing this plugin can read. */
const LISTABLE = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])

/** Where the settings page posts its one-click request. */
export const RPC_PATH = '/plugins/model-vision/detect'
/** Header the settings page must send; a bare POST from a stray tab is refused. */
export const RPC_HEADER = 'x-model-vision'
/**
 * Wire version of the request/response pair.
 *
 * The browser bundle and this half are versioned separately (one is served from
 * the profile, the other from the running host), so the response carries this
 * number and the client ignores fields it does not know. Bump it only when a
 * change would break an older client.
 */
export const PROTOCOL_VERSION = 1

const DEFAULTS = {
  entryId: 'llm-pi-ai',
  routes: [],
  mode: 'fill',
  intervalMs: 300000,
  startDelayMs: 3000,
  watchMs: 5000,
  timeoutMs: 15000,
  dryRun: false,
  log: true,
  statusFile: '',
  // Background sweeps stay listing-only by default: a probe is a real request
  // against a real model, and nobody wants that on a timer. The one-click button
  // always probes, because that is what it was pressed for.
  probe: false,
  probeRounds: 2,
  probeTimeoutMs: 30000,
  maxProbes: 40,
  probeCache: '',
  // Appended to a model's display name once it is known to take images, so the
  // composer's model picker says so without any UI coupling. '' disables it.
  badgeSuffix: ' · 可看图',
}

/**
 * Normalise plugin config, rejecting what cannot be honoured.
 * @param config - raw config from the profile patch.
 * @returns the resolved options.
 */
export function normalizeConfig(config) {
  const raw = config ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('model-vision: config must be a map')
  const opts = { ...DEFAULTS }
  if (raw.entryId !== undefined) {
    if (typeof raw.entryId !== 'string' || raw.entryId.length === 0) throw new TypeError('model-vision: entryId must be a non-empty string')
    opts.entryId = raw.entryId
  }
  if (raw.routes !== undefined) {
    if (!Array.isArray(raw.routes) || raw.routes.some((route) => typeof route !== 'string')) throw new TypeError('model-vision: routes must be a list of route names')
    opts.routes = [...raw.routes]
  }
  if (raw.mode !== undefined) {
    if (raw.mode !== 'fill' && raw.mode !== 'sync') throw new TypeError('model-vision: mode must be "fill" or "sync"')
    opts.mode = raw.mode
  }
  for (const key of ['intervalMs', 'startDelayMs', 'watchMs', 'timeoutMs', 'probeTimeoutMs', 'probeRounds', 'maxProbes']) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < 0) throw new TypeError(`model-vision: ${key} must be a non-negative number`)
    opts[key] = raw[key]
  }
  for (const key of ['dryRun', 'log', 'probe']) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'boolean') throw new TypeError(`model-vision: ${key} must be a boolean`)
    opts[key] = raw[key]
  }
  if (raw.badgeSuffix !== undefined) {
    if (typeof raw.badgeSuffix !== 'string') throw new TypeError('model-vision: badgeSuffix must be a string (use "" to disable)')
    opts.badgeSuffix = raw.badgeSuffix
  }
  if (raw.probeCache !== undefined) {
    if (raw.probeCache !== false && typeof raw.probeCache !== 'string') throw new TypeError('model-vision: probeCache must be a path, an empty string, or false')
    opts.probeCache = raw.probeCache
  }
  if (raw.statusFile !== undefined) {
    if (raw.statusFile !== false && typeof raw.statusFile !== 'string') throw new TypeError('model-vision: statusFile must be a path, an empty string, or false')
    opts.statusFile = raw.statusFile
  }
  return opts
}

/**
 * Reduce one disclosed modality list to "does it carry images?".
 * @param value - whatever the listing put in that field.
 * @returns `true` for a list with images, `false` for a list without them,
 *   `undefined` when the value is not a usable modality list.
 */
export function readModalityList(value) {
  if (!Array.isArray(value)) return undefined
  const named = value.filter((item) => typeof item === 'string').map((item) => item.toLowerCase())
  if (named.length === 0) return undefined
  const hasText = named.includes('text') || named.includes('input_text')
  const hasImage = named.includes('image') || named.includes('vision') || named.includes('image_url')
  if (!hasText && !hasImage) return undefined
  return hasImage
}

/**
 * Ask the gateway what one model accepts.
 * @param entry - one entry of the endpoint's model listing, or undefined.
 * @returns `true` for image input, `false` for text only, `undefined` when the
 *   endpoint says nothing (which is not the same as "no images").
 */
export function readVision(entry) {
  if (entry === undefined || entry === null || typeof entry !== 'object') return undefined
  for (const field of MODALITY_FIELDS) {
    const verdict = readModalityList(field(entry))
    if (verdict !== undefined) return verdict
  }
  for (const key of FLAG_FIELDS) {
    if (entry[key] === true) return true
    if (entry[key] === false) return false
  }
  const nested = entry.capabilities
  if (nested !== null && typeof nested === 'object' && typeof nested.vision === 'boolean') return nested.vision
  return undefined
}

/**
 * Normalise a declared `input` value into modalities this plugin understands.
 * @param value - the model entry's current `input`.
 * @returns the usable modalities, or `undefined` when nothing usable is declared.
 */
export function readDeclared(value) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const modality = item.toLowerCase()
    if (!MODALITIES.includes(modality) || out.includes(modality)) continue
    out.push(modality)
  }
  return out.length === 0 ? undefined : out
}

/**
 * Decide the `input` value one model should carry.
 * @param declared - the model entry's current `input`, if any.
 * @param vision - {@link readVision} of the matching listing entry.
 * @param mode - `fill` only completes a missing declaration; `sync` also
 *   corrects one that disagrees with the gateway.
 * @returns the modalities to write, or `undefined` to leave the model alone.
 */
export function decideInput(declared, vision, mode = 'fill') {
  if (vision === undefined) return undefined
  const current = readDeclared(declared)
  const hasImage = current === undefined ? false : current.includes('image')
  if (mode === 'fill') {
    // Only a missing declaration is completed: an explicit one is its author's.
    if (vision !== true || current !== undefined) return undefined
    return ['text', 'image']
  }
  if (vision === true) {
    if (current === undefined) return ['text', 'image']
    return hasImage ? undefined : ['text', 'image']
  }
  // The gateway refuses images: drop one this route declared anyway.
  if (current === undefined || !hasImage) return undefined
  return current.filter((modality) => modality !== 'image')
}

/**
 * Compare two modality lists, ignoring order.
 * @param declared - the value currently in the profile.
 * @param decided - the value this plugin wants.
 * @returns whether the two describe the same modalities.
 */
export function sameInput(declared, decided) {
  const a = readDeclared(declared)
  const b = readDeclared(decided)
  if (a === undefined || b === undefined) return a === b
  if (a.length !== b.length) return false
  return a.every((modality) => b.includes(modality))
}

/**
 * Read a model listing out of an OpenAI-style or Anthropic-style body.
 * @param body - the parsed response.
 * @returns `{ id, raw }` pairs in endpoint order.
 */
export function readListing(body) {
  const container = body?.data ?? body?.models
  const list = Array.isArray(container)
    ? container
    : container !== null && typeof container === 'object'
      ? Object.entries(container).map(([id, value]) => (value !== null && typeof value === 'object' ? { id, ...value } : { id }))
      : []
  const out = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    // Gateways disagree on the id's name: LiteLLM's /model/info calls it
    // model_name (the name requests use), Ollama's /api/tags calls it name.
    const id = [item.id, item.model_name, item.model, item.name].find((value) => typeof value === 'string' && value.length > 0)
    if (id === undefined) continue
    out.push({ id, raw: item })
  }
  return out
}

/**
 * Put the vision marker on a display name.
 *
 * The composer's model picker renders `model.name` and hands the label slot to
 * whoever registered it first (the shipped 1017 labeller does), so a badge cannot
 * be added from the outside. Writing it into the name itself is the one place
 * every surface — picker, settings list, session headers — reads.
 *
 * @param name - the current display name.
 * @param suffix - the marker, e.g. `' · 可看图'`; `''` disables decoration.
 * @returns the name with the marker, unchanged when it already ends with it.
 */
export function applyBadge(name, suffix) {
  const base = typeof name === 'string' ? name : ''
  if (suffix === '' || base.length === 0 || base.endsWith(suffix)) return base
  return `${base}${suffix}`
}

/**
 * Take the vision marker back off a display name.
 * @param name - the current display name.
 * @param suffix - the marker to remove from the end.
 * @returns the name without the marker.
 */
export function stripBadge(name, suffix) {
  const base = typeof name === 'string' ? name : ''
  if (suffix === '' || base.length === 0 || !base.endsWith(suffix)) return base
  return base.slice(0, base.length - suffix.length)
}

/**
 * Plan one route's model list against the endpoint's listing.
 * @param models - the route's configured model entries (not mutated).
 * @param listing - `{ id, raw }` pairs from the endpoint.
 * @param options - `mode`, as in {@link decideInput}.
 * @returns the next model list, the changes made, and the declarations whose
 *   author overrode the gateway (reported, never rewritten, in `fill` mode).
 */
export function planModels(models, listing, options = {}) {
  const mode = options.mode ?? 'fill'
  const byId = new Map(listing.map((item) => [item.id, item.raw]))
  const next = []
  const changes = []
  const held = []
  for (const model of models) {
    if (model === null || typeof model !== 'object' || typeof model.id !== 'string') {
      next.push(model)
      continue
    }
    const raw = byId.get(model.id)
    const vision = readVision(raw)
    const declared = readDeclared(model.input)
    const decided = decideInput(model.input, vision, mode)
    const resulting = decided ?? declared
    const suffix = options.badgeSuffix ?? ''

    // The marker follows what the model will actually declare: a gateway that
    // serves images for a model whose entry still says text gets no badge, since
    // the declaration (its author's, in `fill` mode) is what the picker acts on.
    const wantsBadge = vision === true && resulting !== undefined && resulting.includes('image')
    const currentName = typeof model.name === 'string' ? model.name : undefined
    const wantedName = currentName === undefined || suffix === ''
      ? undefined
      : wantsBadge ? applyBadge(currentName, suffix) : stripBadge(currentName, suffix)
    const nameChanged = wantedName !== undefined && wantedName !== currentName

    if (decided === undefined && !nameChanged) {
      // Worth reporting only when the declaration actually contradicts the
      // gateway: a model that already carries image agrees with it.
      if (mode === 'fill' && vision === true && declared !== undefined && !declared.includes('image')) {
        held.push({ id: model.id, input: declared })
      }
      next.push(model)
      continue
    }

    next.push({
      ...model,
      ...(decided === undefined ? {} : { input: decided }),
      ...(nameChanged ? { name: wantedName } : {}),
    })
    changes.push({
      id: model.id,
      from: declared ?? null,
      to: resulting ?? null,
      vision,
      inputChanged: decided !== undefined,
      badge: nameChanged && wantsBadge,
      ...(nameChanged ? { nameTo: wantedName } : {}),
    })
  }
  return { models: next, changes, held }
}

/* ── writing the profile patch directly ───────────────────────────────────── */

/**
 * Render one string as a YAML scalar, quoting only when a plain scalar would be
 * misread. Display names carry spaces, `·` and `→`, none of which need quotes;
 * a name with `: `, `#` or a leading indicator does.
 *
 * @param text - the value.
 * @returns the YAML spelling.
 */
function yamlScalar(text) {
  const value = String(text)
  const plain = !/[:#\[\]{}&*!|>'"%@`]/.test(value)
    && !/^[\s-]/.test(value)
    && !/\s$/.test(value)
    && value.length > 0
  return plain ? value : `'${value.replaceAll("'", "''")}'`
}

/** Strip YAML quotes from a scalar so ids compare equal to the listing. */
function bareId(value) {
  const trimmed = value.trim()
  const quoted = /^(['"])(.*)\1$/.exec(trimmed)
  return quoted === null ? trimmed : quoted[2]
}

/** Indentation width of one line, or -1 for a blank line. */
function indentOf(line) {
  const match = /^\s*/.exec(line)
  return match === null ? 0 : match[0].length
}

/**
 * Plan line edits that bring the model entries of one profile row to `desired`.
 *
 * Pure, and deliberately line-based: the profile patch belongs to its author, so
 * comments, `!!js` expressions and key order outside the touched models are
 * preserved exactly. Every touched model keeps its field order too — its `input`
 * block is dropped and re-inserted where it already was.
 *
 * @param lines - the patch file's lines, without terminators.
 * @param desired - model id -> modalities to write.
 * @param options - `entryId` of the row to edit.
 * @returns the next lines plus whether anything moved.
 */
export function planPatchEdits(lines, desired, options = {}) {
  const entryId = typeof options.entryId === 'string' ? options.entryId : 'llm-pi-ai'
  const rowIndex = lines.findIndex((line) => bareId(line.replace(/^\s*-\s*id:\s*/, '')) === entryId && /^\s*-\s*id:/.test(line))
  if (rowIndex === -1) return { lines, changed: false }
  let end = lines.findIndex((line, index) => index > rowIndex && /^- id: /.test(line))
  if (end === -1) end = lines.length

  const edits = []
  for (let i = rowIndex + 1; i < end; i += 1) {
    const header = /^(\s*)-\s+id:\s*(.+?)\s*$/.exec(lines[i])
    if (header === null) continue
    const id = bareId(header[2])
    if (!desired.has(id)) continue
    const headerIndentWidth = header[1].length

    // The entry's own field region: indented deeper than its `- id:` line,
    // ending at the next entry, a dedent, or a blank separator.
    let regionEnd = i + 1
    while (regionEnd < end) {
      const line = lines[regionEnd]
      if (line.trim() === '') break
      if (/^\s*-\s+id:\s*/.test(line)) break
      if (indentOf(line) <= headerIndentWidth) break
      regionEnd += 1
    }

    // Sibling fields share one indent; take it from the first field rather than
    // assuming two spaces more than `- id:`, so an author's alignment is kept.
    let fieldIndentWidth = headerIndentWidth + 2
    for (let k = i + 1; k < regionEnd; k += 1) {
      if (lines[k].trim() === '') continue
      fieldIndentWidth = indentOf(lines[k])
      break
    }
    const fieldIndent = ' '.repeat(fieldIndentWidth)

    // An existing `input:` block: its header plus any deeper-indented lines.
    let dropFrom = -1
    let dropTo = -1
    let nested = false
    for (let k = i + 1; k < regionEnd; k += 1) {
      if (!/^\s*input:/.test(lines[k])) continue
      if (indentOf(lines[k]) !== fieldIndentWidth) {
        // Deeper than a sibling field: not this entry's own declaration. Leave
        // the model alone rather than write a second `input` key.
        nested = true
        continue
      }
      let e = k + 1
      while (e < regionEnd && lines[e].trim() !== '' && indentOf(lines[e]) > fieldIndentWidth) e += 1
      dropFrom = k
      dropTo = e
      break
    }
    if (nested && dropFrom === -1) continue

    // A value is either the modalities (the common case) or `{ input, name }`
    // when the sweep also wants the display name to carry the vision marker.
    const raw = desired.get(id)
    const wanted = Array.isArray(raw) ? { input: raw } : raw
    if (wanted === null || typeof wanted !== 'object') continue

    if (Array.isArray(wanted.input)) {
      // Block style, matching what the config editor writes for the same field,
      // so a later editor pass over the file is a no-op instead of a style
      // flip-flop.
      const block = [`${fieldIndent}input:`, ...wanted.input.map((modality) => `${fieldIndent}  - ${modality}`)]
      if (dropFrom === -1) edits.push({ from: regionEnd, to: regionEnd, insert: block })
      else edits.push({ from: dropFrom, to: dropTo, insert: block })
    }

    if (typeof wanted.name === 'string') {
      const line = `${fieldIndent}name: ${yamlScalar(wanted.name)}`
      let at = -1
      for (let k = i + 1; k < regionEnd; k += 1) {
        if (indentOf(lines[k]) === fieldIndentWidth && /^\s*name:/.test(lines[k])) {
          at = k
          break
        }
      }
      if (at === -1) edits.push({ from: regionEnd, to: regionEnd, insert: [line] })
      else if (lines[at] !== line) edits.push({ from: at, to: at + 1, insert: [line] })
    }
  }

  if (edits.length === 0) return { lines, changed: false }
  const insertAt = new Map()
  const dropped = new Set()
  for (const edit of edits) {
    insertAt.set(edit.from, [...(insertAt.get(edit.from) ?? []), ...edit.insert])
    for (let k = edit.from; k < edit.to; k += 1) dropped.add(k)
  }
  const out = []
  for (let k = 0; k < lines.length; k += 1) {
    if (insertAt.has(k)) out.push(...insertAt.get(k))
    if (dropped.has(k)) continue
    out.push(lines[k])
  }
  return { lines: out, changed: out.some((line, index) => line !== lines[index]) || out.length !== lines.length }
}

/**
 * Apply {@link planPatchEdits} to the profile patch, atomically.
 * @param path - absolute path of the profile patch.
 * @param desired - model id -> modalities to write.
 * @param options - `entryId` of the row to edit.
 * @returns whether the file changed.
 */
export function writePatchFile(path, desired, options = {}) {
  const raw = readFileSync(path, 'utf8')
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const planned = planPatchEdits(raw.split(/\r?\n/), desired, options)
  if (!planned.changed) return { changed: false }
  const temporary = `${path}.model-vision.tmp`
  writeFileSync(temporary, planned.lines.join(eol), 'utf8')
  renameSync(temporary, path)
  return { changed: true }
}

/* ── host wiring ─────────────────────────────────────────────────────────── */

/**
 * Read one profile row's `providers` the way the profile currently composes them.
 *
 * `entry.options.config` is a snapshot from whenever that row was last
 * reconciled, so a route the user saved a moment ago can still be missing from
 * it. The config editor's `configuration()` re-reads the profile layers on every
 * call, which is what makes "fetch models, then the declaration follows"
 * immediate rather than one Loader update late.
 *
 * @param editor - the config editor service.
 * @param entryId - the row to read.
 * @param fallback - the instantiated config, used when the fresh read is unusable.
 * @returns the composed `providers` map, or the fallback.
 */
export function effectiveProviders(editor, entryId, fallback) {
  let rows
  try {
    rows = typeof editor?.configuration === 'function' ? editor.configuration() : undefined
  } catch {
    rows = undefined
  }
  const row = Array.isArray(rows) ? rows.find((candidate) => candidate?.entry?.options?.id === entryId) : undefined
  if (row === undefined) return fallback
  const providers = { ...(row.inherited?.providers ?? {}), ...(row.override?.providers ?? {}) }
  return Object.keys(providers).length === 0 ? fallback : providers
}

/**
 * A cheap fingerprint of the managed routes as the profile currently composes
 * them: every route, every model id, and every declaration each one carries.
 *
 * The poll compares this string instead of watching a file, because the file
 * watcher on the profile patch belongs to the Loader (`hmr.watchConfig` refuses a
 * second registration on the same path). It costs no network and no writes.
 *
 * @param ctx - plugin context.
 * @param options - resolved plugin options (`entryId`, `routes`).
 * @returns the fingerprint, or `undefined` when the row is not loadable yet.
 */
export function configurationSignature(ctx, options) {
  const editor = ctx.get('configEditor')
  if (editor === undefined) return undefined
  const entry = editor.entries().find((candidate) => candidate.options.id === options.entryId)
  const providers = effectiveProviders(editor, options.entryId, entry?.options.config?.providers)
  if (providers === null || typeof providers !== 'object') return undefined
  const parts = []
  for (const route of Object.keys(providers)) {
    if (Array.isArray(options.routes) && options.routes.length > 0 && !options.routes.includes(route)) continue
    const profile = providers[route]
    const models = Array.isArray(profile?.models) ? profile.models : []
    parts.push(`${route}:${models.map((model) => `${String(model?.id)}=${(readDeclared(model?.input) ?? []).join('+')}`).join(',')}`)
  }
  return parts.join('|')
}

/**
 * The profile patch this plugin can fall back to, when the config editor refuses.
 * @param ctx - plugin context.
 * @returns the absolute path, or `undefined`.
 */
export function patchPathOf(ctx) {
  try {
    const editor = ctx.get('configEditor')
    return typeof editor?.documentPath === 'string' && editor.documentPath.length > 0 ? editor.documentPath : undefined
  } catch {
    return undefined
  }
}

/**
 * The harness home directory: where per-user state belongs.
 * @returns `$DSH_HOME`, or `~/.dsh` when it is unset.
 */
export function harnessHome() {
  return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

/**
 * The name of the profile this instance was mounted in, when the host says so.
 *
 * Every profile shares one `DSH_HOME`, so a single global status file would be
 * written by each running profile in turn: booting a second `dsh` would replace
 * the first one's record with a dead pid and the other profile's patch path.
 * The name is used to keep one file per profile instead.
 *
 * @param ctx - plugin context.
 * @returns the profile name, or `undefined` on a host that does not expose one.
 */
export function profileName(ctx) {
  try {
    const profile = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined
    const name = profile?.name
    return typeof name === 'string' && name.length > 0 ? name : undefined
  } catch {
    // A status file name is never worth failing a load over.
    return undefined
  }
}

/**
 * The `model-vision[.<profile>]` stem shared by the status document and cache.
 * @param profile - the profile name, when known.
 * @returns the stem.
 */
export function stateStem(profile) {
  return typeof profile === 'string' && profile.length > 0 ? `model-vision.${profile}` : 'model-vision'
}

/**
 * {@link harnessHome} as the status document path.
 * @param profile - the profile name, so two profiles do not share one file.
 * @returns the status file path.
 */
export function defaultStatusFile(profile) {
  return join(harnessHome(), `${stateStem(profile)}.status.json`)
}

/**
 * Read one reference out of the provider-managed credential document.
 *
 * The `credentials` service is the first choice and normally answers; this is
 * the fallback for a composition that mounts no provider (or a document the
 * service refused), and it is what the harness itself would have read.
 *
 * @param ref - the reference name a route's `apiKeyEnv` names.
 * @returns the stored value, or `undefined`.
 */
export function readCredentialRef(ref) {
  if (typeof ref !== 'string' || ref.length === 0) return undefined
  let text
  try {
    text = readFileSync(join(harnessHome(), '.credentials.yaml'), 'utf8')
  } catch {
    return undefined
  }
  const start = /^refs:[ \t]*$/m.exec(text)
  if (start === null) return undefined
  const block = text.slice(start.index + start[0].length)
  const stop = /^\S/m.exec(block)
  const body = stop === null ? block : block.slice(0, stop.index)
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s+([A-Za-z0-9_.-]+):\s*(.+?)\s*$/.exec(line)
    if (match === null || match[1] !== ref) continue
    const quoted = /^(['"])(.*)\1$/.exec(match[2])
    const value = quoted === null ? match[2] : quoted[2]
    return value.length === 0 ? undefined : value
  }
  return undefined
}

/**
 * Resolve one route's credential, recording where it came from so a 401 in the
 * status document names the reason instead of leaving it to guesswork.
 *
 * @param ctx - plugin context.
 * @param ref - the route's `apiKeyEnv`.
 * @returns the value (when found) and a source label. Never carries the value
 *   into the status document.
 */
export async function resolveCredential(ctx, ref) {
  if (typeof ref !== 'string' || ref.length === 0) return { source: 'unset' }
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(ref)
      const value = typeof hit === 'string' ? hit : hit?.value
      if (typeof value === 'string' && value.length > 0) return { value, source: `service:${hit?.source ?? 'stored'}` }
      return { source: 'service:absent' }
    } catch (error) {
      // Fall through: a refusing provider should not cost the sweep its key.
      const stored = readCredentialRef(ref)
      if (stored !== undefined) return { value: stored, source: 'file-after-service-error' }
      return { source: `service-error:${error instanceof Error ? error.message : String(error)}` }
    }
  }
  const fromEnv = process.env[ref]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return { value: fromEnv, source: 'env' }
  const stored = readCredentialRef(ref)
  if (stored !== undefined) return { value: stored, source: 'file' }
  return { source: 'absent' }
}

/**
 * Where a route's model listing may live.
 *
 * `baseURL` is whatever the user typed: some people paste `http://host/v1`,
 * others just `http://host`. The same service then answers under different
 * paths, and every gateway family has its own spelling — LiteLLM publishes a
 * capability-flags endpoint, Ollama a native tag list. Candidates are tried in
 * this order, and the first one that yields a usable listing is remembered for
 * the rest of the process, so a sweep costs one request, not four.
 *
 * @param baseURL - the route's base URL.
 * @param api - the route's protocol.
 * @returns candidate URLs, most likely first.
 */
export function listingUrls(baseURL, api = 'openai-completions') {
  const base = String(baseURL).replace(/\/+$/, '')
  if (api === 'anthropic-messages') {
    const root = base.endsWith('/v1') ? base.slice(0, -3) : base
    return [`${root}/v1/models?limit=1000`]
  }
  const bare = base.replace(/\/v\d+$/i, '')
  const candidates = [api === 'openai-responses' ? `${base}/models` : `${base}/models`]
  candidates.push(bare !== base ? `${bare}/v1/models` : `${base}/v1/models`)
  candidates.push(`${bare}/model/info`, `${bare}/api/tags`)
  return [...new Set(candidates)]
}

/** Winning listing URL per base URL, so a sweep does not rediscover it. */
const listingUrlCache = new Map()

/**
 * The headers one route needs, and where its credential came from.
 *
 * Shared by the listing read and the vision probe so a gateway that needs an
 * unusual header does not work for one and 401 for the other.
 *
 * @param ctx - plugin context, for the credentials service.
 * @param profile - the route's pi-ai profile.
 * @returns `{ api, headers, credential }`, headers as a plain object.
 */
async function routeAuth(ctx, profile) {
  const api = typeof profile.api === 'string' ? profile.api : 'openai-completions'
  const ref = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined
  const credential = await resolveCredential(ctx, ref)
  const headers = { accept: 'application/json', ...(profile.headers ?? {}) }
  if (api === 'anthropic-messages') {
    headers['anthropic-version'] = '2023-06-01'
    if (credential.value !== undefined) headers['x-api-key'] = credential.value
  } else if (credential.value !== undefined) {
    headers.authorization = `Bearer ${credential.value}`
  }
  return { api, headers, credential }
}

/**
 * Read the endpoint's model listing for one configured route, trying every
 * place that listing may live.
 *
 * @param ctx - plugin context, for the credentials service.
 * @param profile - the route's pi-ai profile.
 * @param run - the options this run uses.
 * @returns the listing, and which credential and URL answered.
 */
async function fetchListing(ctx, profile, run) {
  const base = String(profile.baseURL).replace(/\/+$/, '')
  const { api, headers, credential } = await routeAuth(ctx, profile)
  const ref = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined

  const remembered = listingUrlCache.get(base)
  const candidates = remembered === undefined ? listingUrls(base, api) : [remembered, ...listingUrls(base, api)]
  const failures = []
  for (const url of [...new Set(candidates)]) {
    let response
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(run.timeoutMs) })
    } catch (error) {
      failures.push(`${url} unreachable (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    if (!response.ok) {
      failures.push(`${url} answered ${response.status}`)
      continue
    }
    let body
    try {
      body = await response.json()
    } catch {
      failures.push(`${url} returned something that is not JSON`)
      continue
    }
    const listing = readListing(body)
    if (listing.length === 0) {
      failures.push(`${url} listed no models`)
      continue
    }
    listingUrlCache.set(base, url)
    return { listing, credential: credential.source, url }
  }
  throw new Error(
    `${failures.join('; ')}${credential.value === undefined ? ` (no credential for ${ref ?? 'this route'}: ${credential.source})` : ` (credential source: ${credential.source})`}`,
  )
}

/* ── probe cache ──────────────────────────────────────────────────────────── */

/** A verdict from probing stays good for a week; a "no" is retried after a day. */
const PROBE_TTL = { yes: 7 * 24 * 60 * 60 * 1000, no: 24 * 60 * 60 * 1000 }

/**
 * Where probe verdicts are remembered.
 * @param options - resolved plugin options.
 * @returns the file path, or `undefined` when caching is off.
 */
export function probeCacheFile(options) {
  if (options.probeCache === false) return undefined
  if (typeof options.probeCache === 'string' && options.probeCache.length > 0) return options.probeCache
  return join(harnessHome(), `${stateStem(options.profile)}.probe.json`)
}

/**
 * Read the persisted probe cache.
 * @param options - resolved plugin options.
 * @returns a map of `baseURL|model` to `{ vision, at }`.
 */
export function readProbeCache(options) {
  const file = probeCacheFile(options)
  if (file === undefined) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed.entries === 'object' && parsed.entries !== null ? parsed.entries : {}
  } catch {
    return {}
  }
}

/**
 * Persist the probe cache atomically, best effort.
 * @param options - resolved plugin options.
 * @param entries - the map to store.
 */
export function writeProbeCache(options, entries) {
  const file = probeCacheFile(options)
  if (file === undefined) return
  try {
    const temporary = `${file}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
  } catch {
    /* a cache miss is never worth failing a sweep over */
  }
}

/**
 * A cached verdict that is still fresh.
 * @param entries - the cache map.
 * @param key - `baseURL|model`.
 * @param now - epoch milliseconds.
 * @returns the cached verdict, or `undefined`.
 */
export function freshProbe(entries, key, now = Date.now()) {
  const hit = entries[key]
  if (hit === null || typeof hit !== 'object' || typeof hit.vision !== 'boolean') return undefined
  const age = now - (typeof hit.at === 'number' ? hit.at : 0)
  return age <= (hit.vision ? PROBE_TTL.yes : PROBE_TTL.no) ? hit.vision : undefined
}

/**
 * Is this Host header a loopback one? The detect endpoint is a local convenience,
 * not a network service.
 * @param host - the request's Host header.
 * @returns whether it names this machine.
 */
export function isLoopbackHost(host) {
  const name = String(host ?? '').toLowerCase().replace(/^\[/, '[').split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

/**
 * Write one JSON reply.
 * @param res - the response.
 * @param status - HTTP status.
 * @param body - the payload.
 */
function sendJson(res, status, body) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  } catch {
    /* the client went away */
  }
}

/**
 * Read a small JSON request body.
 * @param req - the request.
 * @returns the parsed object; `{}` for an empty body.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed
}

/**
 * Build the status writer. It deliberately does not depend on a valid config:
 * a plugin whose config was rejected must still leave a trace on disk.
 * @param rawConfig - the raw plugin config, whatever it turned out to be.
 * @param profile - the profile name, so two profiles do not share one file.
 * @returns a writer that merges one patch into the status document.
 */
export function createStatus(rawConfig, profile) {
  const requested = rawConfig !== null && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig.statusFile : undefined
  if (requested === false) return () => {}
  const file = typeof requested === 'string' && requested.length > 0 ? requested : defaultStatusFile(profile)
  return (patch) => {
    try {
      let previous = {}
      try {
        previous = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        previous = {}
      }
      writeFileSync(file, `${JSON.stringify({ ...previous, ...patch, statusFile: file, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
    } catch {
      /* a status document is never worth failing a load or a sweep over */
    }
  }
}

/**
 * How many declarations one sweep planned, over every route.
 * @param results - per-route sweep results.
 * @returns the total.
 */
export function totalChanges(results) {
  return results.reduce((sum, result) => sum + (Array.isArray(result?.changes) ? result.changes.length : 0), 0)
}

/**
 * One plain sentence describing a sweep, for the status document.
 *
 * The rest of that document is structured for machines (`routes`, `changes`,
 * `credential`); this line is the part a person reads first, and it is written
 * without any field name or protocol vocabulary.
 *
 * @param results - per-route sweep results.
 * @param failure - the sweep's error message, when it failed.
 * @param dryRun - whether the sweep was forbidden from writing.
 * @param changed - {@link totalChanges} of the same results.
 * @returns the sentence.
 */
export function describeSweep(results, failure, dryRun, changed) {
  if (failure !== undefined && failure !== null) return `出错了：${failure}`
  const models = results.reduce((sum, result) => sum + (result?.models ?? 0), 0)
  const listed = results.reduce((sum, result) => sum + (result?.listed ?? 0), 0)
  if (results.length === 0 || models === 0) {
    return '没有可检查的模型：先在「模型」设置里配好供应商，再点一次「获取可用模型」'
  }
  // One model can gain both a declaration and a marker, so the two counts are
  // taken independently rather than one being derived from the other.
  const all = results.flatMap((result) => result?.changes ?? [])
  const badged = all.filter((change) => change.badge === true).length
  const visual = all.filter((change) => change.inputChanged === true).length
  const head = `扫了 ${models} 个模型（网关报了 ${listed} 个）`
  const what = [
    visual > 0 ? `补了 ${visual} 个的「输入类型：图片」` : '',
    badged > 0 ? `${visual > 0 ? '并给' : '给'} ${badged} 个名字加了「可看图」` : '',
  ].filter((part) => part.length > 0).join('，')
    // A caller that reports changes without saying which field moved still gets
    // a sentence: the declaration is the default reason something was written.
    || `补了 ${changed} 个的「输入类型：图片」`
  if (changed === 0) return `${head}，没有要改的`
  if (dryRun === true) return `${head}，本来可以${what}，但只看不写模式（dryRun）开着，没动文件`
  return `${head}，${what}`
}

/**
 * Mount the detector. One sweep runs shortly after load, then on an interval and
 * whenever the composed profile changes; a sweep that finds nothing to change
 * writes nothing at all.
 * @param ctx - plugin context.
 * @param config - raw plugin config.
 */
export function apply(ctx, config) {
  // Every profile shares one `DSH_HOME`; keeping the name here is what stops a
  // second profile's boot from overwriting this one's status document.
  const mountedIn = profileName(ctx)
  const status = createStatus(config, mountedIn)
  status({ phase: 'apply', plugin: name, rawConfig: config ?? null, pid: process.pid, node: process.version, execPath: process.execPath })

  const options = normalizeConfig(config)
  const log = (level, message, ...rest) => {
    if (!options.log) return
    const logger = ctx.logger
    if (logger === undefined) return
    logger[level](`model-vision: ${message}`, ...rest)
  }

  let running = false
  /** Last fingerprint the poll has already accounted for. */
  let lastSignature

  /**
   * One pass over the managed routes.
   *
   * @param reason - what triggered it: `start`, `interval`, `config-change`, `manual`.
   * @param overrides - per-run options; the one-click endpoint passes `probe`
   *   and `dryRun` here without touching the configured defaults.
   * @returns the report, or `undefined` when a run was already in flight.
   */
  const sweep = async (reason, overrides = {}) => {
    if (running) return undefined
    running = true
    const run = { ...options, ...overrides, profile: mountedIn }
    const results = []
    let wrote = false
    let via = null
    let failure
    try {
      const editor = ctx.get('configEditor')
      if (editor === undefined) throw new Error('no config editor is mounted; nothing can be written')
      const entry = editor.entries().find((candidate) => candidate.options.id === run.entryId)
      if (entry === undefined) throw new Error(`profile row "${run.entryId}" is not loaded`)
      const providers = effectiveProviders(editor, run.entryId, entry.options.config?.providers)
      if (providers === null || typeof providers !== 'object') throw new Error(`profile row "${run.entryId}" declares no providers`)

      const next = structuredClone(providers)
      const desired = new Map()
      const probing = run.probe === true
      const probeCache = probing ? readProbeCache(run) : {}
      let probeBudget = Number.isFinite(run.maxProbes) ? run.maxProbes : Number.POSITIVE_INFINITY
      let probesUsed = 0

      for (const [route, profile] of Object.entries(providers)) {
        if (run.routes.length > 0 && !run.routes.includes(route)) continue
        if (profile === null || typeof profile !== 'object') continue
        const api = typeof profile.api === 'string' ? profile.api : 'openai-completions'
        if (!LISTABLE.has(api)) continue
        if (typeof profile.baseURL !== 'string' || profile.baseURL.length === 0) continue
        if (!Array.isArray(profile.models) || profile.models.length === 0) continue

        const result = { route, baseURL: profile.baseURL, models: profile.models.length, listed: 0, listingUrl: null, credential: null, probed: 0, probeUnknown: 0, probeSkipped: 0, probedModels: [], changes: [], held: [], error: null }
        results.push(result)

        let listing
        try {
          const read = await fetchListing(ctx, profile, run)
          listing = read.listing
          result.credential = read.credential
          result.listingUrl = read.url
        } catch (error) {
          result.error = error instanceof Error ? error.message : String(error)
          log('warn', 'could not read the model listing of route %s: %s', route, result.error)
          continue
        }
        result.listed = listing.length

        // What the listing says, per model. `undefined` means it said nothing.
        const vision = new Map(listing.map((item) => [item.id, readVision(item.raw)]))

        if (probing) {
          const auth = await routeAuth(ctx, profile)
          const base = String(profile.baseURL).replace(/\/+$/, '')
          for (const model of profile.models) {
            if (typeof model?.id !== 'string' || vision.get(model.id) !== undefined) continue
            const key = `${base}|${model.id}`
            const cached = freshProbe(probeCache, key)
            if (cached !== undefined) {
              vision.set(model.id, cached)
              result.probedModels.push({ id: model.id, vision: cached, cached: true })
              continue
            }
            if (probesUsed >= probeBudget) {
              result.probeSkipped += 1
              continue
            }
            probesUsed += 1
            const outcome = await probeVision({
              api: auth.api,
              baseURL: base,
              model: model.id,
              headers: auth.headers,
              timeoutMs: run.probeTimeoutMs,
              rounds: run.probeRounds,
            })
            result.probed += 1
            if (outcome.verdict === undefined) {
              result.probeUnknown += 1
              log('info', 'route %s model %s: probe inconclusive (%s)', route, model.id, outcome.evidence.join('; '))
              continue
            }
            probeCache[key] = { vision: outcome.verdict, at: Date.now(), evidence: outcome.evidence.slice(-2) }
            vision.set(model.id, outcome.verdict)
            result.probedModels.push({ id: model.id, vision: outcome.verdict })
            log('info', 'route %s model %s: probe says %s', route, model.id, outcome.verdict ? 'sees images' : 'text only')
          }
          if (result.probed > 0) writeProbeCache(run, probeCache)
        }

        // Feed the planner a listing-shaped view of everything we now know, so
        // it keeps one code path regardless of where a verdict came from.
        const knowledge = [...vision].filter(([, value]) => value !== undefined).map(([id, value]) => ({ id, raw: { vision: value } }))
        const plan = planModels(profile.models, knowledge, run)
        next[route] = { ...profile, models: plan.models }
        result.changes = plan.changes.map((change) => ({
          id: change.id,
          to: change.to,
          inputChanged: change.inputChanged,
          badge: change.badge,
          ...(change.nameTo === undefined ? {} : { name: change.nameTo }),
        }))
        result.held = plan.held
        for (const change of plan.changes) {
          if (change.inputChanged) log('info', 'route %s model %s input -> [%s]', route, change.id, change.to.join(', '))
          if (change.badge) log('info', 'route %s model %s name -> %s', route, change.id, change.nameTo)
          const existing = desired.get(change.id)
          // Two routes may serve the same id; the patch file can hold only one
          // declaration per id, so a disagreement is reported and skipped.
          if (change.inputChanged && existing?.input !== undefined && !sameInput(existing.input, change.to)) {
            log('warn', 'two routes disagree about %s; leaving it alone', change.id)
            desired.delete(change.id)
            continue
          }
          const entry = { ...(existing ?? {}) }
          if (change.inputChanged) entry.input = change.to
          if (typeof change.nameTo === 'string') entry.name = change.nameTo
          desired.set(change.id, entry)
        }
        for (const item of plan.held) {
          log('info', 'route %s model %s declares [%s] while the gateway serves images; left as declared (mode=fill)', route, item.id, item.input.join(', '))
        }
      }

      const changed = results.reduce((sum, result) => sum + result.changes.length, 0)
      if (changed > 0 && run.dryRun) {
        via = 'dry-run'
        log('info', 'sweep (%s): %d model(s) would change; dryRun is on, nothing written', reason, changed)
      } else if (changed > 0) {
        try {
          await editor.edit(entry, (current) => ({ ...current, providers: next }))
          via = 'config-editor'
          wrote = true
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // A plugin that was hot-reloaded applies inside the HMR transaction
          // that replaced it; that transaction rejects nesting, so every later
          // edit through this service fails the same way. The profile patch is
          // then the only way through — and the same watcher recomposes it.
          if (!/cannot be nested/i.test(message)) throw error
          const patchPath = editor.documentPath
          if (typeof patchPath !== 'string' || patchPath.length === 0) throw error
          const written = writePatchFile(patchPath, desired, { entryId: run.entryId })
          via = 'patch-file'
          wrote = written.changed
        }
      }
      log('info', 'sweep (%s): %s', reason, changed === 0 ? 'every managed model already matches its gateway' : `${String(changed)} model(s) updated via ${via}`)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      log('warn', 'sweep (%s) failed: %s', reason, failure)
    } finally {
      running = false
      // Adopt the post-sweep fingerprint, so this plugin's own write does not
      // look like a profile edit and trigger an immediate no-op sweep that would
      // overwrite this status document.
      try {
        const current = configurationSignature(ctx, options)
        if (current !== undefined) lastSignature = current
      } catch {
        /* the poll keeps the previous baseline and retries next tick */
      }
      const message = describeSweep(results, failure, run.dryRun, totalChanges(results))
      status({
        phase: 'sweep',
        reason,
        // One plain sentence, so reading this file never requires knowing the
        // field names around it. `message` is the whole answer for most people.
        message,
        entryId: run.entryId,
        mode: run.mode,
        dryRun: run.dryRun,
        probe: run.probe === true,
        wrote,
        via,
        routes: results,
        error: failure ?? null,
      })
      return { message, reason, wrote, via, dryRun: run.dryRun === true, probe: run.probe === true, routes: results, error: failure ?? null }
    }
  }

  status({ phase: 'loaded', plugin: name, entryId: options.entryId, mode: options.mode, routes: options.routes, intervalMs: options.intervalMs })
  log('info', 'watching row "%s" (mode=%s)%s every %dms', options.entryId, options.mode, options.routes.length > 0 ? ` routes ${options.routes.join(',')}` : ' (all listable routes)', options.intervalMs)

  ctx.effect(() => {
    // 0 means "next tick": the start sweep always runs, `intervalMs` alone
    // decides whether it ever runs again.
    const start = setTimeout(() => void sweep('start'), options.startDelayMs)
    const timer = options.intervalMs === 0 ? undefined : setInterval(() => void sweep('interval'), options.intervalMs)
    return () => {
      clearTimeout(start)
      if (timer !== undefined) clearInterval(timer)
    }
  }, 'model-vision sweeps')

  // React to profile edits instead of waiting for the next interval: the moment
  // a route or model is saved (including "Fetch available models"), the
  // declaration follows. This deliberately does not register a file watcher:
  // `hmr.watchConfig` is the Loader's own registration on this path and rejects a
  // second one, so a plugin cannot join it. A signature poll over the composed
  // providers costs nothing (no network) and needs no internal hook.
  if (options.watchMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        let signature
        try {
          signature = configurationSignature(ctx, options)
        } catch {
          return
        }
        if (signature === undefined) return
        if (lastSignature === undefined) {
          lastSignature = signature
          return
        }
        if (signature === lastSignature) return
        lastSignature = signature
        void sweep('config-change')
      }, options.watchMs)
      // A poll must never hold a process open by itself.
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, 'model-vision profile watch')
    // `null` clears the fields an earlier build of this plugin may have left in
    // the status document: it merges into the previous one rather than replacing.
    status({ phase: 'watching', watchMs: options.watchMs, patchPath: patchPathOf(ctx), configWatcher: null, note: null })
    log('info', 'polling the composed profile every %dms for edits', options.watchMs)
  }

  // ── the one-click button's endpoint ───────────────────────────────────────
  // The settings page posts here; the same sweep runs, with probing on, because
  // a person who pressed "check" asked for the expensive answer. Loopback-only
  // and header-guarded: it writes configuration, so it is not a public route.
  //
  // `webServer` is waited for through `ctx.inject` rather than declared in this
  // module's `inject`: a headless composition has no web server at all, and the
  // sweeps are just as useful there.
  const mountEndpoint = (scope) => {
    const webServer = scope.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') {
      log('info', 'no web server in this composition; the one-click button is unavailable (the sweep still runs)')
      return
    }
    scope.effect(() => {
      const dispose = webServer.register({
        kind: 'exact',
        path: RPC_PATH,
        handler: async (req, res) => {
          if ((req.method ?? 'GET') !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
          if (req.headers[RPC_HEADER] === undefined) return sendJson(res, 403, { ok: false, error: '缺少调用方标识头' })
          if (!isLoopbackHost(req.headers.host)) return sendJson(res, 403, { ok: false, error: '仅接受本机请求' })
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
          const report = await sweep('manual', {
            probe: body.probe !== false,
            dryRun: body.dryRun === true,
            routes: typeof body.route === 'string' && body.route.length > 0 ? [body.route] : options.routes,
            ...(Number.isFinite(body.maxProbes) ? { maxProbes: body.maxProbes } : {}),
          })
          if (report === undefined) return sendJson(res, 409, { ok: false, error: '已经有一次检查在进行，请稍等几秒再点' })
          sendJson(res, 200, { ok: true, protocol: PROTOCOL_VERSION, ...report })
        },
      })
      log('info', 'one-click endpoint listening on %s', RPC_PATH)
      return () => dispose()
    }, 'model-vision detect endpoint')
  }
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mountEndpoint)
  else mountEndpoint(ctx)
}
