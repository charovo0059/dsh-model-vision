/**
 * Pure-logic tests for dsh-model-vision. No harness, no network: every case is a
 * fixture, so this runs anywhere `node` does.
 *
 *   node test/vision.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  readVision,
  readDeclared,
  decideInput,
  sameInput,
  readListing,
  planModels,
  planPatchEdits,
  writePatchFile,
  normalizeConfig,
  describeSweep,
  totalChanges,
  applyBadge,
  stripBadge,
} from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => join(here, 'fixtures', name)

const listing = readListing(JSON.parse(readFileSync(fixture('ofm-models.json'), 'utf8')))
const byId = new Map(listing.map((item) => [item.id, item.raw]))

/* ── what the gateway says ────────────────────────────────────────────────── */

test('readVision reads every shape a gateway publishes', () => {
  assert.equal(readVision({ input: ['text', 'image'] }), true)
  assert.equal(readVision({ input: ['text'] }), false)
  assert.equal(readVision({ input_modalities: ['text', 'image'] }), true)
  assert.equal(readVision({ architecture: { input_modalities: ['image', 'text'] } }), true)
  assert.equal(readVision({ modalities: { input: ['text'] } }), false)
  assert.equal(readVision({ vision: true }), true)
  assert.equal(readVision({ vision: false }), false)
  assert.equal(readVision({ supports_vision: true }), true)
  assert.equal(readVision({ capabilities: { vision: true } }), true)
})

test('readVision leaves silence alone instead of calling it text-only', () => {
  // The free lane publishes no modality field at all: not the same as "no images".
  assert.equal(readVision({}), undefined)
  assert.equal(readVision(undefined), undefined)
  assert.equal(readVision({ input: [] }), undefined)
  assert.equal(readVision({ input: ['audio'] }), undefined)
})

test('the explicit list wins over a flat flag that disagrees', () => {
  assert.equal(readVision({ input: ['text', 'image'], vision: false }), true)
  assert.equal(readVision({ input: ['text'], vision: true }), false)
})

/* ── what should be written ───────────────────────────────────────────────── */

test('readDeclared keeps only usable, de-duplicated modalities', () => {
  assert.deepEqual(readDeclared(['text', 'image']), ['text', 'image'])
  assert.deepEqual(readDeclared(['image', 'image']), ['image'])
  assert.deepEqual(readDeclared(['text', 'audio']), ['text'])
  assert.equal(readDeclared([]), undefined)
  assert.equal(readDeclared(undefined), undefined)
  assert.equal(readDeclared(['audio']), undefined)
})

test('fill completes a missing declaration and nothing else', () => {
  assert.deepEqual(decideInput(undefined, true, 'fill'), ['text', 'image'])
  assert.equal(decideInput(undefined, false, 'fill'), undefined)
  assert.equal(decideInput(['text'], true, 'fill'), undefined, 'an explicit declaration is its author’s')
  assert.equal(decideInput(['text', 'image'], true, 'fill'), undefined)
  assert.equal(decideInput(undefined, undefined, 'fill'), undefined, 'silence never becomes a claim')
})

test('sync treats the gateway as the owner, in both directions', () => {
  assert.deepEqual(decideInput(undefined, true, 'sync'), ['text', 'image'])
  assert.deepEqual(decideInput(['text'], true, 'sync'), ['text', 'image'])
  assert.equal(decideInput(['text', 'image'], true, 'sync'), undefined)
  assert.deepEqual(decideInput(['text', 'image'], false, 'sync'), ['text'])
  assert.equal(decideInput(['text'], false, 'sync'), undefined)
  assert.equal(decideInput(undefined, undefined, 'sync'), undefined)
})

test('sameInput ignores order', () => {
  assert.equal(sameInput(['image', 'text'], ['text', 'image']), true)
  assert.equal(sameInput(['text'], ['text', 'image']), false)
  assert.equal(sameInput(undefined, undefined), true)
})

/* ── planning one route ───────────────────────────────────────────────────── */

