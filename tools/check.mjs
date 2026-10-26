#!/usr/bin/env node
/**
 * Check whether dsh-model-vision is wired into one profile, without changing
 * anything. Reports each step that is missing, in the order a real install
 * needs it.
 *
 *   node tools/check.mjs                 # profile web
 *   node tools/check.mjs --profile desktop
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 || index === argv.length - 1 ? fallback : argv[index + 1]
}

const profile = arg('profile', 'web')
const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profile)
const packagePath = join(profileDir, 'package.json')

const ok = (label, detail) => console.log(`  \u001b[32m✔\u001b[0m ${label}${detail ? `  \u001b[2m${detail}\u001b[0m` : ''}`)
const no = (label, fix) => {
  console.log(`  \u001b[31m✘\u001b[0m ${label}`)
  if (fix) console.log(`    \u001b[2m${fix}\u001b[0m`)
}

console.log(`\nprofile  ${profileDir}\n`)

if (!existsSync(packagePath)) {
  no(`profile 不存在`, `先在 DSH 里打开过一次 ${profile} profile，或 dsh plugin --profile ${profile} list`)
  process.exit(2)
}

const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
let missing = 0

// 1. declared as a dependency of the profile
const dependency = pkg.dependencies?.['dsh-model-vision']
if (dependency === undefined) {
  missing += 1
  no('package.json 里没有 dsh-model-vision', `dsh plugin --profile ${profile} add link:${here}`)
} else {
  ok('依赖已声明', dependency)
}

// 2. mounted as a bundle, which is what actually loads it
const bundles = pkg.dsh?.profile?.bundles ?? []
if (!bundles.includes('dsh-model-vision')) {
  missing += 1
  no('dsh.profile.bundles 里没有 dsh-model-vision', `在 ${packagePath} 的 dsh.profile.bundles 末尾加 "dsh-model-vision"`)
} else {
  ok('已挂进 bundles', `第 ${bundles.indexOf('dsh-model-vision') + 1} 位 / 共 ${bundles.length}`)
}

// 3. the link resolves inside the profile
const linked = join(profileDir, 'node_modules', 'dsh-model-vision')
if (!existsSync(linked)) {
  missing += 1
  no('node_modules 里没有链接', 'pnpm install 还没跑过，或 link 指向了别处')
} else {
  try {
    const target = realpathSync(linked)
    ok('链接已就位', target === realpathSync(here) ? target : `指向 ${target}，不是 ${here}`)
  } catch {
    ok('链接已就位', linked)
  }
}

// 4. the profile patch is where a sweep would write
const patchPath = join(profileDir, 'cordis.patch.yml')
if (!existsSync(patchPath)) {
  missing += 1
  no('没有 cordis.patch.yml', `这个 profile 还没有配置层，插件无处可写`)
} else {
  const text = readFileSync(patchPath, 'utf8')
  const row = /^\s*-\s+id:\s*llm-pi-ai\s*$/m.test(text)
  if (row) ok('补丁里有 llm-pi-ai 这一行')
  else {
    missing += 1
    no('补丁里没有 llm-pi-ai 这一行', '先配置一个自定义供应商并获取模型，插件才有可写的目标')
  }
  if (/^\s*-\s+id:\s*model-vision\s*$/m.test(text)) {
    const dry = /dryRun:\s*true/.test(text)
    ok('补丁里已有 model-vision 覆盖', dry ? 'dryRun: true —— 只记录不写盘' : '正常写入')
  } else {
    console.log(`  \u001b[2m·\u001b[0m 补丁里没有 model-vision 覆盖，将使用 bundle 自带默认值`)
  }
}

// 5. the status document, which is where "why nothing happened" is answered
const statusPath = join(dshHome, 'model-vision.status.json')
if (existsSync(statusPath)) {
  try {
    const status = JSON.parse(readFileSync(statusPath, 'utf8'))
    ok('状态文档存在', `${status.phase} · ${status.updatedAt}`)
    // The one line worth reading. Everything below it is for machines.
    if (typeof status.message === 'string' && status.message.length > 0) {
      console.log(`    \u001b[1m${status.message}\u001b[0m`)
    }
    for (const route of status.routes ?? []) {
      console.log(`    \u001b[2m${route.route}: 列出 ${route.listed} / 本地 ${route.models}，变更 ${route.changes?.length ?? 0}${route.error ? `，错误 ${route.error}` : ''}\u001b[0m`)
    }
    if (status.error) console.log(`    \u001b[31m错误 ${status.error}\u001b[0m`)
  } catch {
    ok('状态文档存在（但读不出来）', statusPath)
  }
} else {
  console.log(`  \u001b[2m·\u001b[0m 还没有状态文档 —— 重启 DSH 后第一次 sweep 会写 ${statusPath}`)
}

console.log(missing === 0 ? '\n\u001b[32m接线完整。\u001b[0m重启 DSH 后看状态文档确认第一次 sweep。\n' : `\n缺少 ${missing} 步。\n`)
process.exit(missing === 0 ? 0 : 1)
