import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  CHAT_PRESET_COMPOSITION,
  CHAT_PRESET_METADATA,
  SEED_MARKER,
  seedChatPreset,
  type SeedIo,
} from './preset-seed.ts'

const ROOT = join('/', 'home', '.dsh', '.agent-presets')

/** In-memory SeedIo: `entries` holds files (path → text) and dirs (path → null). */
function memoryIo(entries: Map<string, string | null> = new Map()): { io: SeedIo; entries: Map<string, string | null> } {
  return {
    entries,
    io: {
      async exists(path) {
        return entries.has(path)
      },
      async mkdir(path) {
        entries.set(path, null)
      },
      async writeFile(path, text) {
        entries.set(path, text)
      },
    },
  }
}

describe('seedChatPreset', () => {
  it('seeds preset files and the marker into an empty root', async () => {
    const { io, entries } = memoryIo()
    const outcome = await seedChatPreset(ROOT, io)
    expect(outcome).toBe('seeded')
    expect(entries.get(join(ROOT, 'chat', 'preset.yml'))).toBe(CHAT_PRESET_METADATA)
    expect(entries.get(join(ROOT, 'chat', 'agent.cordis.yml'))).toBe(CHAT_PRESET_COMPOSITION)
    expect(entries.has(join(ROOT, SEED_MARKER))).toBe(true)
  })

  it('never touches an existing chat directory, but records the marker', async () => {
    const { io, entries } = memoryIo(
      new Map([
        [join(ROOT, 'chat'), null],
        [join(ROOT, 'chat', 'preset.yml'), 'name: 用户自定义\n'],
      ]),
    )
    const outcome = await seedChatPreset(ROOT, io)
    expect(outcome).toBe('already-present')
    expect(entries.get(join(ROOT, 'chat', 'preset.yml'))).toBe('name: 用户自定义\n')
    expect(entries.has(join(ROOT, SEED_MARKER))).toBe(true)
  })

  it('respects user deletion: marker without directory means no re-seed', async () => {
    const { io, entries } = memoryIo(new Map([[join(ROOT, SEED_MARKER), 'chat\n']]))
    const outcome = await seedChatPreset(ROOT, io)
    expect(outcome).toBe('user-removed')
    expect(entries.has(join(ROOT, 'chat'))).toBe(false)
  })

  it('is idempotent across repeated runs', async () => {
    const { io } = memoryIo()
    expect(await seedChatPreset(ROOT, io)).toBe('seeded')
    expect(await seedChatPreset(ROOT, io)).toBe('already-present')
  })

  it('propagates io failures to the caller (the entry point warns, fail-soft)', async () => {
    const { io } = memoryIo()
    io.writeFile = async () => {
      throw new Error('disk full')
    }
    await expect(seedChatPreset(ROOT, io)).rejects.toThrow('disk full')
  })
})