const models = [
  { id: 'trae/deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', contextWindow: 1048576 },
  { id: 'raccoon/sn-deepseek-v4-1-flash', name: 'DeepSeek-V4.1-Flash · x0.25', contextWindow: 1000000, maxTokens: 100000 },
  { id: 'raccoon/sn-deepseek-v4-1-flash-1017', name: 'DeepSeek-V4.1-Flash-1017 · 免费', contextWindow: 1000000, maxTokens: 100000 },
  { id: 'lobsterai/deepseek-flash', name: 'DeepSeek-V4.1-Flash · x0.05', contextWindow: 1000000 },
  { id: 'big-pickle', name: 'Big Pickle', contextWindow: 262144 },
  { id: 'buddy/deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.11', contextWindow: 1000000, input: ['text'] },
  { id: 'workbuddy/deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.00→免费', contextWindow: 1000000, input: ['text'] },
]

test('fill writes only where the gateway serves images and nothing is declared', () => {
  const plan = planModels(models, listing, { mode: 'fill' })
  const changed = Object.fromEntries(plan.changes.map((change) => [change.id, change.to]))
  assert.deepEqual(changed, {
    'trae/deepseek-v4.1-flash': ['text', 'image'],
    'raccoon/sn-deepseek-v4-1-flash': ['text', 'image'],
  })
  // Explicit text declarations are reported, never rewritten.
  assert.deepEqual(plan.held.map((item) => item.id).sort(), ['buddy/deepseek-v4.1-flash', 'workbuddy/deepseek-v4.1-flash'])
})

test('a text-only route and a silent route are both left untouched', () => {
  const plan = planModels(models, listing, { mode: 'fill' })
  const untouched = ['raccoon/sn-deepseek-v4-1-flash-1017', 'lobsterai/deepseek-flash', 'big-pickle']
  for (const id of untouched) {
    assert.equal(Object.hasOwn(Object.fromEntries(plan.changes.map((c) => [c.id, c])), id), false, id)
  }
})

test('a model the gateway does not list is never touched', () => {
  const plan = planModels([{ id: 'not/listed', name: 'x' }], listing, { mode: 'fill' })
  assert.equal(plan.changes.length, 0)
  assert.deepEqual(plan.models, [{ id: 'not/listed', name: 'x' }])
})

test('sync also corrects a stale declaration', () => {
  const plan = planModels(models, listing, { mode: 'sync' })
  const changed = Object.fromEntries(plan.changes.map((change) => [change.id, change.to]))
  assert.deepEqual(changed, {
    'trae/deepseek-v4.1-flash': ['text', 'image'],
    'raccoon/sn-deepseek-v4-1-flash': ['text', 'image'],
    'buddy/deepseek-v4.1-flash': ['text', 'image'],
    'workbuddy/deepseek-v4.1-flash': ['text', 'image'],
  })
  assert.equal(plan.held.length, 0)
})

test('the plan is idempotent: a second sweep over its own output changes nothing', () => {
  const first = planModels(models, listing, { mode: 'fill' })
  const second = planModels(first.models, listing, { mode: 'fill' })
  assert.equal(second.changes.length, 0)
  assert.deepEqual(second.models, first.models)
})

/* ── planning the file edit ───────────────────────────────────────────────── */

const desired = new Map([
  ['trae/deepseek-v4.1-flash', ['text', 'image']],
  ['raccoon/sn-deepseek-v4-1-flash', ['text', 'image']],
  ['workbuddy/deepseek-v4.1-flash', ['text', 'image']],
])

