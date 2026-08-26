import { describe, expect, it, vi } from 'vitest'
import { betterSidebarAdapter } from '../src/client/better-sidebar.ts'

describe('betterSidebarAdapter', () => {
  it('is absent for stock Better Sidebar without the Pane capability', () => {
    expect(betterSidebarAdapter({ getTabs() {} })).toBeUndefined()
  })

  it('delegates attachments to protocol 1', () => {
    const mountPane = vi.fn(() => ({ update() {}, dispose() {} }))
    const adapter = betterSidebarAdapter({ panes: { protocol: 1, mountPane } })
    const target = { sessionId: 's', pane: {} as HTMLElement, rightHost: {} as HTMLElement, bottomHost: {} as HTMLElement, focused: true }
    adapter?.attach(target)
    expect(mountPane).toHaveBeenCalledWith(target)
  })
})
