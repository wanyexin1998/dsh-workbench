// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildWorkspacePathIndex,
  hasSameWorkspaceConflict,
  normalizeCwd,
  paneWorkspaceKey,
  SameWorkspaceWarning,
  type WorkspaceFacts,
} from '../src/client/same-workspace-warning.tsx'
import { en, zh } from '../src/client/dictionaries.ts'

afterEach(cleanup)

describe('normalizeCwd (UI-05 fallback tier: Windows variants collapse)', () => {
  it('drive-letter case, separators, trailing slash and dots collapse to one key', () => {
    const canonical = normalizeCwd('C:\\repo')
    expect(normalizeCwd('c:\\repo')).toBe(canonical)
    expect(normalizeCwd('C:/repo')).toBe(canonical)
    expect(normalizeCwd('C:\\repo\\')).toBe(canonical)
    expect(normalizeCwd('C:\\repo\\.\\')).toBe(canonical)
    expect(canonical).toBe('c:/repo')
  })

  it('folds .. segments lexically', () => {
    expect(normalizeCwd('C:/repo/../repo/sub')).toBe(normalizeCwd('C:\\repo\\sub'))
    expect(normalizeCwd('repo/../repo')).toBe('repo')
  })

  it('keeps non-Windows paths case-sensitive', () => {
    expect(normalizeCwd('/home/u/Repo')).not.toBe(normalizeCwd('/home/u/repo'))
    expect(normalizeCwd('/opt/workbench-user/repo/')).toBe('/opt/workbench-user/repo')
  })
})

describe('pane identity tiers (workspace canonical path wins, cwd fallback, one key space)', () => {
  it('workspace tier keys by the canonical path', () => {
    expect(paneWorkspaceKey({ workspacePath: '/srv/real/repo' })).toBe('/srv/real/repo')
    expect(paneWorkspaceKey({ workspacePath: 'C:\\Real\\Repo' })).toBe('c:/real/repo')
  })

  it('falls back to normalized cwd when unaccounted', () => {
    expect(paneWorkspaceKey({ cwd: 'C:\\Repo\\' })).toBe('c:/repo')
    expect(paneWorkspaceKey(undefined)).toBeUndefined()
    expect(paneWorkspaceKey({})).toBeUndefined()
    expect(paneWorkspaceKey({ cwd: '' })).toBeUndefined()
  })

  it('cross-tier same directory shares one key (accounted vs unaccounted still conflicts)', () => {
    expect(paneWorkspaceKey({ workspacePath: 'C:\\repo' }))
      .toBe(paneWorkspaceKey({ cwd: 'c:/repo/' }))
  })
})

describe('Same Workspace conflict logic (§5.7: pairwise across visible panes)', () => {
  const facts = (
    focused: WorkspaceFacts['visible'][number],
    others: WorkspaceFacts['visible'],
  ): WorkspaceFacts => ({ visible: [focused, ...others] })

  it('flags two sessions accounted to the SAME workspace (workspace tier)', () => {
    expect(hasSameWorkspaceConflict(
      facts({ workspacePath: 'C:\\Real\\Repo' }, [{ workspacePath: 'c:\\real\\repo' }]),
    )).toBe(true)
  })

  it('flags a staged session sharing the current cwd (fallback tier, Windows variants)', () => {
    expect(hasSameWorkspaceConflict(
      facts({ cwd: 'E:\\proj' }, [{ cwd: 'E:/other' }, { cwd: 'e:\\proj\\' }]),
    )).toBe(true)
  })

  it('flags TWO STAGED sessions sharing a cwd (staged×staged)', () => {
    expect(hasSameWorkspaceConflict(
      facts({ cwd: 'E:/other' }, [{ cwd: 'E:/proj' }, { cwd: 'E:\\proj\\' }]),
    )).toBe(true)
  })

  it('flags an accounted pane vs an unaccounted pane on the same directory (cross-tier)', () => {
    expect(hasSameWorkspaceConflict(
      facts({ workspacePath: 'C:\\repo' }, [{ cwd: 'c:/repo/' }]),
    )).toBe(true)
  })

  it('stays silent when distinct workspaces and distinct cwds', () => {
    expect(hasSameWorkspaceConflict(
      facts({ workspacePath: 'C:\\a' }, [{ workspacePath: 'C:\\b' }]),
    )).toBe(false)
    expect(hasSameWorkspaceConflict(
      facts({ cwd: 'E:/proj' }, [{ cwd: 'E:/other' }, { cwd: 'E:/third' }]),
    )).toBe(false)
  })

  it('stays silent without defined identities', () => {
    expect(hasSameWorkspaceConflict(facts(undefined, [{ cwd: 'E:/proj' }]))).toBe(false)
    expect(hasSameWorkspaceConflict(facts({ cwd: '' }, [{ cwd: 'E:/proj' }]))).toBe(false)
    expect(hasSameWorkspaceConflict(facts({ cwd: 'E:/proj' }, []))).toBe(false)
    expect(hasSameWorkspaceConflict(facts({ cwd: 'E:/proj' }, [undefined]))).toBe(false)
  })
})