test('the patch edit inserts `input` inside the right model and keeps everything else', () => {
  const raw = readFileSync(fixture('profile.patch.yml'), 'utf8')
  const lines = raw.split('\n')
  const planned = planPatchEdits(lines, desired, { entryId: 'llm-pi-ai' })
  assert.equal(planned.changed, true)
  const text = planned.lines.join('\n')

  // inserted at the end of each model's own block, at field indentation
  assert.match(text, /- id: trae\/deepseek-v4\.1-flash\n            name: deepseek-v4\.1-flash\n            contextWindow: 1048576\n            input:\n              - text\n              - image\n/)
  assert.match(text, /maxTokens: 100000\n            input:\n              - text\n              - image\n          - id: raccoon\/sn-deepseek-v4-1-flash-1017/)
  // a block-style declaration is rewritten in place, same shape, no duplication
  assert.match(text, /- id: workbuddy\/deepseek-v4\.1-flash\n            name: [^\n]+\n            contextWindow: 1000000\n            input:\n              - text\n              - image\n- id: subagent/)
  // untouched models keep no declaration at all
  assert.match(text, /- id: raccoon\/sn-deepseek-v4-1-flash-1017\n            name: [^\n]+\n            contextWindow: 1000000\n            maxTokens: 100000\n          # an endpoint/)
  // comments and the neighbouring row survive
  assert.match(text, /# ── the row this plugin owns ──/)
  assert.match(text, /# the author declared text on purpose; fill mode must respect it/)
  assert.match(text, /- id: ui-theme\n  name: "@deepseek-ai\/dsh-client-ui-theme"/)
})

test('the patch edit plans nothing the second time', () => {
  const raw = readFileSync(fixture('profile.patch.yml'), 'utf8')
  const once = planPatchEdits(raw.split('\n'), desired, { entryId: 'llm-pi-ai' })
  const twice = planPatchEdits(once.lines, desired, { entryId: 'llm-pi-ai' })
  assert.equal(twice.changed, false)
  assert.deepEqual(twice.lines, once.lines)
})

test('an unrelated entryId leaves the file untouched', () => {
  const raw = readFileSync(fixture('profile.patch.yml'), 'utf8')
  const planned = planPatchEdits(raw.split('\n'), desired, { entryId: 'llm-deepseek' })
  assert.equal(planned.changed, false)
})

test('field indentation is taken from the entry, not assumed', () => {
  const raw = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      salt:',
    '        models:',
    '          - id: trae/deepseek-v4.1-flash',
    '              name: odd alignment',
    '              contextWindow: 1048576',
    '- id: next',
  ].join('\n')
  const planned = planPatchEdits(raw.split('\n'), new Map([['trae/deepseek-v4.1-flash', ['text', 'image']]]), { entryId: 'llm-pi-ai' })
  assert.equal(planned.changed, true)
  assert.match(planned.lines.join('\n'), /contextWindow: 1048576\n {14}input:\n {16}- text\n {16}- image\n/)
})

test('an `input` nested deeper than the entry fields is never duplicated', () => {
  const raw = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      salt:',
    '        models:',
    '          - id: trae/deepseek-v4.1-flash',
    '            name: x',
    '            compat:',
    '              input: [text]',
    '- id: next',
  ].join('\n')
  const planned = planPatchEdits(raw.split('\n'), new Map([['trae/deepseek-v4.1-flash', ['text', 'image']]]), { entryId: 'llm-pi-ai' })
  assert.equal(planned.changed, false, 'leaves an ambiguous entry alone instead of writing a second key')
  assert.equal(planned.lines.filter((line) => /^\s*input:/.test(line)).length, 1)
})

/* ── writing the file ─────────────────────────────────────────────────────── */

test('writePatchFile preserves CRLF and leaves no temporary behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-vision-'))
  const target = join(dir, 'cordis.patch.yml')
  copyFileSync(fixture('profile.patch.yml'), target)
  const crlf = readFileSync(target, 'utf8').replace(/\n/g, '\r\n')
  writeFileSync(target, crlf, 'utf8')

  const result = writePatchFile(target, desired, { entryId: 'llm-pi-ai' })
  assert.equal(result.changed, true)
  const after = readFileSync(target, 'utf8')
  assert.ok(after.includes('\r\n'), 'CRLF was preserved')
  // Two declarations inserted (+3 lines each) plus one block rewritten 2 -> 3.
  assert.equal(after.split('\r\n').length, crlf.split('\r\n').length + 7, 'net line count is as planned')
  assert.equal(after.match(/^\s+- image$/gm)?.length, 3, 'exactly three declarations carry image')
  assert.deepEqual(readdirSync(dir), ['cordis.patch.yml'], 'no temporary file survived')

  assert.equal(writePatchFile(target, desired, { entryId: 'llm-pi-ai' }).changed, false)
})

