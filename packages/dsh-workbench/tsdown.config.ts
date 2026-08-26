import { createRequire } from 'node:module'

import type { UserConfig } from 'tsdown'

/**
 * Client-bundle build mirroring the DSH loader handoff: the artifact wraps
 * itself in window.__ModuleLoader__.load({ id, factory }) and resolves the
 * platform modules through the injected require (no globals, no import map).
 * The standalone package mirrors the latest Harness client module loader.
 */

/** The shell's frozen module table (platform seed entries). */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
] as const

const packageJson = createRequire(import.meta.url)('./package.json') as { name?: unknown }
if (typeof packageJson.name !== 'string' || packageJson.name.length === 0) {
  throw new Error('dsh-workbench: package.json.name must be a non-empty string')
}
const ID = packageJson.name

const libConfig: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { onlyBundle: false },
}

const clientConfig: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: [...PLATFORM_MODULES],
    alwaysBundle: (id: string) => !PLATFORM_MODULES.includes(id as never),
    onlyBundle: false,
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [libConfig, clientConfig]
