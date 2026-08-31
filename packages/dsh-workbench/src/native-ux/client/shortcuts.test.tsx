// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyShortcuts,
  attachDispatcher as attachProductionDispatcher,
  buildShortcutRegistry,
  isEditableTarget,
  isTrustedShortcutEvent,
} from './shortcuts.js'
import { navigatorBus } from './navigator-bus.js'
import { createThirdPartyActionsHandle } from './actions-api.js'
import { ActionRegistry } from '../core/action-registry.js'
import { createPreviousSessionTracker } from '../core/previous-session-tracker.js'
import type { HarnessContext } from './harness-adapter.js'

// Generic non-workbench provider used by the allowWhileTyping tests below —
// these exercise the DISPATCHER's own escape-hatch mechanism (ActionDef.
// allowWhileTyping), not any specific provider's bridge. Formerly modeled
// after the W2 host slash-command bridge (removed by product decision — see
// shortcuts.tsx's EDITABLE_PROVIDERS comment); a plain third-party provider
// id exercises the identical dispatcher code path.
const THIRD_PARTY_PROVIDER = 'thirdparty'

describe('shortcut dispatcher (seam B)', () => {
  let detach: () => void

  const attachDispatcher = (registry: ReturnType<typeof buildShortcutRegistry>) =>
    attachProductionDispatcher(registry, { allowSyntheticEventsForTesting: true })

  beforeEach(() => {})

  afterEach(() => {
    detach?.()
    vi.restoreAllMocks()
  })

  function keydown(init: KeyboardEventInit, target?: EventTarget) {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    Object.defineProperty(event, 'target', { value: target ?? document.body, configurable: true })
    Object.defineProperty(event, 'isComposing', { value: init.isComposing ?? false, configurable: true })
    window.dispatchEvent(event)
    return event
  }

  // F8: protocol 2 is the revision the compatibility guard demands
  // (client/contract.ts). A fixture without it models an INCOMPATIBLE host,
  // where workbench.pane.close-focused must not register — the registration
  // gate itself is pinned in settings-section.test.tsx's F8 block.
  const presentation = (focused: string) => ({
    protocol: 2,
    state: { getSnapshot: () => ({ focused }) },
    close: vi.fn(),
  })

  const focusedServices = () => ({
    sessions: { scope: vi.fn(), presentation: presentation('s1') },
  })

  it('rejects synthetic keyboard events in production mode', () => {
    const event = new KeyboardEvent('keydown', { key: 'X' })
    expect(event.isTrusted).toBe(false)
    expect(isTrustedShortcutEvent(event)).toBe(false)
    expect(isTrustedShortcutEvent(event, true)).toBe(true)
  })

  it('navigator toggle fires on Primary+Shift+O and prevents default', () => {
    const registry = buildShortcutRegistry({ services: focusedServices() })
    detach = attachDispatcher(registry)
    const toggle = vi.fn()
    const off = navigatorBus.onToggle('s1', toggle)
    const event = keydown({ key: 'O', shiftKey: true, ctrlKey: true })
    expect(toggle).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
    off()
  })

  it('routes navigator toggle and pane close only to the focused session', () => {
    const close = vi.fn()
    const services = {
      sessions: {
        scope: vi.fn(),
        presentation: { protocol: 2, state: { getSnapshot: () => ({ focused: 's2' }) }, close },
      },
    }
    const registry = buildShortcutRegistry({ services })
    detach = attachDispatcher(registry)
    const s1 = vi.fn()
    const s2 = vi.fn()
    const off1 = navigatorBus.onToggle('s1', s1)
    const off2 = navigatorBus.onToggle('s2', s2)

    keydown({ key: 'O', shiftKey: true, ctrlKey: true })
    expect(s1).not.toHaveBeenCalled()
    expect(s2).toHaveBeenCalledOnce()
    keydown({ key: '\\', ctrlKey: true })
    expect(close).toHaveBeenCalledWith('s2')
    off1()
    off2()
  })

  it('falls back to the document-scope composer when presentation.state is malformed', () => {
    // Guards against a protocol-2 presentation face whose `state` doesn't
    // actually carry `getSnapshot` at runtime (the split-pane guard fails
    // closed by leaving shortcuts registered, so this must not crash them).
    // `.not.toThrow()` alone is vacuous here: keydown() dispatches through
    // window.dispatchEvent, and jsdom swallows listener exceptions, so a
    // throwing handler never propagates back out to the assertion. Assert
    // the actually-observable behavior instead: with no resolvable focused
    // session, the dispatcher still lands focus on the document-scope
    // composer seat rather than silently dropping the chord.
    const seat = document.createElement('div')
    seat.setAttribute('data-composer-seat', '')
    const input = document.createElement('textarea')
    seat.appendChild(input)
    document.body.appendChild(seat)
    const services = {
      // Deliberately violates the static SessionsService shape (`state` is
      // typed as a required object) to exercise the runtime guard.
      sessions: { scope: vi.fn(), presentation: { state: null as any, close: vi.fn() } },
    }
    const registry = buildShortcutRegistry({ services })
    detach = attachDispatcher(registry)
    keydown({ key: '/', ctrlKey: true })
    expect(document.activeElement).toBe(input)
    seat.remove()
  })

  it('falls back to the document-scope composer when presentation.state.getSnapshot() throws', () => {
    // Same degraded-but-alive contract as the malformed-state case above,
    // exercised through a `state` that satisfies the static shape but
    // throws when actually called (e.g. a flaky host-side accessor).
    const seat = document.createElement('div')
    seat.setAttribute('data-composer-seat', '')
    const input = document.createElement('textarea')
    seat.appendChild(input)
    document.body.appendChild(seat)
    const services = {
      sessions: {
        scope: vi.fn(),
        presentation: {
          state: { getSnapshot: () => { throw new Error('boom') } },
          close: vi.fn(),
        },
      },
    }
    const registry = buildShortcutRegistry({ services })
    detach = attachDispatcher(registry)
    keydown({ key: '/', ctrlKey: true })
    expect(document.activeElement).toBe(input)
    seat.remove()
  })

  it('focuses the composer inside the focused pane', () => {
    const first = document.createElement('section')
    first.dataset.sessionPane = 's1'
    const second = document.createElement('section')
    second.dataset.sessionPane = 's2'
    for (const pane of [first, second]) {
      const seat = document.createElement('div')
      seat.dataset.composerSeat = ''
      seat.appendChild(document.createElement('textarea'))
      pane.appendChild(seat)
      document.body.appendChild(pane)
    }
    const secondInput = second.querySelector('textarea')!
    const focusSpy = vi.spyOn(secondInput, 'focus')
    const registry = buildShortcutRegistry({
      services: {
        sessions: { scope: vi.fn(), presentation: presentation('s2') },
      },
    })
    detach = attachDispatcher(registry)

    keydown({ key: '/', ctrlKey: true })
    expect(focusSpy).toHaveBeenCalledOnce()
    first.remove()
    second.remove()
  })

  it('sidebar toggle calls the layout service', () => {
    const toggleSidebar = vi.fn()
    const registry = buildShortcutRegistry({ services: { layout: { toggleSidebar } } })
    detach = attachDispatcher(registry)
    keydown({ key: 'b', ctrlKey: true })
    expect(toggleSidebar).toHaveBeenCalledOnce()
  })

  it('composer focus focuses the composer input', () => {
    const seat = document.createElement('div')
    seat.setAttribute('data-composer-seat', '')
    const input = document.createElement('textarea')
    const focusSpy = vi.spyOn(input, 'focus')
    seat.appendChild(input)
    document.body.appendChild(seat)
    const registry = buildShortcutRegistry({ services: focusedServices() })
    detach = attachDispatcher(registry)
    keydown({ key: '/', ctrlKey: true })
    expect(focusSpy).toHaveBeenCalledOnce()
    seat.remove()
  })

  it('session stop calls cancel on the scoped conversation', () => {
    const cancel = vi.fn()
    const scope = vi.fn(() => ({ get: () => ({ cancel }) }))
    const registry = buildShortcutRegistry({ services: { sessions: { scope, presentation: presentation('s1') } } })
    detach = attachDispatcher(registry)
    keydown({ key: 'X', shiftKey: true, ctrlKey: true })
    expect(scope).toHaveBeenCalledWith('s1')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('ignores editable targets (real event path)', () => {
    // Navigator toggle is allowlisted in editable targets; use Session stop
    // to verify that ordinary actions remain suppressed while typing.
    const cancel = vi.fn()
    const scope = vi.fn(() => ({ get: () => ({ cancel }) }))
    const registry = buildShortcutRegistry({ services: { sessions: { scope, presentation: presentation('s-edit') } } })
    detach = attachDispatcher(registry)
    const input = document.createElement('textarea')
    document.body.appendChild(input)
    const event = new KeyboardEvent('keydown', { key: 'X', shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true })
    input.dispatchEvent(event) // real path: composedPath()[0] === input
    expect(scope).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    input.remove()
  })

  it('navigator toggle fires from inside a textarea (GA-020 allowlist)', () => {
    const registry = buildShortcutRegistry({ services: focusedServices() })
    detach = attachDispatcher(registry)
    const toggle = vi.fn()
    const off = navigatorBus.onToggle('s1', toggle)
    const input = document.createElement('textarea')
    document.body.appendChild(input)
    const event = new KeyboardEvent('keydown', { key: 'O', shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true })
    input.dispatchEvent(event) // real path: composedPath()[0] === input
    expect(toggle).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
    input.remove()
    off()
  })

  it('composer-focus invariant: allowlisted toggle fires from the composer seat input', () => {
    // The composer's focus target is the host seat ([data-composer-seat] —
    // capabilities.ts composerDom / sdk-facts.md). With focus actually on the
    // seat's input, workbench.conversation.navigator.toggle must still fire (GA-020),
    // while the focus target itself stays the composer (no focus steal).
    const seat = document.createElement('div')
    seat.setAttribute('data-composer-seat', '')
    const input = document.createElement('textarea')
    seat.appendChild(input)
    document.body.appendChild(seat)
    input.focus()
    expect(document.activeElement).toBe(input)
    const registry = buildShortcutRegistry({ services: focusedServices() })
    detach = attachDispatcher(registry)
    const toggle = vi.fn()
    const off = navigatorBus.onToggle('s1', toggle)
    const event = new KeyboardEvent('keydown', { key: 'O', shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true })
    input.dispatchEvent(event) // real path: composedPath()[0] === input
    expect(toggle).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input) // focus stays on the composer
    seat.remove()
    off()
  })

  it('non-allowlisted actions stay disabled inside a textarea', () => {
    const toggleSidebar = vi.fn()
    const registry = buildShortcutRegistry({ services: { layout: { toggleSidebar } } })
    detach = attachDispatcher(registry)
    const toggle = vi.fn()
    const off = navigatorBus.onToggle('s1', toggle)
    const input = document.createElement('textarea')
    document.body.appendChild(input)
    const event = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })
    input.dispatchEvent(event) // real path: composedPath()[0] === input
    expect(toggleSidebar).not.toHaveBeenCalled()
    expect(toggle).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    input.remove()
    off()
  })

  it('navigator toggle still fires outside editable targets', () => {
    const registry = buildShortcutRegistry({ services: focusedServices() })
    detach = attachDispatcher(registry)
    const toggle = vi.fn()
    const off = navigatorBus.onToggle('s1', toggle)
    const event = new KeyboardEvent('keydown', { key: 'O', shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(event) // real path, non-editable target
    expect(toggle).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
    off()
  })

  it('ignores IME composition', () => {
    const registry = buildShortcutRegistry({ services: focusedServices() })
    detach = attachDispatcher(registry)
    const toggle = vi.fn()
    const off = navigatorBus.onToggle('s1', toggle)
    const event = keydown({ key: 'O', shiftKey: true, ctrlKey: true, isComposing: true })
    expect(toggle).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    off()
  })

  it('unbound chords do not prevent default', () => {
    const registry = buildShortcutRegistry()
    detach = attachDispatcher(registry)
    const event = keydown({ key: 'z', ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
  })

  it('isEditableTarget covers inputs and contenteditable', () => {
    const input = document.createElement('input')
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    expect(editable.tagName).toBe('DIV')
    expect(isEditableTarget(input)).toBe(true)
    expect(isEditableTarget(editable)).toBe(true)
    expect(isEditableTarget(document.body)).toBe(false)
  })

  // -------------------------------------------------------------------
  // BLOCKING 1 — a throwing third-party label() must never strand the
  // dispatcher. buildShortcutRegistry (via thirdPartyActionsHandle.
  // registerInto -> toActionDef) is exactly the call shortcuts.tsx's
  // reload() makes AFTER detach()ing the previous listener and BEFORE
  // reattaching a new one — an unguarded throw here would leave the whole
  // dispatcher permanently detached. Probe: build + attach must both
  // succeed, and a completely unrelated, healthy built-in action must still
  // fire on its own chord afterwards.
  // -------------------------------------------------------------------
  it('BLOCKING 1: a throwing third-party label() never prevents build+attach, and a healthy built-in action still fires (probe)', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register({ id: 'p.throws', label: () => { throw new Error('boom') }, run: () => {} })
    let registry: ReturnType<typeof buildShortcutRegistry> | undefined
    expect(() => {
      registry = buildShortcutRegistry({ services: focusedServices(), thirdPartyActionsHandle: handle })
    }).not.toThrow()
    expect(() => { detach = attachDispatcher(registry!) }).not.toThrow()

    // The offending action itself renders under its raw id (never poisons
    // the registry build) ...
    expect(registry!.all().find((a) => a.id === 'p.throws')?.label).toBe('p.throws')

    // ... and dispatch for a completely unrelated healthy action is
    // unaffected — proof the keydown listener actually got (re)attached,
    // not merely that buildShortcutRegistry() itself didn't throw.
    const toggle = vi.fn()
    const off = navigatorBus.onToggle('s1', toggle)
    const event = keydown({ key: 'O', shiftKey: true, ctrlKey: true })
    expect(toggle).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
    off()
  })

  // -------------------------------------------------------------------
  // Finding 1 (smoke test) — a bound third-party-provider chord used to be
  // dead while the composer was focused: the dispatcher suppressed every
  // editable-target keydown unless the action id was in the hardcoded
  // EDITABLE_ALLOWED_ACTIONS set, and no third-party id ever joined that
  // set. Firing while typing is exactly the case allowWhileTyping exists
  // for (originally motivated by the W2 host slash-command bridge's own
  // insert-mode PRIMARY flow — that bridge was later removed by product
  // decision, but the dispatcher mechanism it motivated stays general-
  // purpose). Fix: ActionDef.allowWhileTyping.
  // -------------------------------------------------------------------
  describe('Finding 1 — allowWhileTyping (editable-target dispatch)', () => {
    it('a third-party action (allowWhileTyping: true) fires from inside a textarea — fails against the pre-fix dispatcher', () => {
      const registry = new ActionRegistry()
      const run = vi.fn()
      const result = registry.register(
        { id: 'thirdparty.foo', label: 'Foo', defaultChord: null, provider: THIRD_PARTY_PROVIDER, allowWhileTyping: true, run },
        'Primary+K',
      )
      expect(result.ok).toBe(true)
      detach = attachDispatcher(registry)
      const input = document.createElement('textarea')
      document.body.appendChild(input)
      const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })
      input.dispatchEvent(event) // real path: composedPath()[0] === input (editable)
      expect(run).toHaveBeenCalledOnce()
      expect(event.defaultPrevented).toBe(true)
      input.remove()
    })

    it('a Workbench action NOT in the legacy EDITABLE_ALLOWED_ACTIONS set stays suppressed while typing (no regression)', () => {
      // Session stop is a workbench.* built-in with no allowWhileTyping set —
      // the fix must not accidentally widen the legacy allowlist's coverage.
      const cancel = vi.fn()
      const scope = vi.fn(() => ({ get: () => ({ cancel }) }))
      const registry = buildShortcutRegistry({ services: { sessions: { scope, presentation: presentation('s-edit') } } })
      detach = attachDispatcher(registry)
      const input = document.createElement('textarea')
      document.body.appendChild(input)
      const event = new KeyboardEvent('keydown', { key: 'X', shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true })
      input.dispatchEvent(event)
      expect(cancel).not.toHaveBeenCalled()
      expect(event.defaultPrevented).toBe(false)
      input.remove()
    })

    it('a third-party action without allowWhileTyping stays suppressed while typing; the same action WITH the flag fires', () => {
      const handle = createThirdPartyActionsHandle()
      const runWithout = vi.fn()
      const runWith = vi.fn()
      handle.service.register({ id: 'p.withoutFlag', label: () => 'Without', run: runWithout })
      handle.service.register({ id: 'p.withFlag', label: () => 'With', run: runWith, allowWhileTyping: true })
      const registry = buildShortcutRegistry({
        thirdPartyActionsHandle: handle,
        overrides: { 'p.withoutFlag': 'Primary+1', 'p.withFlag': 'Primary+2' },
      })
      detach = attachDispatcher(registry)
      const input = document.createElement('textarea')
      document.body.appendChild(input)

      const withoutEvent = new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true, cancelable: true })
      input.dispatchEvent(withoutEvent)
      expect(runWithout).not.toHaveBeenCalled()
      expect(withoutEvent.defaultPrevented).toBe(false)

      const withEvent = new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true, cancelable: true })
      input.dispatchEvent(withEvent)
      expect(runWith).toHaveBeenCalledOnce()
      expect(withEvent.defaultPrevented).toBe(true)

      input.remove()
    })
  })

  // -------------------------------------------------------------------
  // MEDIUM 1 (Opus review, round 2 of Finding 1) — the allowWhileTyping
  // escape must not swallow a character the user is actually typing.
  // Reviewer-verified probe: a third-party action bound to Shift+A (or
  // Shift+/ = '?', Shift+Enter = newline) fired + preventDefault()ed WHILE
  // TYPING, eating the character. Fix: the escape only applies when the
  // chord carries a real modifier (Primary/Alt) or targets a non-printable
  // key — a Shift-only chord on a printable key stays suppressed while typing.
  // -------------------------------------------------------------------
  describe('MEDIUM 1 — allowWhileTyping does not swallow a typed character (Shift-only printable chords)', () => {
    it('a Shift-only third-party chord on a printable key stays suppressed while typing, and the character survives (event NOT defaultPrevented) — fails against the pre-MEDIUM-1 dispatcher', () => {
      const registry = new ActionRegistry()
      const run = vi.fn()
      registry.register(
        { id: 'thirdparty.bang', label: 'Bang', defaultChord: null, provider: THIRD_PARTY_PROVIDER, allowWhileTyping: true, run },
        'Shift+A',
      )
      detach = attachDispatcher(registry)
      const input = document.createElement('textarea')
      document.body.appendChild(input)
      const event = new KeyboardEvent('keydown', { key: 'A', shiftKey: true, bubbles: true, cancelable: true })
      input.dispatchEvent(event) // real path: composedPath()[0] === input (editable)
      expect(run).not.toHaveBeenCalled()
      expect(event.defaultPrevented).toBe(false) // the 'A' character is not eaten
      input.remove()
    })

    it('the same action bound to Primary+letter DOES fire while typing (Primary is a real modifier, not the dangerous Shift-only case)', () => {
      const registry = new ActionRegistry()
      const run = vi.fn()
      registry.register(
        { id: 'thirdparty.bang', label: 'Bang', defaultChord: null, provider: THIRD_PARTY_PROVIDER, allowWhileTyping: true, run },
        'Primary+A',
      )
      detach = attachDispatcher(registry)
      const input = document.createElement('textarea')
      document.body.appendChild(input)
      const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })
      input.dispatchEvent(event)
      expect(run).toHaveBeenCalledOnce()
      expect(event.defaultPrevented).toBe(true)
      input.remove()
    })

    it('a Shift-only chord on a NON-printable key (F5) still fires while typing — there is no character to swallow', () => {
      const registry = new ActionRegistry()
      const run = vi.fn()
      registry.register(
        { id: 'thirdparty.refresh', label: 'Refresh', defaultChord: null, provider: THIRD_PARTY_PROVIDER, allowWhileTyping: true, run },
        'Shift+F5',
      )
      detach = attachDispatcher(registry)
      const input = document.createElement('textarea')
      document.body.appendChild(input)
      const event = new KeyboardEvent('keydown', { key: 'F5', shiftKey: true, bubbles: true, cancelable: true })
      input.dispatchEvent(event)
      expect(run).toHaveBeenCalledOnce()
      expect(event.defaultPrevented).toBe(true)
      input.remove()
    })

    it('the same Shift-only printable chord still fires OUTSIDE an editable context (no over-suppression from the MEDIUM-1 fix)', () => {
      const registry = new ActionRegistry()
      const run = vi.fn()
      registry.register(
        { id: 'thirdparty.bang', label: 'Bang', defaultChord: null, provider: THIRD_PARTY_PROVIDER, allowWhileTyping: true, run },
        'Shift+A',
      )
      detach = attachDispatcher(registry)
      const event = new KeyboardEvent('keydown', { key: 'A', shiftKey: true, bubbles: true, cancelable: true })
      document.body.dispatchEvent(event) // non-editable target — the while-typing gate never applies here
      expect(run).toHaveBeenCalledOnce()
      expect(event.defaultPrevented).toBe(true)
    })
  })

  // -------------------------------------------------------------------
  // native-actions-pivot — Part B: the four new native L0 actions.
  // Registration gating (seam-present vs seam-absent) is pinned in
  // capabilities.test.ts's GA-043 describe block; these tests cover the
  // DISPATCH side — the traced verb each action's run() actually calls, its
  // default chord, and (since all four set allowWhileTyping: true) that they
  // still fire from inside an editable target without the MEDIUM-1 Shift
  // guard swallowing a real keystroke — none of Primary+N / Primary+Space /
  // Alt+Q / Primary+Shift+L is a Shift-only chord on a printable key, so the
  // guard's `chord.primary || chord.alt` branch always admits them (see
  // attachDispatcher's own doc comment for the guard itself).
  // -------------------------------------------------------------------
  describe('native-actions-pivot — Part B: session.new / settings.open / session.previous / conversation.jump-latest', () => {
    it('workbench.session.new: Primary+N calls sessions.clear() — the same fallback startSession() itself uses (see harness-adapter.ts)', () => {
      const clear = vi.fn()
      const registry = buildShortcutRegistry({ services: { sessions: { scope: vi.fn(), clear } } })
      detach = attachDispatcher(registry)
      const event = keydown({ key: 'n', ctrlKey: true })
      expect(clear).toHaveBeenCalledOnce()
      expect(event.defaultPrevented).toBe(true)
    })

    it('workbench.session.new fires from inside a textarea (allowWhileTyping — starting a new session from wherever you are, composer included)', () => {
      const clear = vi.fn()
      const registry = buildShortcutRegistry({ services: { sessions: { scope: vi.fn(), clear } } })
      detach = attachDispatcher(registry)
      const input = document.createElement('textarea')
      document.body.appendChild(input)
      const event = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true })
      input.dispatchEvent(event) // real path: composedPath()[0] === input (editable)
      expect(clear).toHaveBeenCalledOnce()
      expect(event.defaultPrevented).toBe(true)
      input.remove()
    })

    it('workbench.settings.open: Primary+Space calls layout.openSettings() when a test double supplies the seam (no real seam ships yet in production — see harness-adapter.ts)', () => {
      const openSettings = vi.fn()
      const registry = buildShortcutRegistry({ services: { layout: { toggleSidebar: vi.fn(), openSettings } } })
      detach = attachDispatcher(registry)
      // event.key for the physical Space bar is the literal ' ' character
      // (KeyboardEvent spec) — chordFromEvent lowercases it to the same ' '
      // parseChord('Primary+Space') itself resolves to (chord.ts's own
      // 'Space' -> ' ' mapping), so recording and matching agree.
      const event = keydown({ key: ' ', ctrlKey: true })
      expect(openSettings).toHaveBeenCalledOnce()
      expect(event.defaultPrevented).toBe(true)
    })

    // LOW 3 (Opus review, round 2): the missing while-typing dispatch test
    // for settings.open. ' ' (the physical Space bar's event.key) IS a
    // printable key (isPrintableKey has no non-printable exception for it,
    // unlike Enter/Escape/F-keys/arrows), so unlike jump-latest's
    // Primary+Shift+L (a non-printable-adjacent letter chord) or
    // session.new's Primary+N, this specific chord's allowWhileTyping escape
    // can ONLY clear the MEDIUM-1-era Shift guard (attachDispatcher:
    // `chord.primary || chord.alt || !isPrintableKey(chord.key)`) via the
    // `chord.primary` branch — `!isPrintableKey(chord.key)` is FALSE here,
    // so if a future edit ever dropped `chord.primary` from that guard (or
    // the chord fired without Ctrl), this chord specifically would regress
    // to the pre-Finding-1 suppressed-while-typing behavior. A seam-supplied
    // test double stands in for `layout.openSettings` since no real seam
    // ships yet (see the test above).
    it('workbench.settings.open fires from inside a textarea (allowWhileTyping — ' + "' '" + ' is printable, so this exercises the chord.primary branch of the Shift guard specifically)', () => {
      const openSettings = vi.fn()
      const registry = buildShortcutRegistry({ services: { layout: { toggleSidebar: vi.fn(), openSettings } } })
      detach = attachDispatcher(registry)
      const input = document.createElement('textarea')
      document.body.appendChild(input)
      const event = new KeyboardEvent('keydown', { key: ' ', ctrlKey: true, bubbles: true, cancelable: true })
      input.dispatchEvent(event) // real path: composedPath()[0] === input (editable)
      expect(openSettings).toHaveBeenCalledOnce()
      expect(event.defaultPrevented).toBe(true)
      input.remove()
    })

    // MEDIUM 1 (Opus review, round 2): registration now also requires
    // `sessions.list` (see harness-adapter.ts's `SessionsService.list` doc
    // comment) alongside `sessions.open` — these dispatch-level tests drive
    // `previousSessionTracker` directly via `.noteFocus()` (they are not
    // exercising the real `list`-subscription feed itself; that lives in the
    // `applyShortcuts` describe block below), so `list` here is a bare stub
    // that only needs to satisfy the registration gate.
    const stubListSeam = () => ({ getSnapshot: () => ({}), subscribe: () => () => {} })

    it('workbench.session.previous: Alt+Q switches to the tracked previous session via sessions.open()', () => {
      const open = vi.fn()
      const tracker = createPreviousSessionTracker()
      tracker.noteFocus('s1')
      tracker.noteFocus('s2') // previous() now resolves to 's1'
      const registry = buildShortcutRegistry({
        services: { sessions: { scope: vi.fn(), open, list: stubListSeam() } },
        previousSessionTracker: tracker,
      })
      detach = attachDispatcher(registry)
      const event = keydown({ key: 'q', altKey: true })
      expect(open).toHaveBeenCalledWith('s1')
      expect(event.defaultPrevented).toBe(true)
    })

    // F6 (end-to-end): the chord that actually reaches the dispatcher on a
    // US-layout Mac. Option is a character-COMPOSING modifier, so ⌥Q arrives
    // as `{ key: 'œ', altKey: true, code: 'KeyQ' }` — reading `key` alone
    // produced the id 'Alt+œ', which never matched the registered 'Alt+q',
    // so this default was silently dead on the platform docs/KNOWN_ISSUES.md
    // lists as a v0.2.0-rc.2 target while Settings still rendered it as ⌥Q.
    // `code` derivation is platform-independent in chordFromEvent, so this
    // asserts the fix through the real keydown path under jsdom's own
    // (non-mac) platform reading.
    it('F6: the real macOS Option+Q event (key "œ", code "KeyQ") still fires workbench.session.previous', () => {
      const open = vi.fn()
      const tracker = createPreviousSessionTracker()
      tracker.noteFocus('s1')
      tracker.noteFocus('s2')
      const registry = buildShortcutRegistry({
        services: { sessions: { scope: vi.fn(), open, list: stubListSeam() } },
        previousSessionTracker: tracker,
      })
      detach = attachDispatcher(registry)
      const event = keydown({ key: 'œ', altKey: true, code: 'KeyQ' })
      expect(open).toHaveBeenCalledWith('s1')
      expect(event.defaultPrevented).toBe(true)
    })

    it('workbench.session.previous: isEnabled is false (chord resolves to nothing, no dead preventDefault) before any previous session has ever been observed', () => {
      const open = vi.fn()
      const tracker = createPreviousSessionTracker() // fresh — no noteFocus calls yet
      const registry = buildShortcutRegistry({
        services: { sessions: { scope: vi.fn(), open, list: stubListSeam() } },
        previousSessionTracker: tracker,
      })
      detach = attachDispatcher(registry)
      // The action IS registered (both seams present) — this specifically
      // exercises isEnabled() returning false, not a missing registration.
      expect(registry.all().some((a) => a.id === 'workbench.session.previous')).toBe(true)
      const event = keydown({ key: 'q', altKey: true })
      expect(open).not.toHaveBeenCalled()
      expect(event.defaultPrevented).toBe(false) // ActionRegistry.resolve: false isEnabled -> null, key behaves unbound
    })

    it('workbench.session.previous fires from inside a textarea (allowWhileTyping)', () => {
      const open = vi.fn()
      const tracker = createPreviousSessionTracker()
      tracker.noteFocus('s1')
      tracker.noteFocus('s2')
      const registry = buildShortcutRegistry({
        services: { sessions: { scope: vi.fn(), open, list: stubListSeam() } },
        previousSessionTracker: tracker,
      })
      detach = attachDispatcher(registry)
      const input = document.createElement('textarea')
      document.body.appendChild(input)
      const event = new KeyboardEvent('keydown', { key: 'q', altKey: true, bubbles: true, cancelable: true })
      input.dispatchEvent(event)
      expect(open).toHaveBeenCalledWith('s1')
      expect(event.defaultPrevented).toBe(true)
      input.remove()
    })

    it('workbench.conversation.jump-latest: Primary+Shift+L scrolls the focused pane scrollport to bottom', () => {
      const scrollport = document.createElement('div')
      scrollport.setAttribute('data-conversation-scroll', '')
      Object.defineProperty(scrollport, 'scrollHeight', { value: 4000, configurable: true })
      document.body.appendChild(scrollport)
      const registry = buildShortcutRegistry({ services: focusedServices() })
      detach = attachDispatcher(registry)
      const event = keydown({ key: 'L', shiftKey: true, ctrlKey: true })
      expect(scrollport.scrollTop).toBe(4000)
      expect(event.defaultPrevented).toBe(true)
      scrollport.remove()
    })

    it('workbench.conversation.jump-latest is a silent no-op when no scrollport is mounted yet (fail-soft, mirrors focusComposer\'s optional-chained .focus())', () => {
      const registry = buildShortcutRegistry({ services: focusedServices() })
      detach = attachDispatcher(registry)
      const event = keydown({ key: 'L', shiftKey: true, ctrlKey: true })
      // Still resolves and fires (the action IS registered — jump-latest has
      // no registration-time seam gate) — only the DOM lookup inside run()
      // degrades silently. preventDefault() still happens: dispatch itself
      // does not know the scrollport lookup came back empty.
      expect(event.defaultPrevented).toBe(true)
    })

    it('workbench.conversation.jump-latest fires from inside a textarea (allowWhileTyping)', () => {
      const scrollport = document.createElement('div')
      scrollport.setAttribute('data-conversation-scroll', '')
      Object.defineProperty(scrollport, 'scrollHeight', { value: 1200, configurable: true })
      document.body.appendChild(scrollport)
      const registry = buildShortcutRegistry({ services: focusedServices() })
      detach = attachDispatcher(registry)
      const input = document.createElement('textarea')
      document.body.appendChild(input)
      const event = new KeyboardEvent('keydown', { key: 'L', shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true })
      input.dispatchEvent(event)
      expect(scrollport.scrollTop).toBe(1200)
      expect(event.defaultPrevented).toBe(true)
      scrollport.remove()
      input.remove()
    })
  })
})

