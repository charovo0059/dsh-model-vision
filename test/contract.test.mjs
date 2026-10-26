/**
 * Contract tests: the two halves of this plugin are versioned separately — the
 * browser bundle is served from the profile, the host half from the running
 * harness — and they only agree because they spell the same names.
 *
 * This file is the guard for "跨版本简单维护": if either side renames the RPC
 * path, the header, the protocol number, or the slot it mounts into, the suite
 * fails here instead of the button silently vanishing in the UI.
 *
 *   node test/contract.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RPC_PATH, RPC_HEADER, PROTOCOL_VERSION } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
const hostSource = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

/**
 * Read one string literal out of the client's CONTRACT block.
 * @param key - the property name.
 * @returns the literal as written there.
 */
function contractString(key) {
  const match = new RegExp(`${key}: '([^']+)'`).exec(clientSource)
  assert.notEqual(match, null, `client CONTRACT.${key} is missing`)
  return match[1]
}

/** Read one numeric literal out of the client's CONTRACT block. */
function contractNumber(key) {
  const match = new RegExp(`${key}: (\\d+)`).exec(clientSource)
  assert.notEqual(match, null, `client CONTRACT.${key} is missing`)
  return Number(match[1])
}

test('both halves agree on where the button posts', () => {
  assert.equal(contractString('rpcPath'), RPC_PATH)
  assert.equal(contractString('rpcHeader'), RPC_HEADER)
  assert.equal(contractNumber('protocol'), PROTOCOL_VERSION)
})

test('the host sends the protocol number it declares', () => {
  assert.match(hostSource, /sendJson\(res, 200, \{ ok: true, protocol: PROTOCOL_VERSION, \.\.\.report \}\)/)
})

test('the client mounts into the footer slot, with a page as the safety net', () => {
  assert.equal(contractString('slot'), 'settings.models.footer')
  assert.equal(contractString('fallbackSlot'), 'settings.section')
  // The main path must be the footer: registering the page unconditionally is
  // what produced two entries in the UI, which is the thing this guards against.
  assert.match(clientSource, /ctx\.slots\.inject\(CONTRACT\.slot, mountInFooter\)/)
  // The page fallback is reached only from a timer that first checks `mounted`.
  assert.match(clientSource, /const timer = setTimeout\(\(\) => \{\n\s+if \(mounted\) return\n\s+ctx\.slots\.inject\(CONTRACT\.fallbackSlot, mountAsPage\)/)
})

test('the client registers no settings page of its own unless the slot is missing', () => {
  const registers = clientSource.match(/slots\.register\(/g) ?? []
  assert.equal(registers.length, 2, 'exactly two registration sites: footer and fallback')
  // The fallback is inside mountAsPage, which returns early once mounted.
  assert.match(clientSource, /const mountAsPage = \(\) => \{\n {8}if \(mounted\) return undefined/)
})

test('the client only writes the field this plugin owns', () => {
  // A UI bundle that starts patching settings would silently break the premise
  // that the button touches nothing but `input`.
  assert.equal(/setCell|setSettings|\.save\(/.test(clientSource), false)
})

test('the bundle still declares its browser half', () => {
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.match(clientSource, /__ModuleLoader__\.load\(\{\n {2}id: 'dsh-model-vision'/)
  assert.equal(pkg.name, 'dsh-model-vision')
})

test('the RPC path is loopback-only by construction', () => {
  // The handler refuses non-loopback hosts; the constant is documented here so a
  // future route change has to think about it too.
  assert.ok(RPC_PATH.startsWith('/plugins/'))
  assert.match(hostSource, /if \(!isLoopbackHost\(req\.headers\.host\)\) return sendJson\(res, 403/)
  assert.match(hostSource, /if \(req\.headers\[RPC_HEADER\] === undefined\) return sendJson\(res, 403/)
})
