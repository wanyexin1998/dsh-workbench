// @vitest-environment jsdom
// F1 — the ENFORCEMENT half of the startup guard (guard.test.ts covers the
// verdict half).
//
// The guard decides whether this build can drive a host's presentation face,
// but the presentation-gated capabilities downstream do not ask it: they
// re-probe the same face themselves with a strictly weaker predicate.
// `sideChatServices` (harness-adapter.ts) requires only
// protocol/state.getSnapshot/open/focus; `editionPresentation`
// (chat-actions.ts) requires the same four. Neither checks
// `requestCapacity`, that `getSnapshot()` returns instead of throwing, or
// that the snapshot carries a `visible` array and a numeric `capacity` —
// every one of which the guard does check. The two gates are therefore not
// nested: a host can fail the guard and still satisfy side chat, in which
// case the banner reads "disabled", capacity is never requested, and a
// side-chat click still forks a child session and displaces the source Pane.
//
// `presentationBlindSessions`/`presentationBlindContext` close that by making
// a disabled verdict withhold `sessions.presentation` from every module
// below, so all of them degrade the way they do on a stock Harness. These
// tests pin both halves: the views themselves, and the end-to-end apply()
// consequence — a partial protocol-2 face that also carries fork/scope must
// leave `sideChat.available === false` — plus the paired positive case, so a
// structurally complete fork host stays fully usable.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'
import { presentationBlindContext, presentationBlindSessions, runStartupGuard } from '../src/client/guard.ts'
import { SUPPORTED_HARNESS } from '../src/client/contract.ts'
import { resetWarnOnce } from '../src/native-ux/client/capabilities.ts'

/** Build the ctx test double index.tsx reads (mirrors tests/stock-mode.test.tsx). */
function makeCtx(sessions: unknown) {
  const registered: { name: string; id: string }[] = []
  const injected: Record<string, unknown> = {}
  const slots = {
    register: vi.fn((def: { id: string; name: string; inject?: (...args: unknown[]) => unknown }) => {
      registered.push({ name: def.name, id: def.id })
      if (def.inject !== undefined) injected[def.id] = def.inject('s1')
      return vi.fn()
    }),
    inject: vi.fn((_name: string, setup: () => unknown) => setup()),
  }
  const ctx = {
    sessions,
    slots,
    locale: { register: vi.fn(() => vi.fn()), bind: vi.fn(() => (key: string) => key) },
    conversation: {
      input: {
        for: vi.fn(() => ({
          state: { getSnapshot: () => ({ draft: '', draftRev: 0, occurrences: [] }) },
          insertReference: vi.fn(() => false),
          notify: vi.fn(),
        })),
      },
    },
    inputTriggers: { registerSource: vi.fn(() => vi.fn()) },
    settingsScope: {
      bind: vi.fn(() => ({
        getSnapshot: () => ({}), subscribe: undefined, set: vi.fn(async () => {}), unset: vi.fn(async () => {}),
      })),
    },
    effect: vi.fn((fn: () => unknown) => { fn() }),
    reflect: { provide: vi.fn(() => vi.fn()) },
    get: vi.fn((name: string) => name === 'sessions' ? sessions : undefined),
    on: vi.fn(),
  }
  return { ctx, registered, injected }
}

function sideChatAvailable(injected: Record<string, unknown>): boolean {
  return (injected['dsh-workbench.selection-actions'] as { sideChat: { available: boolean } }).sideChat.available
}

/** Every Edition member side chat probes, on a face carrying the right number. */
function forkFace(overrides: Record<string, unknown> = {}) {
  return {
    protocol: 2,
    requestCapacity: vi.fn(() => vi.fn()),
    state: { getSnapshot: () => ({ visible: ['s1'], focused: 's1', capacity: 2 }) },
    open: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
    ...overrides,
  }
}

function forkSessions(presentation: unknown) {
  return { presentation, fork: vi.fn(async () => 'child'), scope: vi.fn(), open: vi.fn() }
}

beforeEach(() => { resetWarnOnce() })
afterEach(() => { vi.restoreAllMocks() })

