// Bundle the plugin into the layout Obsidian expects: a folder with
// `main.js` + `manifest.json` + `styles.css`. We build into `dist/` so the
// folder is a drop-in install (symlink or copy it to
// `<vault>/.obsidian/plugins/everyapi/`).
//
// `obsidian`, `electron` and the CodeMirror packages are provided by the
// Obsidian runtime — they must stay external or esbuild would try (and fail)
// to resolve them from node_modules.
//
// `@everyapi-ai/gateway` is vendored under `src/gateway/`; the alias below
// (mirrored by the tsconfig `paths` entry) makes the unchanged plugin imports
// resolve to that local copy so it is bundled inline, not left external.

import { copyFile, mkdir } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'

const root = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [resolve(root, 'src/main.ts')],
  bundle: true,
  outfile: resolve(root, 'dist/main.js'),
  alias: {
    '@everyapi-ai/gateway': resolve(root, 'src/gateway/index.ts'),
  },
  // Plugins run in Electron's renderer process: browser platform, but
  // Obsidian loads the bundle with require(), hence cjs output.
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtinModules,
  ],
  // Inline in dev: Obsidian's devtools can't load external .map files from
  // plugin folders. Dropped entirely in production builds.
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
}

async function copyStatic() {
  await mkdir(resolve(root, 'dist'), { recursive: true })
  await copyFile(resolve(root, 'manifest.json'), resolve(root, 'dist/manifest.json'))
  await copyFile(resolve(root, 'styles.css'), resolve(root, 'dist/styles.css'))
}

await copyStatic()
if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  // esbuild only watches its inputs (src/**) — re-copy the static halves of
  // the plugin folder ourselves so editing styles.css/manifest.json during
  // dev doesn't leave dist/ stale.
  const { watch: fsWatch } = await import('node:fs')
  for (const f of ['manifest.json', 'styles.css']) {
    fsWatch(resolve(root, f), () => void copyStatic().catch(() => {}))
  }
  console.log('watching…')
} else {
  await esbuild.build(options)
}