describe('workspace path index (SessionId -> canonical path)', () => {
  it('indexes every accounted session; later workspaces win idempotently is acceptable', () => {
    const index = buildWorkspacePathIndex([
      { sessionIds: ['a', 'b'], path: 'C:\\Real\\Repo' },
      { sessionIds: ['c'], path: '/srv/other' },
    ])
    expect(index.get('a')).toBe('C:\\Real\\Repo')
    expect(index.get('b')).toBe('C:\\Real\\Repo')
    expect(index.get('c')).toBe('/srv/other')
    expect(index.get('zz')).toBeUndefined()
  })
})

describe('Same Workspace Warning banner lifecycle', () => {
  const t = (key: string) => key
  const props = (facts: WorkspaceFacts) => ({ facts, onDismiss: () => {}, t })

  it('announces through role=status + aria-live=polite (QA-03 screen-reader broadcast)', () => {
    const { container } = render(
      <SameWorkspaceWarning {...props({ visible: [{ cwd: 'E:/proj' }, { cwd: 'E:/proj' }] })} />,
    )
    const banner = container.querySelector('[data-same-workspace]')!
    expect(banner.getAttribute('role')).toBe('status')
    expect(banner.getAttribute('aria-live')).toBe('polite')
    expect((banner as HTMLElement).style.background).toContain('--dsw-alias-bg-layer-2')
    expect((banner as HTMLElement).style.color).toContain('--dsw-alias-label-primary')
    expect((banner as HTMLElement).style.background).not.toContain('#1f2430')
    // The ack control is a real, labelled-by-text button (keyboard operable).
    const ack = container.querySelector('button')!
    expect(ack.tagName).toBe('BUTTON')
    expect(ack.getAttribute('type')).toBe('button')
    expect(ack.textContent).toBe('banner.ack')
  })

  it('an ack acknowledges ONE conflict identity — a new conflict re-arms the P0 warning', () => {
    const { queryByText, rerender } = render(
      <SameWorkspaceWarning {...props({ visible: [{ cwd: 'E:/proj' }, { cwd: 'E:/proj' }] })} />,
    )
    expect(queryByText('banner.text')).toBeTruthy()
    fireEvent.click(queryByText('banner.ack')!)
    expect(queryByText('banner.text')).toBeNull()
    // Same identity re-renders: still acknowledged.
    rerender(<SameWorkspaceWarning {...props({ visible: [{ cwd: 'E:/proj' }, { cwd: 'E:/proj' }] })} />)
    expect(queryByText('banner.text')).toBeNull()
    // A DIFFERENT shared workspace is a genuinely new conflict: re-arm.
    rerender(<SameWorkspaceWarning {...props({ visible: [{ cwd: 'E:/other' }, { cwd: 'E:/other' }] })} />)
    expect(queryByText('banner.text')).toBeTruthy()
  })

  it('renders the localized banner copy in the zh and en quadrants (QA-04 locale, no hardcode)', () => {
    // zh quadrant: the banner text + ack are the shipped zh dictionary values.
    const zhT = (key: string) => zh[key as keyof typeof zh] ?? key
    const { container, unmount } = render(
      <SameWorkspaceWarning
        facts={{ visible: [{ cwd: 'E:/proj' }, { cwd: 'E:/proj' }] }}
        onDismiss={() => {}}
        t={zhT}
      />,
    )
    expect(container.querySelector('.dsw-workbench-warning-text')!.textContent).toBe(zh['banner.text'])
    expect(container.querySelector('button')!.textContent).toBe(zh['banner.ack'])
    unmount()
    // en quadrant: same frame, en dictionary.
    const enT = (key: string) => en[key as keyof typeof en] ?? key
    const enUtils = render(
      <SameWorkspaceWarning
        facts={{ visible: [{ cwd: 'E:/proj' }, { cwd: 'E:/proj' }] }}
        onDismiss={() => {}}
        t={enT}
      />,
    )
    expect(enUtils.container.querySelector('.dsw-workbench-warning-text')!.textContent).toBe(en['banner.text'])
    expect(enUtils.container.querySelector('button')!.textContent).toBe(en['banner.ack'])
    enUtils.unmount()
  })

  it('zh and en dictionaries are key-complete (quadrant precondition: no missing translation)', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(zh)) {
      expect(zh[key as keyof typeof zh]).toBeTruthy()
      expect(en[key as keyof typeof en]).toBeTruthy()
    }
  })

  it('notation variants of the SAME directory are one identity (no spurious re-arm)', () => {
    const { queryByText, rerender } = render(
      <SameWorkspaceWarning {...props({ visible: [{ cwd: 'C:\\repo' }, { cwd: 'c:/repo/' }] })} />,
    )
    expect(queryByText('banner.text')).toBeTruthy()
    fireEvent.click(queryByText('banner.ack')!)
    expect(queryByText('banner.text')).toBeNull()
    // Same directory, different notation AND different tier: still acknowledged.
    rerender(<SameWorkspaceWarning {...props({ visible: [{ workspacePath: 'C:\\repo' }, { cwd: 'c:/REPO/./' }] })} />)
    expect(queryByText('banner.text')).toBeNull()
    // A different directory re-arms.
    rerender(<SameWorkspaceWarning {...props({ visible: [{ cwd: 'C:/elsewhere' }, { cwd: 'C:\\elsewhere' }] })} />)
    expect(queryByText('banner.text')).toBeTruthy()
  })
})