// ---------------------------------------------------------------------
// Finding 2 (smoke test) — labels evaluated at registry-build time (a
// third-party's toActionDef snapshot) went stale on a global language
// switch until something else happened to rebuild the registry. Public
// surface found: `dsh-client-locale` fires a genuine cordis `Context` event
// `'locale/change'` ONLY on an actual active-locale switch (verified at the
// pinned 0.1.1-rc.2 store: `@deepseek-ai/dsh-client-locale/lib/types/client/
// index.d.ts:44-58`) — see harness-adapter.ts's `HarnessContext.on` overload
// doc comment for the full citation. applyShortcuts subscribes to it and
// uses its own microtaskCoalesce helper to debounce a burst into one
// rebuild, mirroring the existing thirdPartyActionsHandle.onChange wiring.
// ---------------------------------------------------------------------
describe('applyShortcuts — Finding 2 (locale/change public surface)', () => {
  async function flush(times = 4): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve()
  }

  function makeApplyCtx() {
    const localeListeners = new Set<() => void>()
    const disposeListeners = new Set<() => void>()
    let capturedInject: (() => { controller: { registry: { all(): Array<{ id: string; label: string }> } } }) | undefined
    const ctx = {
      get: vi.fn(() => undefined),
      locale: { register: vi.fn(), bind: vi.fn(() => (key: string) => key) },
      slots: {
        register: vi.fn((def: { inject?: () => unknown }, _component: unknown) => {
          capturedInject = def.inject as typeof capturedInject
        }),
        inject: vi.fn((_slot: string, fn: () => void) => fn()),
      },
      settingsScope: {
        bind: vi.fn(() => ({ getSnapshot: () => ({}), subscribe: () => () => {}, set: vi.fn(), unset: vi.fn() })),
      },
      effect: vi.fn((fn: () => void) => fn()),
      on: vi.fn((event: string, fn: (...args: never[]) => void) => {
        if (event === 'locale/change') {
          localeListeners.add(fn)
          return () => localeListeners.delete(fn)
        }
        if (event === 'dispose') {
          disposeListeners.add(fn)
          return () => disposeListeners.delete(fn)
        }
        return () => {}
      }),
    }
    return {
      ctx: ctx as unknown as HarnessContext,
      fireLocaleChange: () => { for (const fn of [...localeListeners]) fn() },
      fireDispose: () => { for (const fn of [...disposeListeners]) fn() },
      localeListenerCount: () => localeListeners.size,
      getController: () => capturedInject!().controller,
    }
  }

  it('a synchronous burst of locale/change triggers exactly one debounced registry rebuild, and re-evaluates a third-party function-label', async () => {
    const { ctx, fireLocaleChange, getController } = makeApplyCtx()
    const handle = applyShortcuts(ctx)
    let lang: 'en' | 'zh' = 'en'
    handle.service.register({ id: 'p.greet', label: () => (lang === 'en' ? 'Hello' : '你好'), run: () => {} })
    expect(getController().registry.all().find((a) => a.id === 'p.greet')?.label).toBe('Hello')

    const registerIntoSpy = vi.spyOn(handle, 'registerInto')
    lang = 'zh'
    fireLocaleChange()
    fireLocaleChange()
    fireLocaleChange() // synchronous burst — must coalesce to one rebuild, not three
    expect(registerIntoSpy).not.toHaveBeenCalled() // still queued on the microtask (genuinely debounced)
    await flush()
    expect(registerIntoSpy).toHaveBeenCalledTimes(1)
    expect(getController().registry.all().find((a) => a.id === 'p.greet')?.label).toBe('你好')
  })

  it('the locale/change subscription is disposed with the plugin (ctx.on("dispose", ...))', () => {
    const { ctx, fireDispose, localeListenerCount } = makeApplyCtx()
    applyShortcuts(ctx)
    expect(localeListenerCount()).toBe(1)
    fireDispose()
    expect(localeListenerCount()).toBe(0)
  })
})

