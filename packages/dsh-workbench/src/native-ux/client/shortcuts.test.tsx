// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachDispatcher as attachProductionDispatcher, buildShortcutRegistry, isEditableTarget, isTrustedShortcutEvent } from './shortcuts.js'
import { navigatorBus } from './navigator-bus.js'
import { createThirdPartyActionsHandle } from './actions-api.js'

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

  const presentation = (focused: string) => ({
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
        presentation: { state: { getSnapshot: () => ({ focused: 's2' }) }, close },
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
})
