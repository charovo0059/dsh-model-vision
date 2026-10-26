#!/usr/bin/env node
/**
 * Render the marketplace images from the HTML in `docs/`.
 *
 * The pictures are build output, not hand-made art: change the copy in
 * `docs/panel-*.html`, run this, and the PNGs follow. That is what keeps a
 * screenshot from going stale the next time the plugin's wording changes.
 *
 * Requires a Chromium-family browser. Edge ships with Windows, so that is the
 * default; override with SHOTS_BROWSER=<path to chrome/msedge>.
 *
 *   node tools/shots.mjs
 *   node tools/shots.mjs --out docs
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

/** Where a Chromium-family browser usually lives on Windows. */
const CANDIDATES = [
  process.env.SHOTS_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
].filter((entry) => typeof entry === 'string' && entry.length > 0)

/**
 * playwright-core is not a dependency of this plugin (it is only needed to
 * regenerate the marketplace images), so it is resolved from wherever the
 * caller has it: the local install, or SHOTS_PLAYWRIGHT=<path>.
 */
const PLAYWRIGHT = ['playwright-core', process.env.SHOTS_PLAYWRIGHT].filter((entry) => typeof entry === 'string' && entry.length > 0)

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const outIndex = argv.indexOf('--out')
const outDir = resolve(here, outIndex === -1 ? 'docs' : argv[outIndex + 1])

const executablePath = CANDIDATES.find((candidate) => existsSync(candidate))
if (executablePath === undefined) {
  console.error('找不到 Chromium 内核浏览器；用 SHOTS_BROWSER=<路径> 指定一个 chrome/msedge。')
  process.exit(2)
}

let chromium
for (const candidate of PLAYWRIGHT) {
  try {
    chromium = require(candidate).chromium
    break
  } catch {
    /* try the next candidate */
  }
}
if (chromium === undefined) {
  console.error('找不到 playwright-core；先 npm i -D playwright-core，或改本脚本里的路径。')
  process.exit(2)
}

mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch({ executablePath })

/** Pages to shoot, with the PNG each one produces. */
const SHOTS = [
  { html: 'docs/panel-button.html', png: 'screenshot-button.png', width: 1080, height: 790 },
  { html: 'docs/panel-result.html', png: 'screenshot-result.png', width: 1080, height: 575 },
]

for (const shot of SHOTS) {
  const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: 2 })
  await page.goto(pathToFileURL(join(here, shot.html)).href, { waitUntil: 'load' })
  await page.screenshot({ path: join(outDir, shot.png), fullPage: true })
  await page.close()
  console.log(`✓ ${join(outDir, shot.png)}`)
}

// The market asks for a raster icon hosted on GitHub (drawn at ~96px), so the
// SVG source is rendered here rather than shipped as-is. Two sizes: 512 for the
// README, 180 for the storefront tile.
for (const [size, target] of [[512, join(outDir, 'icon.png')], [180, join(here, 'assets/icon-180.png')]]) {
  const icon = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
  await icon.goto(pathToFileURL(join(here, 'assets/icon.html')).href, { waitUntil: 'load' })
  await icon.screenshot({ path: target })
  await icon.close()
  console.log(`✓ ${target}`)
}

await browser.close()