describe('workbench.chat.open shortcut registration', () => {
  it('appears in the Settings registry with the default chord and typing opt-in', () => {
    const open = vi.fn(async () => ({ kind: 'no-workspace' as const, sourceSessionId: undefined }))
    const registry = buildShortcutRegistry({ chatActions: { open } })
    const action = registry.all().find(candidate => candidate.id === 'workbench.chat.open')

    expect(action).toMatchObject({
      label: 'shortcuts.action.chat.open',
      defaultChord: 'Primary+Shift+C',
      allowWhileTyping: true,
    })
    expect(registry.bindingChord('workbench.chat.open')).toBe('Primary+Shift+c')
    action?.run()
    expect(open).toHaveBeenCalledOnce()
  })

  it('is absent without the capability-backed instance and honors override/disable state', () => {
    expect(buildShortcutRegistry().all().some(action => action.id === 'workbench.chat.open')).toBe(false)
    const chatActions = { open: vi.fn(async () => ({ kind: 'no-workspace' as const, sourceSessionId: undefined })) }
    const overridden = buildShortcutRegistry({
      chatActions,
      overrides: { 'workbench.chat.open': 'Primary+J' },
    })
    expect(overridden.bindingChord('workbench.chat.open')).toBe('Primary+j')

    const disabled = buildShortcutRegistry({
      chatActions,
      disabled: new Set(['workbench.chat.open']),
    })
    expect(disabled.all().some(action => action.id === 'workbench.chat.open')).toBe(true)
    expect(disabled.bindingChord('workbench.chat.open')).toBeNull()
  })

  it('dispatches from inside the composer because allowWhileTyping is explicit', () => {
    const open = vi.fn(async () => ({ kind: 'no-workspace' as const, sourceSessionId: undefined }))
    const registry = buildShortcutRegistry({ chatActions: { open } })
    const detach = attachProductionDispatcher(registry, { allowSyntheticEventsForTesting: true })
    const input = document.createElement('textarea')
    document.body.appendChild(input)
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'C', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
    }))
    expect(open).toHaveBeenCalledOnce()
    detach()
    input.remove()
  })
})

