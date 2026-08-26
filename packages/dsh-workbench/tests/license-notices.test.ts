import { describe, expect, it } from 'vitest'
import packageJsonRaw from '../package.json?raw'
import notices from '../THIRD_PARTY_NOTICES.md?raw'

const packageJson = JSON.parse(packageJsonRaw) as { files?: unknown }

describe('bundled third-party notices', () => {
  it('ships the canonical notice file in the Workbench package', () => {
    expect(packageJson.files).toContain('THIRD_PARTY_NOTICES.md')
  })

  it('retains the complete shared MIT notice for bundled dependencies', () => {
    expect(notices).toContain('@deepseek-ai/schemastery` 3.18.1')
    expect(notices).toContain('@deepseek-ai/cosmokit` 1.8.2')
    expect(notices).toContain('Copyright (c) 2021-present Shigma')
    expect(notices).toContain('Permission is hereby granted, free of charge')
    expect(notices).toContain('The above copyright notice and this permission notice')
    expect(notices).toContain('THE SOFTWARE IS PROVIDED "AS IS"')
    expect(notices).toContain('OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE')
  })
})
