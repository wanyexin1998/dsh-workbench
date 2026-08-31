// T8 follow-up (Primary+Space IME-toggle fix): locales.ts carries no
// compile-time key-parity guarantee between zh/en (unlike dictionaries.ts's
// `en satisfies Record<WorkbenchLocaleKey, string>`) — a key added to one
// dictionary and forgotten in the other would silently fall back to the raw
// key string at runtime (see the `t()` callers throughout this package) with
// no type error. This is the runtime guard that gap needs.
import { describe, expect, it } from 'vitest'
import { en, zh } from './locales.js'

describe('locales (zh/en dictionaries)', () => {
  it('zh and en declare exactly the same set of keys', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  it('every value is a non-empty string in both dictionaries', () => {
    for (const [dictName, dictionary] of [['zh', zh], ['en', en]] as const) {
      for (const [key, value] of Object.entries(dictionary)) {
        expect(typeof value, `${dictName}['${key}']`).toBe('string')
        expect(value.length > 0, `${dictName}['${key}'] should not be empty`).toBe(true)
      }
    }
  })

  // Pin: the new reserved-chord note this fix added must exist in both
  // dictionaries (regression target for the "key 数量必须保持相等" check).
  it('carries reserved.note.imeToggle in both dictionaries', () => {
    expect(zh['reserved.note.imeToggle']).toBeTruthy()
    expect(en['reserved.note.imeToggle']).toBeTruthy()
  })
})