// ---------------------------------------------------------------------
// MEDIUM 1 (Opus review, round 2 of native-actions-pivot) — end-to-end,
// through the REAL applyShortcuts() wiring (not buildShortcutRegistry
// called directly, and not a hand-fed PreviousSessionTracker): a fake
// `sessions.list` observable feeds the tracker exactly the way a real Host
// would, proving the fix works through the actual subscription wiring, not
// just in isolation. See harness-adapter.ts's `SessionsService.list` doc
// comment for the full fork-vs-stock divergence trace this rests on, and
// capabilities.test.ts's GA-043 block for the registration-gate-only
// (buildShortcutRegistry-level) coverage of the same seams.
// ---------------------------------------------------------------------
describe('applyShortcuts — MEDIUM 1 (workbench.session.previous fed via sessions.list)', () => {
  let detach: (() => void) | undefined
  afterEach(() => { detach?.(); detach = undefined })

  function keydown(init: KeyboardEventInit) {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    window.dispatchEvent(event)
    return event
  }

  function fakeListStore(initialCurrent: string | undefined) {
    let current = initialCurrent
    const listeners = new Set<() => void>()
    return {
      store: {
        getSnapshot: () => ({ current }),
        subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) },
      },
      setCurrent: (id: string | undefined) => {
        current = id
        for (const fn of [...listeners]) fn()
      },
    }
  }

  function makeApplyCtx(sessions: unknown) {
    let capturedInject: (() => {
      controller: { registry: { all(): Array<{ id: string; isEnabled?: () => boolean; run: () => void }> } }
    }) | undefined
    const ctx = {
      get: vi.fn((name: string) => (name === 'sessions' ? sessions : undefined)),
      locale: { register: vi.fn(), bind: vi.fn(() => (key: string) => key) },
      slots: {
        register: vi.fn((def: { inject?: () => unknown }) => {
          capturedInject = def.inject as typeof capturedInject
        }),
        inject: vi.fn((_slot: string, fn: () => void) => fn()),
      },
      settingsScope: {
        bind: vi.fn(() => ({ getSnapshot: () => ({}), subscribe: () => () => {}, set: vi.fn(), unset: vi.fn() })),
      },
      effect: vi.fn((fn: () => void) => fn()),
      on: vi.fn(() => () => {}),
    }
    return {
      ctx: ctx as unknown as HarnessContext,
      getController: () => capturedInject!().controller,
    }
  }

  it('a real list.subscribe notification updates the tracker, and stock-shaped services (open + list, NO presentation at all) register the action AND make it genuinely functional — the exact bug MEDIUM 1 found', () => {
    const { store, setCurrent } = fakeListStore('s1')
    const open = vi.fn()
    // Stock-shaped: `open` + `list`, deliberately no `presentation` — the
    // real-world shape the original (presentation-fed) implementation left
    // permanently inert.
    const sessions = { scope: vi.fn(), open, list: store }
    const { ctx, getController } = makeApplyCtx(sessions)
    applyShortcuts(ctx)
    // Simulates a manual session switch reaching the tracker through the
    // SAME list.subscribe wiring applyShortcuts itself set up — not a
    // hand-fed tracker.
    setCurrent('s2')

    const registry = getController().registry
    const action = registry.all().find((a) => a.id === 'workbench.session.previous')
    expect(action).toBeDefined()
    expect(action!.isEnabled?.()).toBe(true)

    detach = attachProductionDispatcher(registry as unknown as ReturnType<typeof buildShortcutRegistry>, {
      allowSyntheticEventsForTesting: true,
    })
    const event = keydown({ key: 'q', altKey: true })
    expect(open).toHaveBeenCalledWith('s1')
    expect(event.defaultPrevented).toBe(true)
  })

  it('feed absent (no list, no presentation — `open` alone is not enough) -> workbench.session.previous does not register', () => {
    const sessions = { scope: vi.fn(), open: vi.fn() } // stock reality if `list` were ever missing
    const { ctx, getController } = makeApplyCtx(sessions)
    applyShortcuts(ctx)
    const registry = getController().registry
    expect(registry.all().some((a) => a.id === 'workbench.session.previous')).toBe(false)
  })
})
