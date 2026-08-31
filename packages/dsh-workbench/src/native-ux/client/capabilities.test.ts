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
    // 就地高亮用的 CSS Custom Highlight API 刻意不进这份报告（它是宿主锁定的
    // 平台 API，不是会改名/缺席的宿主缝）——见 capabilities.ts 里的说明。
    expect(report).not.toHaveProperty('quoteHighlightApi')
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

  // -----------------------------------------------------------------
  // native-actions-pivot — Part B: the four new native L0 actions follow
  // the SAME GA-043 pattern as sidebar/session-stop above: absent seam ->
  // not registered, fail-soft (never a throw, never a fake placeholder —
  // GA-002). See harness-adapter.ts for the seam citations behind each
  // gate, and shortcuts.tsx's sessionNewOn/settingsOpenOn/sessionPreviousOn/
  // jumpLatestOn comment block for the registration-gate reasoning.
  // -----------------------------------------------------------------

  it('workbench.session.new registers only when sessions.clear exists', () => {
    const none = buildShortcutRegistry({ services: { sessions: { scope: () => undefined } } })
    expect(none.all().some((a) => a.id === 'workbench.session.new')).toBe(false)
    const withClear = buildShortcutRegistry({ services: { sessions: { scope: () => undefined, clear: () => {} } } })
    expect(withClear.all().some((a) => a.id === 'workbench.session.new')).toBe(true)
  })

  it('a false sessionNew capability flag suppresses registration even when sessions.clear is present', () => {
    const registry = buildShortcutRegistry({
      services: { sessions: { scope: () => undefined, clear: () => {} } },
      caps: { sessionNew: false },
    })
    expect(registry.all().some((a) => a.id === 'workbench.session.new')).toBe(false)
  })

  it('workbench.settings.open registers when EITHER layout.openSettings or layout.toggleSettings exists — neither ships in stock production TODAY (see harness-adapter.ts LayoutService.openSettings/toggleSettings doc comments for the investigated-and-ruled-out citations)', () => {
    const withoutSeam = buildShortcutRegistry({ services: { layout: { toggleSidebar: () => {} } } })
    expect(withoutSeam.all().some((a) => a.id === 'workbench.settings.open')).toBe(false)
    // No layout service at all is the same "absent" case.
    const noLayout = buildShortcutRegistry({ services: {} })
    expect(noLayout.all().some((a) => a.id === 'workbench.settings.open')).toBe(false)
    // A test double MAY supply either seam (the registration path is real,
    // even though nothing in production wires either one up yet).
    const withOpenOnly = buildShortcutRegistry({ services: { layout: { toggleSidebar: () => {}, openSettings: () => {} } } })
    expect(withOpenOnly.all().some((a) => a.id === 'workbench.settings.open')).toBe(true)
    // toggle-settings-verb: the newer toggleSettings() verb alone (no
    // openSettings at all) must be just as sufficient to register — the
    // gate is an OR of the two, not "openSettings plus an optional extra".
    const withToggleOnly = buildShortcutRegistry({ services: { layout: { toggleSidebar: () => {}, toggleSettings: () => {} } } })
    expect(withToggleOnly.all().some((a) => a.id === 'workbench.settings.open')).toBe(true)
  })

  // LOW 4 (Opus review, round 2): missing capability-flag suppression tests.
  it('a false settingsOpen capability flag suppresses registration even when layout.openSettings is present', () => {
    const registry = buildShortcutRegistry({
      services: { layout: { toggleSidebar: () => {}, openSettings: () => {} } },
      caps: { settingsOpen: false },
    })
    expect(registry.all().some((a) => a.id === 'workbench.settings.open')).toBe(false)
  })

  // MEDIUM 1 (Opus review, round 2): workbench.session.previous needs BOTH
  // `open` (the switch verb) AND `list` (the tracker feed — see
  // harness-adapter.ts's `SessionsService.list` doc comment) to register.
  // Before this fix, `open` alone was the gate and the tracker was fed from
  // the fork-only `presentation` face: a stock Harness (open present, no
  // presentation) registered the action but left it permanently inert. Now
  // EITHER seam missing means "not registered" — fail-soft over
  // "registered and silently broken."
  const fakeListStore = (current?: string) => ({ getSnapshot: () => ({ current }), subscribe: () => () => {} })

  it('workbench.session.previous does NOT register with neither seam present', () => {
    const none = buildShortcutRegistry({ services: { sessions: { scope: () => undefined } } })
    expect(none.all().some((a) => a.id === 'workbench.session.previous')).toBe(false)
  })

  it('workbench.session.previous does NOT register with only `open` present (the original MEDIUM-1 bug shape: registered-but-inert on stock)', () => {
    const openOnly = buildShortcutRegistry({ services: { sessions: { scope: () => undefined, open: () => {} } } })
    expect(openOnly.all().some((a) => a.id === 'workbench.session.previous')).toBe(false)
  })

  it('workbench.session.previous does NOT register with only `list` present (feed with no switch verb is just as useless)', () => {
    const listOnly = buildShortcutRegistry({ services: { sessions: { scope: () => undefined, list: fakeListStore() } } })
    expect(listOnly.all().some((a) => a.id === 'workbench.session.previous')).toBe(false)
  })

  it('workbench.session.previous registers when BOTH `open` and `list` are present — stock-shaped services (no `presentation` at all) are enough', () => {
    const stockShaped = buildShortcutRegistry({
      services: { sessions: { scope: () => undefined, open: () => {}, list: fakeListStore() } },
    })
    expect(stockShaped.all().some((a) => a.id === 'workbench.session.previous')).toBe(true)
  })

  it('a false sessionPrevious capability flag suppresses registration even when both seams are present', () => {
    const registry = buildShortcutRegistry({
      services: { sessions: { scope: () => undefined, open: () => {}, list: fakeListStore() } },
      caps: { sessionPrevious: false },
    })
    expect(registry.all().some((a) => a.id === 'workbench.session.previous')).toBe(false)
  })

  it('workbench.conversation.jump-latest always registers regardless of service presence (DOM-backed via conversation-dom.ts, not a service seam — fails soft at RUNTIME instead, when no scrollport is mounted)', () => {
    const none = buildShortcutRegistry()
    expect(none.all().some((a) => a.id === 'workbench.conversation.jump-latest')).toBe(true)
  })

  it('a false jumpLatest capability flag suppresses registration', () => {
    const registry = buildShortcutRegistry({ caps: { jumpLatest: false } })
    expect(registry.all().some((a) => a.id === 'workbench.conversation.jump-latest')).toBe(false)
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
