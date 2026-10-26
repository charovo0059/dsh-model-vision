#!/usr/bin/env node
/**
 * Preview what dsh-model-vision would write, without writing anything.
 *
 * Reads one profile's `cordis.patch.yml`, asks that route's gateway for its
 * model listing, runs the same planner the plugin uses, and prints the diff it
 * would apply. Nothing is written, no service is touched, so this is safe to run
 * while the harness is up.
 *
 *   node tools/preview.mjs                     # profile web, mode fill
 *   node tools/preview.mjs --profile desktop
 *   node tools/preview.mjs --mode sync
 *   node tools/preview.mjs --base-url http://127.0.0.1:18900/v1 --key-env GATEWAY_KEY
 */

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readVision, readDeclared, decideInput, readListing, planPatchEdits } from '../lib/index.js'
import { probeVision } from '../lib/probe.js'

/* ── arguments ────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 || index === argv.length - 1 ? fallback : argv[index + 1]
}

const profile = arg('profile', 'web')
const mode = arg('mode', 'fill')
const entryId = arg('entry', 'llm-pi-ai')
const only = arg('route')
const timeoutMs = Number(arg('timeout', '15000'))
const probe = argv.includes('--probe')
const probeRounds = Number(arg('rounds', '2'))
const maxProbes = Number(arg('max-probes', '20'))

const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
const patchPath = join(dshHome, 'profiles', profile, 'cordis.patch.yml')

if (!existsSync(patchPath)) {
  console.error(`找不到 profile 补丁：${patchPath}`)
  process.exit(2)
}

/* ── a deliberately small reader for the patch's llm-pi-ai row ────────────── */

const indentOf = (line) => (/^\s*/.exec(line) ?? [''])[0].length
const bare = (value) => {
  const trimmed = value.trim()
  const quoted = /^(['"])(.*)\1$/.exec(trimmed)
  return quoted === null ? trimmed : quoted[2]
}

/** Collect the row's scalar fields and its model entries, by indentation. */
function readRow(lines) {
  const start = lines.findIndex((line) => /^\s*-\s+id:/.test(line) && bare(line.replace(/^\s*-\s+id:\s*/, '')) === entryId)
  if (start === -1) return undefined
  let end = lines.findIndex((line, index) => index > start && /^- id: /.test(line))
  if (end === -1) end = lines.length

  const row = { start, end, baseURL: undefined, apiKeyEnv: undefined, models: [] }
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i]
    const base = /^\s*baseURL:\s*(.+?)\s*$/.exec(line)
    if (base !== null && row.baseURL === undefined) row.baseURL = bare(base[1])
    const key = /^\s*apiKeyEnv:\s*(.+?)\s*$/.exec(line)
    if (key !== null && row.apiKeyEnv === undefined) row.apiKeyEnv = bare(key[1])
    const header = /^(\s*)-\s+id:\s*(.+?)\s*$/.exec(line)
    if (header === null) continue
    // A route is a `- id:` that owns a `models:` list; a model is a `- id:`
    // below one. Models always sit deeper than the route they belong to.
    const idIndent = header[1].length
    let hasModels = false
    for (let k = i + 1; k < end; k += 1) {
      if (/^\s*-\s+id:\s*/.test(lines[k])) break
      if (indentOf(lines[k]) <= idIndent && lines[k].trim() !== '') break
      if (indentOf(lines[k]) === idIndent + 2 && /^\s*models:/.test(lines[k])) { hasModels = true; break }
    }
    if (hasModels) continue
    // declared input: inline array, or a block list just below
    let declared
    for (let k = i + 1; k < end; k += 1) {
      if (/^\s*-\s+id:\s*/.test(lines[k])) break
      const inline = /^\s*input:\s*\[(.*)\]\s*$/.exec(lines[k])
      if (inline !== null) { declared = inline[1].split(',').map((part) => part.trim()).filter(Boolean); break }
      if (/^\s*input:\s*$/.test(lines[k])) {
        const items = []
        for (let e = k + 1; e < end; e += 1) {
          const item = /^\s*-\s*(\S+)\s*$/.exec(lines[e])
          if (item === null) break
          items.push(bare(item[1]))
        }
        declared = items
        break
      }
    }
    row.models.push({ id: bare(header[2]), line: i, declared: readDeclared(declared) })
  }
  return row
}