/* ── config ───────────────────────────────────────────────────────────────── */

test('config defaults and rejections', () => {
  const defaults = normalizeConfig(undefined)
  assert.equal(defaults.entryId, 'llm-pi-ai')
  assert.equal(defaults.mode, 'fill')
  assert.equal(defaults.dryRun, false)
  assert.equal(defaults.intervalMs, 300000)

  assert.equal(normalizeConfig({ mode: 'sync' }).mode, 'sync')
  assert.throws(() => normalizeConfig({ mode: 'greedy' }), /mode/)
  assert.throws(() => normalizeConfig({ intervalMs: -1 }), /intervalMs/)
  assert.throws(() => normalizeConfig({ routes: 'salt' }), /routes/)
  assert.throws(() => normalizeConfig({ statusFile: 3 }), /statusFile/)
})

test('the bundle patch and the package agree on the row it mounts', () => {
  const patch = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: model-vision\n\s+name: dsh-model-vision/)
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.name, 'dsh-model-vision')
  assert.ok(existsSync(join(here, '..', 'lib', 'index.js')))
})

/* ── the sentence a person reads first ────────────────────────────────────── */

test('describeSweep says what happened without any field name', () => {
  const route = (models, listed, changes) => ({ models, listed, changes })
  assert.equal(describeSweep([route(58, 191, [{}, {}])], undefined, false, 2), '扫了 58 个模型（网关报了 191 个），补了 2 个的「输入类型：图片」')
  assert.equal(describeSweep([route(58, 191, [])], undefined, false, 0), '扫了 58 个模型（网关报了 191 个），没有要改的')
  assert.match(describeSweep([route(58, 191, [{}])], undefined, true, 1), /dryRun/)
  assert.match(describeSweep([], 'boom', false, 0), /^出错了：boom$/)
  assert.match(describeSweep([], undefined, false, 0), /没有可检查的模型/)
})

test('totalChanges sums across routes only', () => {
  assert.equal(totalChanges([{ changes: [{}, {}] }, { changes: [] }, { changes: [{}, {}] }]), 4)
  assert.equal(totalChanges([{}, { changes: undefined }]), 0)
  assert.equal(totalChanges([]), 0)
})

/* ── the vision marker on display names ───────────────────────────────────── */

const SUFFIX = ' · 可看图'

test('the marker is added once and removed cleanly', () => {
  assert.equal(applyBadge('DeepSeek-V4.1-Flash', SUFFIX), 'DeepSeek-V4.1-Flash · 可看图')
  assert.equal(applyBadge('DeepSeek-V4.1-Flash', SUFFIX), 'DeepSeek-V4.1-Flash · 可看图', 'idempotent')
  assert.equal(applyBadge('DeepSeek-V4.1-Flash · 可看图', SUFFIX), 'DeepSeek-V4.1-Flash · 可看图', 'never doubled')
  assert.equal(stripBadge('DeepSeek-V4.1-Flash · 可看图', SUFFIX), 'DeepSeek-V4.1-Flash')
  assert.equal(stripBadge('DeepSeek-V4.1-Flash', SUFFIX), 'DeepSeek-V4.1-Flash', 'nothing to strip')
  // A user who renames to something else keeps their text; we only own the tail.
  assert.equal(stripBadge('My Flash · 可看图 · v2', SUFFIX), 'My Flash · 可看图 · v2')
  assert.equal(applyBadge('x', ''), 'x', 'empty suffix disables decoration')
})

