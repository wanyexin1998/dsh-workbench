import { describe, expect, it } from 'vitest'

import clientBundle from '../lib/client.js?raw'
import packageJsonText from '../package.json?raw'

interface ModuleLoaderHandoff {
  id: string
  factory: (require: (id: string) => unknown) => unknown
}

describe('built client ModuleLoader handoff', () => {
  it('registers exactly once under package.json.name', () => {
    const handoffs: ModuleLoaderHandoff[] = []
    const fakeWindow = {
      __ModuleLoader__: {
        load: (handoff: ModuleLoaderHandoff) => handoffs.push(handoff),
      },
    }

    Function('window', clientBundle)(fakeWindow)

    expect(handoffs).toHaveLength(1)
    expect(handoffs[0]?.id).toBe(JSON.parse(packageJsonText).name)
    expect(typeof handoffs[0]?.factory).toBe('function')
  })
})