/** Resolve one credential: process env first, then the harness credential file. */
function resolveKey(ref) {
  if (ref === undefined) return undefined
  if (typeof process.env[ref] === 'string' && process.env[ref].length > 0) return process.env[ref]
  try {
    const file = join(dshHome, '.credentials.yaml')
    const text = readFileSync(file, 'utf8')
    const refs = text.split(/^refs:\s*$/m)[1]
    if (refs === undefined) return undefined
    const hit = new RegExp(`^\\s+${ref}:\\s*(.+?)\\s*$`, 'm').exec(refs)
    return hit === null ? undefined : bare(hit[1])
  } catch {
    return undefined
  }
}

/* ── display ──────────────────────────────────────────────────────────────── */

const colour = process.stdout.isTTY
  ? { dim: (s) => `\u001b[2m${s}\u001b[0m`, green: (s) => `\u001b[32m${s}\u001b[0m`, red: (s) => `\u001b[31m${s}\u001b[0m`, bold: (s) => `\u001b[1m${s}\u001b[0m`, yellow: (s) => `\u001b[33m${s}\u001b[0m` }
  : { dim: (s) => s, green: (s) => s, red: (s) => s, bold: (s) => s, yellow: (s) => s }

/** Line diff by longest common subsequence, for display only. */
function diff(before, after) {
  const n = before.length
  const m = after.length
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) { out.push([' ', before[i]]); i += 1; j += 1 }
    else if (table[i + 1][j] >= table[i][j + 1]) { out.push(['-', before[i]]); i += 1 }
    else { out.push(['+', after[j]]); j += 1 }
  }
  while (i < n) { out.push(['-', before[i]]); i += 1 }
  while (j < m) { out.push(['+', after[j]]); j += 1 }
  return out
}

/* ── main ─────────────────────────────────────────────────────────────────── */

const raw = readFileSync(patchPath, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const lines = raw.split(/\r?\n/)
const row = readRow(lines)

if (row === undefined) {
  console.error(`补丁里没有 ${entryId} 这一行：${patchPath}`)
  process.exit(2)
}

const baseURL = arg('base-url', row.baseURL)
const keyRef = arg('key-env', row.apiKeyEnv)
if (baseURL === undefined) {
  console.error(`补丁里没有 baseURL，也没有传 --base-url`)
  process.exit(2)
}

console.log(colour.bold(`补丁  ${patchPath}`))
console.log(colour.bold(`路由  ${baseURL}  (entry=${entryId}, mode=${mode})${only ? `  route=${only}` : ''}`))

const apiKey = resolveKey(keyRef)
console.log(colour.dim(`凭据  ${keyRef ?? '（无）'} ${apiKey === undefined ? '—— 未找到，将匿名请求' : '—— 已找到'}`))

const url = `${baseURL.replace(/\/+$/, '')}/models`
let listing
try {
  const response = await fetch(url, {
    headers: { accept: 'application/json', ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }) },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  listing = readListing(await response.json())
} catch (error) {
  console.error(colour.red(`\n读不到模型清单：${error instanceof Error ? error.message : String(error)}`))
  process.exit(1)
}

const byId = new Map(listing.map((item) => [item.id, item.raw]))
console.log(colour.dim(`网关   ${listing.length} 个模型\n`))

const desired = new Map()
const rows = []
const held = []

// What the listing says. With --probe, silent models are asked directly — the
// same thing the settings page button does, but read-only.
const verdicts = new Map(row.models.map((model) => [model.id, readVision(byId.get(model.id))]))
if (probe) {
  const auth = { accept: 'application/json', ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }) }
  let used = 0
  for (const model of row.models) {
    if (verdicts.get(model.id) !== undefined) continue
    if (used >= maxProbes) break
    used += 1
    process.stdout.write(colour.dim(`  探测 ${model.id} … `))
    const outcome = await probeVision({ api: 'openai-completions', baseURL, model: model.id, headers: auth, rounds: probeRounds, timeoutMs: Math.max(timeoutMs, 30000) })
    verdicts.set(model.id, outcome.verdict)
    const label = outcome.verdict === undefined ? colour.yellow('没结论') : outcome.verdict ? colour.green('能看图') : colour.dim('只能读文字')
    console.log(`${label}  ${colour.dim(outcome.evidence.join('; '))}`)
  }
}