describe('presentationBlindSessions', () => {
  it('reads as a sessions service that never had a presentation face', () => {
    const presentation = forkFace()
    const blind = presentationBlindSessions({ presentation, fork: vi.fn(), scope: vi.fn() }) as {
      presentation?: unknown
      fork?: unknown
    }
    expect(blind.presentation).toBeUndefined()
    expect('presentation' in blind).toBe(false)
    expect(typeof blind.fork).toBe('function')
  })

  it('keeps a class-instance host working, including one with true private fields', () => {
    class HostSessions {
      readonly #sessionIds = ['s1', 's2']
      readonly presentation = forkFace()
      scope(id: string) { return this.#sessionIds.includes(id) ? { id } : undefined }
    }
    const host = new HostSessions()
    const blind = presentationBlindSessions(host) as {
      presentation?: unknown
      scope(id: string): unknown
    }
    expect(blind.presentation).toBeUndefined()
    // Unbound, `#sessionIds` would throw a TypeError here.
    expect(blind.scope('s1')).toEqual({ id: 's1' })
    expect(blind.scope('nope')).toBeUndefined()
    // The view still answers for the host's prototype, so a caller that
    // brand-checks the service sees what it would see without the view.
    expect(blind).toBeInstanceOf(HostSessions)
  })

  // The view is a Proxy, and a Proxy may not contradict the invariants of its
  // own target. With the real service as the target, every trap this view
  // needs is illegal the moment the host owns `presentation` as a
  // non-configurable data property: `get` may not answer `undefined` for it,
  // `has` may not report it absent, and no method may come back as a bound
  // copy of a non-writable value. Each throws a TypeError at the access site
  // — turning "degrade to stock behavior" into "crash on every read". Both
  // hosts below reach that state through ordinary hardening.
  it.each([
    ['a frozen host', () => Object.freeze({ presentation: forkFace(), fork: vi.fn(), scope: vi.fn() })],
    ['a host installing presentation as non-writable and non-configurable', () => {
      const host: Record<string, unknown> = { fork: vi.fn(), scope: vi.fn() }
      Object.defineProperty(host, 'presentation', {
        value: forkFace(), writable: false, configurable: false, enumerable: true,
      })
      return host
    }],
  ])('withholds presentation from %s without throwing', (_label, makeHost) => {
    const blind = presentationBlindSessions(makeHost()) as { presentation?: unknown; fork?: unknown }
    expect(() => blind.presentation).not.toThrow()
    expect(blind.presentation).toBeUndefined()
    expect('presentation' in blind).toBe(false)
    expect(typeof blind.fork).toBe('function')
    expect(Object.keys(blind as object)).not.toContain('presentation')
  })

  it('hides presentation from key enumeration and spread, and keeps every other member', () => {
    const blind = presentationBlindSessions({ presentation: forkFace(), fork: 1, scope: 2 }) as object
    expect(Object.keys(blind)).toEqual(['fork', 'scope'])
    expect({ ...blind }).toEqual({ fork: 1, scope: 2 })
  })

  it('passes a non-object sessions value straight through', () => {
    expect(presentationBlindSessions(undefined)).toBeUndefined()
    expect(presentationBlindSessions(null)).toBeNull()
  })
})

describe('presentationBlindContext', () => {
  it('resolves get("sessions") to the blind view and forwards every other name and member', () => {
    const real = { sessions: { presentation: forkFace() }, workspaces: { list: {} }, tag: 'ctx' }
    const ctx = {
      ...real,
      get: (name: string) => (real as Record<string, unknown>)[name],
      effect: vi.fn(),
    }
    const blindSessions = { marker: 'blind' }
    const view = presentationBlindContext(ctx, blindSessions)
    expect(view.get('sessions')).toBe(blindSessions)
    expect(view.get('workspaces')).toBe(real.workspaces)
    expect(view.tag).toBe('ctx')
    view.effect(() => {})
    expect(ctx.effect).toHaveBeenCalledOnce()
  })

  it('forwards through a frozen context without throwing', () => {
    // Same proxy-invariant trap as the sessions view: `get` here always
    // returns a wrapper or a bound method, never the frozen context's own
    // value, so a real-target Proxy throws on the first read.
    const real = { sessions: { presentation: forkFace() }, workspaces: { list: {} }, tag: 'ctx' }
    const effect = vi.fn()
    const ctx = Object.freeze({
      ...real,
      get: (name: string) => (real as Record<string, unknown>)[name],
      effect,
    })
    const blindSessions = { marker: 'blind' }
    const view = presentationBlindContext(ctx, blindSessions)
    expect(() => view.get('sessions')).not.toThrow()
    expect(view.get('sessions')).toBe(blindSessions)
    expect(view.get('workspaces')).toBe(real.workspaces)
    expect(view.tag).toBe('ctx')
    view.effect(() => {})
    expect(effect).toHaveBeenCalledOnce()
    expect(Object.keys(view)).toContain('tag')
  })
})

describe('apply() — a guard-disabled host cannot re-derive an Edition answer downstream', () => {
  // Each face carries EVERY member side chat probes (protocol 2, working
  // state.getSnapshot, open, focus) and is paired with fork+scope, so
  // `sideChatServices` on its own says "available". Only the guard rejects
  // them. Without the enforcement view, clicking Ask in side chat on any of
  // these really forks a child and displaces the source Pane.
  it.each([
    ['requestCapacity absent', forkFace({ requestCapacity: undefined })],
    ['state.getSnapshot throws', forkFace({ state: { getSnapshot: () => { throw new Error('boom') } } })],
    ['snapshot.visible not an array', forkFace({ state: { getSnapshot: () => ({ visible: 'nope', capacity: 2 }) } })],
    ['snapshot.capacity not a number', forkFace({ state: { getSnapshot: () => ({ visible: [], capacity: '2' }) } })],
  ])('withholds side chat from a protocol-2 fork face whose %s', (_label, presentation) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sessions = forkSessions(presentation)
    // Precondition: the guard rejects it...
    expect(runStartupGuard(sessions, SUPPORTED_HARNESS)).toMatchObject({ disabled: true })
    const { ctx, registered, injected } = makeCtx(sessions)
    apply(ctx as never)
    // ...so the disabled banner shows AND the fork capability is gone.
    expect(registered).toContainEqual({ name: 'shell.overlay', id: 'dsh-workbench.guard-failure' })
    expect(sideChatAvailable(injected)).toBe(false)
  })

  it('never lets a withheld capability call the host face it was denied', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const presentation = forkFace({ requestCapacity: undefined })
    const sessions = forkSessions(presentation)
    const { ctx, injected } = makeCtx(sessions)
    apply(ctx as never)
    const sideChat = (injected['dsh-workbench.selection-actions'] as {
      sideChat: {
        available: boolean
        askInSideChat(selection: unknown): Promise<{ kind: string }>
      }
    }).sideChat
    const result = await sideChat.askInSideChat({
      parentSessionId: 's1', text: 'hi', anchors: [], nodeKeys: [],
    })
    expect(result.kind).toBe('unavailable')
    expect(sessions.fork).not.toHaveBeenCalled()
    expect(presentation.open).not.toHaveBeenCalled()
  })

  // No false positives: this is the shape the pinned fork actually ships.
  it('leaves a structurally complete protocol-2 fork host fully usable', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const presentation = forkFace()
    const sessions = forkSessions(presentation)
    expect(runStartupGuard(sessions, SUPPORTED_HARNESS)).toEqual({ disabled: false })
    const { ctx, registered, injected } = makeCtx(sessions)
    apply(ctx as never)
    expect(error).not.toHaveBeenCalled()
    expect(registered.some((entry) => entry.id === 'dsh-workbench.guard-failure')).toBe(false)
    expect(registered).toContainEqual({ name: 'shell.overlay', id: 'dsh-workbench.same-workspace' })
    expect(presentation.requestCapacity).toHaveBeenCalledWith(2)
    expect(sideChatAvailable(injected)).toBe(true)
  })
})