test('planModels marks the picker name for models that really take images', () => {
  const list = [
    { id: 'trae/deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1 },
    { id: 'raccoon/sn-deepseek-v4-1-flash-1017', name: 'DeepSeek-V4.1-Flash-1017 · 免费', contextWindow: 1 },
    { id: 'lobsterai/deepseek-flash', name: 'DeepSeek · x0.05', contextWindow: 1 },
  ]
  const plan = planModels(list, listing, { mode: 'fill', badgeSuffix: SUFFIX })
  const byId = Object.fromEntries(plan.models.map((model) => [model.id, model]))
  assert.equal(byId['trae/deepseek-v4.1-flash'].name, 'DeepSeek-V4.1-Flash · 可看图')
  assert.deepEqual(byId['trae/deepseek-v4.1-flash'].input, ['text', 'image'])
  assert.equal(byId['raccoon/sn-deepseek-v4-1-flash-1017'].name, 'DeepSeek-V4.1-Flash-1017 · 免费', 'text-only keeps its name')
  assert.equal(byId['lobsterai/deepseek-flash'].name, 'DeepSeek · x0.05', 'a silent gateway earns no marker')
  assert.equal(plan.changes.find((change) => change.id === 'trae/deepseek-v4.1-flash').badge, true)
})

test('an explicit text declaration earns no marker, even on a vision route', () => {
  const plan = planModels(
    [{ id: 'buddy/deepseek-v4.1-flash', name: 'Buddy Flash', input: ['text'] }],
    listing,
    { mode: 'fill', badgeSuffix: SUFFIX },
  )
  assert.equal(plan.models[0].name, 'Buddy Flash')
  assert.deepEqual(plan.held.map((item) => item.id), ['buddy/deepseek-v4.1-flash'])
})

test('sync takes the marker back off when the gateway stops serving images', () => {
  const plan = planModels(
    [{ id: 'raccoon/sn-deepseek-v4-1-flash-1017', name: 'Old Flash · 可看图', input: ['text', 'image'] }],
    listing,
    { mode: 'sync', badgeSuffix: SUFFIX },
  )
  assert.equal(plan.models[0].name, 'Old Flash')
  assert.deepEqual(plan.models[0].input, ['text'])
})

test('the marker alone is enough to justify a write', () => {
  // Already declared correctly, only the name is stale: the sweep must still run.
  const plan = planModels(
    [{ id: 'trae/deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', input: ['text', 'image'] }],
    listing,
    { mode: 'fill', badgeSuffix: SUFFIX },
  )
  assert.equal(plan.changes.length, 1)
  assert.equal(plan.changes[0].inputChanged, false)
  assert.equal(plan.changes[0].badge, true)
})

test('the patch writer can move a name without touching the declaration', () => {
  const raw = readFileSync(fixture('profile.patch.yml'), 'utf8')
  const desired = new Map([['trae/deepseek-v4.1-flash', { name: 'DeepSeek-V4.1-Flash · 可看图' }]])
  const planned = planPatchEdits(raw.split('\n'), desired, { entryId: 'llm-pi-ai' })
  const text = planned.lines.join('\n')
  assert.match(text, /- id: trae\/deepseek-v4\.1-flash\n            name: DeepSeek-V4\.1-Flash · 可看图\n            contextWindow: 1048576/)
  assert.equal(text.match(/name: DeepSeek-V4\.1-Flash · 可看图/g)?.length, 1, 'replaced, not appended')
  assert.equal(planPatchEdits(planned.lines, desired, { entryId: 'llm-pi-ai' }).changed, false, 'idempotent')
})

test('the patch writer quotes a name that would otherwise be misread', () => {
  const raw = readFileSync(fixture('profile.patch.yml'), 'utf8')
  const desired = new Map([['trae/deepseek-v4.1-flash', { name: 'A: B # 可看图' }]])
  const text = planPatchEdits(raw.split('\n'), desired, { entryId: 'llm-pi-ai' }).lines.join('\n')
  assert.match(text, /name: 'A: B # 可看图'/)
})

test('the sweep sentence separates declarations from markers', () => {
  const both = [{ models: 10, listed: 20, changes: [{ id: 'a', badge: true, inputChanged: true }, { id: 'b', badge: false, inputChanged: true }] }]
  assert.equal(describeSweep(both, undefined, false, 2), '扫了 10 个模型（网关报了 20 个），补了 2 个的「输入类型：图片」，并给 1 个名字加了「可看图」')

  const markerOnly = [{ models: 10, listed: 20, changes: [{ id: 'a', badge: true, inputChanged: false }] }]
  assert.equal(describeSweep(markerOnly, undefined, false, 1), '扫了 10 个模型（网关报了 20 个），给 1 个名字加了「可看图」')
})
