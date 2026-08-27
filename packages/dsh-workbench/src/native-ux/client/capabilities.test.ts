// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildCapabilityReport,
  logCapabilityReport,
  probeCapabilities,
  resetWarnOnce,
  warnOnce,
  type CapabilityReport,
} from './capabilities.js'
import { buildShortcutRegistry } from './shortcuts.js'
import { apply } from './index.js'
import type { HarnessContext } from './harness-adapter.js'

function makeCtx(services: Record<string, unknown> = {}): HarnessContext {
  return {
    get: vi.fn((name: string) => services[name]),
    locale: { register: vi.fn(), bind: vi.fn(() => (key: string) => key) },
    slots: { register: vi.fn(), inject: vi.fn() },
    settingsScope: { bind: vi.fn(() => ({ getSnapshot: () => ({}), subscribe: vi.fn(), set: vi.fn(), unset: vi.fn() })) },
    effect: vi.fn((fn: () => void) => fn()),
    on: vi.fn(),
  }
}

describe('buildCapabilityReport (GA-041)', () => {
  it('maps service + DOM + seam presence into the report', () => {
    const report = buildCapabilityReport(
      { layout: { toggleSidebar: () => {} }, sessions: { scope: () => ({ get: () => ({}) }) } },
      { scrollport: true, anchors: true, composer: true },
      { slotsInject: true, settingsPersistence: true },
    )
    expect(report).toEqual({
      slotsInject: true, layoutToggle: true, conversationFace: true,
      chatAnchorDom: true, composerDom: true, settingsPersistence: true, favoriteAgent: false,
    })
  })

  it('marks each missing seam false independently (fail-soft, no crash)', () => {
    const report: CapabilityReport = buildCapabilityReport(
      {},
      { scrollport: false, anchors: false, composer: false },
      { slotsInject: false, settingsPersistence: false },
    )
    expect(report).toEqual({
      slotsInject: false, layoutToggle: false, conversationFace: false,
      chatAnchorDom: false, composerDom: false, settingsPersistence: false, favoriteAgent: false,
    })
  })
})

describe('probeCapabilities (GA-030)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('reflects the live services and DOM anchors', () => {
    const seat = document.createElement('div')
    seat.setAttribute('data-composer-seat', '')
    const anchor = document.createElement('div')
    anchor.setAttribute('data-chat-anchor-key', 'a')
    document.body.append(seat, anchor)
    const report = probeCapabilities(makeCtx({ sessions: { scope: () => undefined } }))
    expect(report.composerDom).toBe(true)
    expect(report.chatAnchorDom).toBe(true)
    expect(report.conversationFace).toBe(true)
    expect(report.favoriteAgent).toBe(false)
  })
})

describe('fail-soft: service-backed actions gate on service presence (GA-043)', () => {
  it('sidebar + session-stop register only when their service exists', () => {
    // No services → only the always-on navigator/composer (+ favorites off) register.
    const none = buildShortcutRegistry()
    const ids = none.all().map((a) => a.id)
    expect(ids).not.toContain('workbench.layout.sidebar.toggle')
    expect(ids).not.toContain('workbench.session.stop')
    expect(ids).toContain('workbench.conversation.navigator.toggle')

    // Layout present → sidebar registers; sessions still absent.
    const layout = buildShortcutRegistry({ services: { layout: { toggleSidebar: () => {} } } })
    expect(layout.all().some((a) => a.id === 'workbench.layout.sidebar.toggle')).toBe(true)
    expect(layout.all().some((a) => a.id === 'workbench.session.stop')).toBe(false)

    // Sessions present → session.stop registers.
    const sessions = buildShortcutRegistry({ services: { sessions: { scope: () => ({ get: () => ({ cancel: () => {} }) }) } } })
    expect(sessions.all().some((a) => a.id === 'workbench.session.stop')).toBe(true)
  })
})

describe('warnOnce (one-shot)', () => {
  afterEach(() => {
    resetWarnOnce()
    vi.restoreAllMocks()
  })

  it('logs the same key once even when called repeatedly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnOnce('x-missing', 'missing')
    warnOnce('x-missing', 'missing')
    warnOnce('y-missing', 'missing2')
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0]?.[0]).toContain('x-missing')
  })
})

describe('apply() fail-soft isolation (GA-043)', () => {
  afterEach(() => {
    resetWarnOnce()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('one module throwing does not prevent the other from registering', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const ctx = makeCtx()
    // Simulate a navigator seam failure: applyNavigator calls
    // ctx.locale.bind(NS) at its top; make the FIRST bind throw, the second
    // (applyShortcuts) succeed. Each module is isolated by apply(), so the
    // navigator failure must not prevent shortcuts from registering.
    let first = true
    const origBind = ctx.locale.bind
    ctx.locale.bind = (ns: string) => {
      if (first) {
        first = false
        throw new Error('simulated navigator seam failure')
      }
      return origBind(ns)
    }
    expect(() => apply(ctx)).not.toThrow()
    // warn fired once for the navigator failure
    expect(warn.mock.calls.some((c) => String(c[0]).includes('navigator-apply-failed'))).toBe(true)
    // capability probe diagnostics still ran (not blocked by the failure)
    expect(debug).toHaveBeenCalled()
  })
})
