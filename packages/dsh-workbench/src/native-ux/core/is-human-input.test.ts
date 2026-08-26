import { describe, expect, it } from 'vitest'
import { isHumanInputKind } from './is-human-input.js'

describe('isHumanInputKind (seam A sample)', () => {
  it('accepts user and steering', () => {
    expect(isHumanInputKind('user')).toBe(true)
    expect(isHumanInputKind('steering')).toBe(true)
  })

  it('rejects context, assistant, tool and unknown', () => {
    expect(isHumanInputKind('context')).toBe(false)
    expect(isHumanInputKind('assistant')).toBe(false)
    expect(isHumanInputKind('tool-result')).toBe(false)
    expect(isHumanInputKind(undefined)).toBe(false)
  })
})
