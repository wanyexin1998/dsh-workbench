/**
 * Install-manifest test (issue #12 acceptance): the committed
 * cordis.patch.yml must wire the dsh-workbench client bundle row into a DSH
 * web profile (id + resolvable package name at the same include level as
 * every other web bundle).
 */
import { describe, expect, it } from 'vitest'
import patch from '../cordis.patch.yml?raw'

describe('install manifest (cordis.patch.yml)', () => {
  it('inserts the workbench bundle row: stable id + resolvable scoped package name', () => {
    expect(patch).toMatch(/^\s*-\s*id:\s*dsh-workbench\s*$/m)
    expect(patch).toMatch(/^\s*name:\s*'@wanyexin1998\/dsh-workbench'\s*$/m)
  })

  it('declares the patch as an insert (additive, never replaces a row)', () => {
    expect(patch).toMatch(/^\s*-\s*insert:\s*$/m)
  })
})