for (const model of row.models) {
  const vision = verdicts.get(model.id)
  const decided = decideInput(model.declared, vision, mode)
  const state = vision === undefined ? colour.dim('未声明') : vision ? colour.green('支持图片') : colour.dim('纯文本')
  let action
  if (decided !== undefined) {
    action = colour.green(`写入 [${decided.join(', ')}]`)
    desired.set(model.id, decided)
  } else if (mode === 'fill' && vision === true && model.declared !== undefined) {
    const text = `保持 [${model.declared.join(', ')}]（已显式声明，fill 不动）`
    action = colour.yellow(text)
    held.push(model.id)
  } else {
    action = colour.dim('不动')
  }
  rows.push([model.id, state, model.declared === undefined ? colour.dim('—') : `[${model.declared.join(', ')}]`, action])
}

const width = Math.max(...rows.map((cells) => cells[0].length), 10)
for (const cells of rows) {
  console.log(`  ${cells[0].padEnd(width)}  ${cells[1]}  ${cells[2].padEnd(14)}  ${cells[3]}`)
}

if (row.models.length === 0) console.log(colour.yellow('  这一行没有模型条目。'))

const planned = planPatchEdits(lines, desired, { entryId })
if (!planned.changed) {
  console.log(colour.bold('\n没有要改的内容：每个受管模型都已经和网关一致。'))
  process.exit(0)
}

console.log(colour.bold(`\n将要写入 ${desired.size} 个声明（下面是补丁的真实 diff，带上下文）：\n`))
printHunks(diff(lines, planned.lines), 3)

console.log(colour.dim(`\n只读预览：没有写任何文件。要真的生效，装插件并把 dryRun 关掉。`))
console.log(colour.dim(`行尾 ${eol === '\r\n' ? 'CRLF' : 'LF'}，注释与其它字段原样保留。`))

/**
 * Print a line diff as hunks, keeping `context` unchanged lines around every
 * change so a reader can see which model entry each line landed in.
 * @param ops - `[mark, line]` pairs from {@link diff}.
 * @param context - unchanged lines to keep on each side of a change.
 */
function printHunks(ops, context) {
  const changed = ops.map((op, index) => (op[0] === ' ' ? -1 : index)).filter((index) => index !== -1)
  if (changed.length === 0) return
  const groups = []
  for (const index of changed) {
    const from = Math.max(0, index - context)
    const to = Math.min(ops.length - 1, index + context)
    const last = groups.at(-1)
    if (last !== undefined && from <= last.to + 1) last.to = Math.max(last.to, to)
    else groups.push({ from, to })
  }
  for (const group of groups) {
    console.log(colour.dim(`  @@ ${group.from + 1} @@`))
    for (let i = group.from; i <= group.to; i += 1) {
      const [mark, line] = ops[i]
      if (mark === '+') console.log(colour.green(`  + ${line}`))
      else if (mark === '-') console.log(colour.red(`  - ${line}`))
      else console.log(colour.dim(`    ${line}`))
    }
    console.log('')
  }
}
