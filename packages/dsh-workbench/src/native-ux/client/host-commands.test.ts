// @vitest-environment jsdom
// W2.3 — host slash-command bridge tests. Mutation-mindset: each behavior
// below is deletable, and a corresponding assertion fails if it is.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActionRegistry } from '../core/action-registry.js'
import { parseChord } from '../core/chord.js'
import { resetWarnOnce } from './capabilities.js'
import {
  HOST_PROVIDER,
  buildHostActionDef,
  createHostCommandsHandle,
  directExecuteCommand,
  hostCommandActionId,
  insertIntoComposer,
} from './host-commands.js'
import type { HarnessContext, HarnessServices, HostCommandDescriptor } from './harness-adapter.js'

// NIT 9: every DOM node a test mounts is tracked here and swept in a single
// shared afterEach, so an assertion failure partway through a test can never
// leave stray elements behind to cascade into a LATER test's queries.
const mounted: HTMLElement[] = []
function mount<T extends HTMLElement>(el: T, parent: ParentNode = document.body): T {
  parent.appendChild(el)
  mounted.push(el)
  return el
}

beforeEach(() => resetWarnOnce())
afterEach(() => {
  vi.restoreAllMocks()
  for (const el of mounted.splice(0)) el.remove()
})

function descriptor(name: string, overrides: Partial<HostCommandDescriptor> = {}): HostCommandDescriptor {
  return { name, description: 'Do ' + name, ...overrides }
}

/** A focused-session test double with an OPTIONAL working `subscribe` (the
 * ObservableSnapshot contract BLOCKING-1 relies on). `setFocus` mutates the
 * value `getSnapshot()` reports; `notify()` synchronously invokes every
 * listener registered through `subscribe`, mirroring how the real store
 * would announce a change. */
function makeFocusEnv(opts: {
  focused?: string
  binding?: (id: string) => unknown
  subscribe?: boolean
  getSnapshotSpy?: () => void
} = {}) {
  let focused = opts.focused
  const listeners = new Set<() => void>()
  const state: { getSnapshot: () => { focused?: string }; subscribe?: (fn: () => void) => () => void } = {
    getSnapshot: () => {
      opts.getSnapshotSpy?.()
      return { focused }
    },
  }
  if (opts.subscribe === true) {
    state.subscribe = (fn: () => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
  }
  const services = {
    sessions: {
      scope: vi.fn(),
      presentation: { state, close: vi.fn() },
      binding: opts.binding as never,
    },
  } as unknown as HarnessServices
  return {
    services,
    setFocus: (id: string | undefined) => { focused = id },
    notify: () => { for (const fn of [...listeners]) fn() },
    subscriberCount: () => listeners.size,
  }
}

/** Convenience wrapper over makeFocusEnv for the many tests that only need
 * a fixed focus + optional binding (no subscribe simulation). */
function servicesWithFocus(
  sessionId: string | undefined,
  bindingFn?: (id: string) => unknown,
  getSnapshotSpy?: () => void,
): HarnessServices {
  return makeFocusEnv({ focused: sessionId, binding: bindingFn, getSnapshotSpy }).services
}

/** A `remote` + `remote.commands` double. `fireChange()` synchronously
 * invokes every listener registered through `$on`, mirroring how the real
 * forwarded event delivers `commands/change`. */
function makeRemote(initial: readonly HostCommandDescriptor[]) {
  const listeners = new Set<() => void>()
  const list = vi.fn(async () => ({ ok: true as const, value: initial }))
  const remote = {
    $on: vi.fn((_event: string, listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
  }
  const remoteCommands = { list }
  return {
    remote,
    remoteCommands,
    fireChange: () => {
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

function ctxWith(remote: unknown, remoteCommands: unknown): HarnessContext {
  return {
    get: vi.fn((name: string) => (name === 'remote' ? remote : name === 'remote.commands' ? remoteCommands : undefined)),
    locale: { register: vi.fn(), bind: vi.fn(() => (key: string) => key) },
    slots: { register: vi.fn(), inject: vi.fn() },
    settingsScope: { bind: vi.fn() } as unknown as HarnessContext['settingsScope'],
    effect: vi.fn((fn: () => void) => fn()),
    on: vi.fn(),
  }
}

/** Drain a handful of microtask hops — enough for `await commands.list(...)`
 * (itself an async fn, so at least one hop to settle) plus this module's own
 * continuation, with margin for the debounce's own queueMicrotask. Extra
 * hops beyond what a scenario strictly needs are harmless: a still-pending
 * promise just keeps sitting there. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

function seatIn(root: ParentNode = document.body): { seat: HTMLElement; textarea: HTMLTextAreaElement } {
  const seat = document.createElement('div')
  seat.setAttribute('data-composer-seat', '')
  const textarea = document.createElement('textarea')
  seat.appendChild(textarea)
  mount(seat, root)
  return { seat, textarea }
}

describe('createHostCommandsHandle — W2.1 enumeration', () => {
  it('registers host.command.<name> actions with provider "host"', async () => {
    const { remote, remoteCommands } = makeRemote([descriptor('foo'), descriptor('bar')])
    const services = servicesWithFocus('s1')
    const handle = createHostCommandsHandle(ctxWith(remote, remoteCommands), services)
    await flush()
    const registry = new ActionRegistry()
    handle.registerInto(registry, services, { overrides: {}, disabled: new Set(), directExecute: new Set() })
    const actions = registry.all()
    expect(actions.map((a) => a.id).sort()).toEqual(['host.command.bar', 'host.command.foo'])
    expect(actions.every((a) => a.provider === HOST_PROVIDER)).toBe(true)
  })

  it('uses the host-provided description verbatim as the label (not a dictionary key)', async () => {
    const { remote, remoteCommands } = makeRemote([descriptor('foo', { description: 'Some host-authored text' })])
    const services = servicesWithFocus('s1')
    const handle = createHostCommandsHandle(ctxWith(remote, remoteCommands), services)
    await flush()
    const registry = new ActionRegistry()
    handle.registerInto(registry, services, { overrides: {}, disabled: new Set(), directExecute: new Set() })
    expect(registry.all()[0]?.label).toBe('Some host-authored text')
  })

  it('never assigns a default chord to a discovered host command', async () => {
    const { remote, remoteCommands } = makeRemote([descriptor('foo')])
    const services = servicesWithFocus('s1')
    const handle = createHostCommandsHandle(ctxWith(remote, remoteCommands), services)
    await flush()
    const registry = new ActionRegistry()
    handle.registerInto(registry, services, { overrides: {}, disabled: new Set(), directExecute: new Set() })
    expect(registry.all()[0]?.defaultChord).toBeNull()
    expect(registry.bindingChord('host.command.foo')).toBeNull()
  })

  it('enumerates using the currently focused session id', async () => {
    const { remote, remoteCommands } = makeRemote([descriptor('foo')])
    const services = servicesWithFocus('s42')
    createHostCommandsHandle(ctxWith(remote, remoteCommands), services)
    await flush()
    expect(remoteCommands.list).toHaveBeenCalledWith('s42')
  })

  it('no focused session at construction time -> empty snapshot, list() never called (yet)', async () => {
    const { remote, remoteCommands } = makeRemote([descriptor('foo')])
    const services = servicesWithFocus(undefined)
    const handle = createHostCommandsHandle(ctxWith(remote, remoteCommands), services)
    await flush()
    expect(remoteCommands.list).not.toHaveBeenCalled()
    expect(handle.snapshot()).toEqual([])
  })
})

// ---------------------------------------------------------------------
// BLOCKING 1 — cold-start fix: focus arriving via subscription (after apply()
// ran with no focused session yet) must still trigger enumeration.
// ---------------------------------------------------------------------
describe('BLOCKING 1 — focus-change subscription (cold start)', () => {
  it('apply() with no focus, then focus arrives via the subscription -> list() is called and the action registers', async () => {
    const { remote, remoteCommands } = makeRemote([descriptor('foo')])
    const env = makeFocusEnv({ focused: undefined, subscribe: true })
    const handle = createHostCommandsHandle(ctxWith(remote, remoteCommands), env.services)
    await flush()
    expect(remoteCommands.list).not.toHaveBeenCalled() // cold start: still no focus
    expect(handle.snapshot()).toEqual([])

    // Focus "arrives" (the session list settles) — the store notifies.
    env.setFocus('s1')
    env.notify()
    await flush()

    expect(remoteCommands.list).toHaveBeenCalledWith('s1')
    const registry = new ActionRegistry()
    handle.registerInto(registry, env.services, { overrides: {}, disabled: new Set(), directExecute: new Set() })
    expect(registry.all().map((a) => a.id)).toEqual(['host.command.foo'])
  })

  it('a notification whose focus is UNCHANGED from the last successful enumeration does not trigger a redundant list() call', async () => {
    const { remote, remoteCommands } = makeRemote([descriptor('foo')])
    const env = makeFocusEnv({ focused: 's1', subscribe: true })
    createHostCommandsHandle(ctxWith(remote, remoteCommands), env.services)
    await flush()
    remoteCommands.list.mockClear()
    env.notify() // same focus ('s1') — nothing actually changed
    await flush()
    expect(remoteCommands.list).not.toHaveBeenCalled()
  })

  it('subscribe absent on presentation.state -> degrades to the pre-W2.1-fix behavior (commands/change-only) without throwing', async () => {
    const { remote, remoteCommands, fireChange } = makeRemote([descriptor('foo')])
    // subscribe: false (default) -> makeFocusEnv never installs a subscribe method.
    const env = makeFocusEnv({ focused: undefined })
    expect(() => createHostCommandsHandle(ctxWith(remote, remoteCommands), env.services)).not.toThrow()
    await flush()
    expect(remoteCommands.list).not.toHaveBeenCalled()
    // Focus changing produces no notification at all (no subscribe was ever
    // installed) — the only remaining resync trigger is commands/change.
    env.setFocus('s1')
    await flush()
    expect(remoteCommands.list).not.toHaveBeenCalled()
    fireChange()
    await flush()
    expect(remoteCommands.list).toHaveBeenCalledWith('s1')
  })

  it('subscribe present but malformed (throws on call) degrades to no subscription rather than crashing construction', () => {
    const { remote, remoteCommands } = makeRemote([descriptor('foo')])
    const services = {
      sessions: {
        scope: vi.fn(),
        presentation: {
          state: {
            getSnapshot: () => ({ focused: 's1' }),
            subscribe: () => { throw new Error('boom') },
          },
          close: vi.fn(),
        },
      },
    } as unknown as HarnessServices
    expect(() => createHostCommandsHandle(ctxWith(remote, remoteCommands), services)).not.toThrow()
  })
})

describe('fail-soft — absent/malformed remote face', () => {
  it('absent remote AND remote.commands -> zero actions, no throw, exactly one warnOnce', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const services = servicesWithFocus('s1')
    const handle = createHostCommandsHandle(ctxWith(undefined, undefined), services)
    expect(handle.snapshot()).toEqual([])
    const registry = new ActionRegistry()
    expect(() =>
      handle.registerInto(registry, services, { overrides: {}, disabled: new Set(), directExecute: new Set() }),
    ).not.toThrow()
    expect(registry.all()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('host-commands-remote-absent')
  })

  it('malformed remote (present but missing $on) is treated the same as absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const services = servicesWithFocus('s1')
    const handle = createHostCommandsHandle(ctxWith({ notAFunction: true }, { list: vi.fn() }), services)
    expect(handle.snapshot()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('malformed remote.commands (present but missing list) is treated the same as absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const services = servicesWithFocus('s1')
    const handle = createHostCommandsHandle(ctxWith({ $on: vi.fn() }, { notAFunction: true }), services)
    expect(handle.snapshot()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('warnOnce fires only once even across repeated registerInto calls', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const services = servicesWithFocus('s1')
    const handle = createHostCommandsHandle(ctxWith(undefined, undefined), services)
    const registry = new ActionRegistry()
    handle.registerInto(registry, services, { overrides: {}, disabled: new Set(), directExecute: new Set() })
    handle.registerInto(registry, services, { overrides: {}, disabled: new Set(), directExecute: new Set() })
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('commands/change re-sync', () => {
  it('adds newly-listed commands and disposes ones no longer listed', async () => {
    const { remote, remoteCommands, fireChange } = makeRemote([descriptor('foo')])
    const services = servicesWithFocus('s1')
    const handle = createHostCommandsHandle(ctxWith(remote, remoteCommands), services)
    await flush()
    const registry = new ActionRegistry()
    handle.registerInto(registry, services, { overrides: {}, disabled: new Set(), directExecute: new Set() })
    expect(registry.all().map((a) => a.id)).toEqual(['host.command.foo'])

    remoteCommands.list.mockImplementation(async () => ({ ok: true as const, value: [descriptor('bar')] }))
    fireChange()
    await flush()
    handle.registerInto(registry, services, { overrides: {}, disabled: new Set(), directExecute: new Set() })
    expect(registry.all().map((a) => a.id)).toEqual(['host.command.bar'])
  })

  it('mutation-proof: dispose() actually frees a bound chord, not just the action row', async () => {
    const { remote, remoteCommands, fireChange } = makeRemote([descriptor('foo')])
    const services = servicesWithFocus('s1')
    const handle = createHostCommandsHandle(ctxWith(remote, remoteCommands), services)
    await flush()
    const registry = new ActionRegistry()
    const overrides = { 'host.command.foo': 'Primary+Shift+Z' }
    handle.registerInto(registry, services, { overrides, disabled: new Set(), directExecute: new Set() })
    expect(registry.resolve(parseChord('Primary+Shift+Z')!)?.id).toBe('host.command.foo')

    remoteCommands.list.mockImplementation(async () => ({ ok: true as const, value: [] }))
    fireChange()
    await flush()
    handle.registerInto(registry, services, { overrides, disabled: new Set(), directExecute: new Set() })
    expect(registry.all()).toEqual([])
    // If dispose() were a no-op (e.g. deleted only from an internal Map but
    // never called the registry's own disposer), the chord would still
    // resolve to the old action, or registering a fresh action on the same
    // chord would spuriously report a conflict against a ghost owner.
    expect(registry.resolve(parseChord('Primary+Shift+Z')!)).toBeNull()
    const result = registry.register({ id: 'other.action', label: 'x', defaultChord: 'Primary+Shift+Z', run: () => {} })
    expect(result.conflictWith).toBeUndefined()
  })

  it('a rebuilt (different instance) registry gets the current snapshot registered fresh, not skipped', async () => {
    const { remote, remoteCommands } = makeRemote([descriptor('foo')])
    const services = servicesWithFocus('s1')
    const handle = createHostCommandsHandle(ctxWith(remote, remoteCommands), services)
    await flush()
    const firstRegistry = new ActionRegistry()
    handle.registerInto(firstRegistry, services, { overrides: {}, disabled: new Set(), directExecute: new Set() })
    // Simulate shortcuts.tsx's reload(): a brand-new ActionRegistry, as
    // buildShortcutRegistry() constructs on every rebuild.
    const secondRegistry = new ActionRegistry()
    handle.registerInto(secondRegistry, services, { overrides: {}, disabled: new Set(), directExecute: new Set() })
    expect(secondRegistry.all().map((a) => a.id)).toEqual(['host.command.foo'])
  })

  // -----------------------------------------------------------------
  // SF5 — a descriptor that CHANGES under the same command name, on a
  // same-registry re-sync, must be disposed and re-registered fresh (not
  // silently skipped by the "already registered" fast path).
  // -----------------------------------------------------------------
  it('SF5: a command that GAINS `input` on a same-registry re-sync is disposed and re-registered — hasInput/label update, direct-execute is blocked', async () => {
    const { remote, remoteCommands, fireChange } = makeRemote([descriptor('foo')]) // input-less initially
    const services = servicesWithFocus('s1', () => ({ session: { command: vi.fn() } }))
    const handle = createHostCommandsHandle(ctxWith(remote, remoteCommands), services)
    await flush()
    const registry = new ActionRegistry()
    const optIn = new Set([hostCommandActionId('foo')])
    handle.registerInto(registry, services, { overrides: {}, disabled: new Set(), directExecute: optIn })
    const before = registry.all().find((a) => a.id === hostCommandActionId('foo'))!
    expect(before.hasInput).toBe(false)

    // Same NAME, but the descriptor now declares `input` and a new label.
    remoteCommands.list.mockImplementation(async () => ({
      ok: true as const,
      value: [descriptor('foo', { description: 'Now needs args', input: { hint: 'text' } })],
    }))
    fireChange()
    await flush()
    handle.registerInto(registry, services, { overrides: {}, disabled: new Set(), directExecute: optIn })

    const after = registry.all().find((a) => a.id === hostCommandActionId('foo'))!
    expect(after.hasInput).toBe(true)
    expect(after.label).toBe('Now needs args')
    // Enforcement follows the refreshed descriptor: the (still-active)
    // opt-in must no longer take effect once the command has input.
    const { seat, textarea } = seatIn()
    after.run()
    expect(textarea.value).toBe('/foo ')
    seat.remove()
  })

  it('SF5 counterpart: an UNCHANGED descriptor on a same-registry re-sync leaves the live registration (and its chord binding) alone', async () => {
    const { remote, remoteCommands, fireChange } = makeRemote([descriptor('foo'), descriptor('bar')])
    const services = servicesWithFocus('s1')
    const handle = createHostCommandsHandle(ctxWith(remote, remoteCommands), services)
    await flush()
    const registry = new ActionRegistry()
    const overrides = { 'host.command.foo': 'Primary+Shift+Z' }
    handle.registerInto(registry, services, { overrides, disabled: new Set(), directExecute: new Set() })
    const fooBefore = registry.all().find((a) => a.id === hostCommandActionId('foo'))

    // Re-sync with the exact same descriptors ('bar' unaffected, 'foo' byte-identical).
    fireChange()
    await flush()
    handle.registerInto(registry, services, { overrides, disabled: new Set(), directExecute: new Set() })
    const fooAfter = registry.all().find((a) => a.id === hostCommandActionId('foo'))

    // Same live ActionDef object — proof it was never disposed/re-registered.
    expect(fooAfter).toBe(fooBefore)
    expect(registry.resolve(parseChord('Primary+Shift+Z')!)?.id).toBe('host.command.foo')
  })
})

// ---------------------------------------------------------------------
// SF2 — stale-response guard
// ---------------------------------------------------------------------
describe('SF2 — stale in-flight response guard', () => {
  it('an older list() call that settles AFTER a newer one must not overwrite the newer result', async () => {
    const { remote, remoteCommands, fireChange } = makeRemote([descriptor('foo')])
    const services = servicesWithFocus('s1')
    const handle = createHostCommandsHandle(ctxWith(remote, remoteCommands), services)
    await flush()
    const registry = new ActionRegistry()
    handle.registerInto(registry, services, { overrides: {}, disabled: new Set(), directExecute: new Set() })
    expect(registry.all().map((a) => a.id)).toEqual(['host.command.foo'])

    // First resync: list() hangs (manually controlled resolution).
    let resolveSlow!: (value: { ok: true; value: HostCommandDescriptor[] }) => void
    const slow = new Promise<{ ok: true; value: HostCommandDescriptor[] }>((resolve) => { resolveSlow = resolve })
    remoteCommands.list.mockImplementationOnce(() => slow)
    fireChange()
    await flush() // refresh() starts and suspends on `await slow` — never resolves on its own

    // Second, independent resync: list() resolves quickly with a DIFFERENT result.
    remoteCommands.list.mockImplementationOnce(async () => ({ ok: true as const, value: [descriptor('bar')] }))
    fireChange()
    await flush()
    handle.registerInto(registry, services, { overrides: {}, disabled: new Set(), directExecute: new Set() })
    expect(registry.all().map((a) => a.id)).toEqual(['host.command.bar'])

    // The stale call finally settles — its ('foo') result must be discarded.
    resolveSlow({ ok: true, value: [descriptor('foo')] })
    await flush()
    handle.registerInto(registry, services, { overrides: {}, disabled: new Set(), directExecute: new Set() })
    expect(registry.all().map((a) => a.id)).toEqual(['host.command.bar']) // unchanged by the stale settle
  })
})

// ---------------------------------------------------------------------
// SF3/SF4 — dispose safety and coverage
// ---------------------------------------------------------------------
describe('SF3/SF4 — dispose safety', () => {
  it('SF4: dispose() invokes the $on disposer — a fireChange() after dispose triggers no further list()', async () => {
    const { remote, remoteCommands, fireChange } = makeRemote([descriptor('foo')])
    const services = servicesWithFocus('s1')
    const handle = createHostCommandsHandle(ctxWith(remote, remoteCommands), services)
    await flush()
    remoteCommands.list.mockClear()
    handle.dispose()
    fireChange()
    await flush()
    expect(remoteCommands.list).not.toHaveBeenCalled()
  })

  it('dispose() unsubscribes the focus-change listener too', async () => {
    const { remote, remoteCommands } = makeRemote([descriptor('foo')])
    const env = makeFocusEnv({ focused: 's1', subscribe: true })
    const handle = createHostCommandsHandle(ctxWith(remote, remoteCommands), env.services)
    await flush()
    expect(env.subscriberCount()).toBe(1)
    handle.dispose()
    expect(env.subscriberCount()).toBe(0)
    remoteCommands.list.mockClear()
    env.setFocus('s2')
    env.notify()
    await flush()
    expect(remoteCommands.list).not.toHaveBeenCalled()
  })

  it('a resync queued (via commands/change) BEFORE dispose(), whose microtask fires AFTER dispose(), is a no-op', async () => {
    const { remote, remoteCommands, fireChange } = makeRemote([descriptor('foo')])
    const services = servicesWithFocus('s1')
    const handle = createHostCommandsHandle(ctxWith(remote, remoteCommands), services)
    await flush()
    remoteCommands.list.mockClear()
    const onChange = vi.fn()
    handle.onChange(onChange)
    fireChange() // schedules the debounced resync's microtask
    handle.dispose() // dispose happens before that microtask has a chance to run
    await flush()
    expect(remoteCommands.list).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('an in-flight list() call still pending at dispose() time does not mutate state or fire onChange once it resolves', async () => {
    const { remote, remoteCommands, fireChange } = makeRemote([descriptor('foo')])
    const services = servicesWithFocus('s1')
    const handle = createHostCommandsHandle(ctxWith(remote, remoteCommands), services)
    await flush()
    let resolvePending!: (value: { ok: true; value: HostCommandDescriptor[] }) => void
    const pending = new Promise<{ ok: true; value: HostCommandDescriptor[] }>((resolve) => { resolvePending = resolve })
    remoteCommands.list.mockImplementationOnce(() => pending)
    fireChange()
    await flush() // refresh() is now suspended awaiting `pending`
    const onChange = vi.fn()
    handle.onChange(onChange)
    handle.dispose()
    resolvePending({ ok: true, value: [descriptor('bar')] }) // resolves AFTER dispose
    await flush()
    expect(onChange).not.toHaveBeenCalled()
    expect(handle.snapshot()).toEqual([descriptor('foo')]) // unchanged: still the pre-dispose snapshot
  })

  it('dispose() clears onChange listeners: a fake fireChange-equivalent call cannot reach a stale listener', async () => {
    const { remote, remoteCommands, fireChange } = makeRemote([descriptor('foo')])
    const services = servicesWithFocus('s1')
    const handle = createHostCommandsHandle(ctxWith(remote, remoteCommands), services)
    await flush()
    const onChange = vi.fn()
    handle.onChange(onChange)
    handle.dispose()
    remoteCommands.list.mockImplementation(async () => ({ ok: true as const, value: [descriptor('bar')] }))
    fireChange() // no-ops post-dispose (SF4), but even if it somehow fired, listeners are cleared
    await flush()
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('debounce — coalesces a burst into one re-sync', () => {
  it('a synchronous burst of commands/change triggers exactly one additional list() call', async () => {
    const { remote, remoteCommands, fireChange } = makeRemote([descriptor('foo')])
    const services = servicesWithFocus('s1')
    createHostCommandsHandle(ctxWith(remote, remoteCommands), services)
    await flush()
    remoteCommands.list.mockClear()
    fireChange()
    fireChange()
    fireChange()
    await flush()
    expect(remoteCommands.list).toHaveBeenCalledTimes(1)
  })

  it('two bursts separated by a full flush each trigger their own re-sync', async () => {
    const { remote, remoteCommands, fireChange } = makeRemote([descriptor('foo')])
    const services = servicesWithFocus('s1')
    createHostCommandsHandle(ctxWith(remote, remoteCommands), services)
    await flush()
    remoteCommands.list.mockClear()
    fireChange()
    await flush()
    fireChange()
    await flush()
    expect(remoteCommands.list).toHaveBeenCalledTimes(2)
  })
})

describe('W2.2 dispatch — insert vs direct-execute, has-input enforcement', () => {
  it('default mapping (no opt-in) inserts into the composer for an input-less command', () => {
    const commandFn = vi.fn(async () => ({ ok: true as const, value: { matched: true } }))
    const services = servicesWithFocus('s1', () => ({ session: { command: commandFn } }))
    const { seat, textarea } = seatIn()
    const action = buildHostActionDef(descriptor('foo'), services, new Set())
    action.run()
    expect(commandFn).not.toHaveBeenCalled()
    expect(textarea.value).toBe('/foo ')
    seat.remove()
  })

  it('opted-in input-less command direct-executes via binding(id).session.command', () => {
    const commandFn = vi.fn(async () => ({ ok: true as const, value: { matched: true } }))
    const services = servicesWithFocus('s1', () => ({ session: { command: commandFn } }))
    const { seat, textarea } = seatIn()
    const action = buildHostActionDef(descriptor('foo'), services, new Set([hostCommandActionId('foo')]))
    action.run()
    expect(commandFn).toHaveBeenCalledWith('/foo')
    expect(textarea.value).toBe('') // never touched the composer
    seat.remove()
  })

  it('HOSTILE STATE: a has-input command never direct-executes even when the persisted opt-in claims it', () => {
    const commandFn = vi.fn(async () => ({ ok: true as const, value: { matched: true } }))
    const services = servicesWithFocus('s1', () => ({ session: { command: commandFn } }))
    const { seat, textarea } = seatIn()
    const withArgs = descriptor('withArgs', { input: { hint: 'text to send' } })
    // Hostile: the persisted set claims the opt-in for a has-input command —
    // buildHostActionDef must ignore it, gated on the live descriptor.
    const action = buildHostActionDef(withArgs, services, new Set([hostCommandActionId('withArgs')]))
    expect(action.hasInput).toBe(true)
    action.run()
    expect(commandFn).not.toHaveBeenCalled()
    expect(textarea.value).toBe('/withArgs ')
    seat.remove()
  })

  it('hasInput is false for an input-less descriptor (Settings-UI gate data)', () => {
    const services = servicesWithFocus('s1')
    const action = buildHostActionDef(descriptor('foo'), services, new Set())
    expect(action.hasInput).toBe(false)
  })

  // Finding 1 (smoke test) — every host bridge action's own default mapping
  // fires FROM inside the composer; suppressing while typing made the
  // bridge dead for its primary flow. Both dispatch branches (insert-mode
  // default, direct-execute opt-in) must set the escape hatch — the chord
  // gesture is explicit either way.
  it('sets allowWhileTyping: true regardless of direct-execute opt-in (insert-mode branch)', () => {
    const services = servicesWithFocus('s1')
    const action = buildHostActionDef(descriptor('foo'), services, new Set())
    expect(action.allowWhileTyping).toBe(true)
  })

  it('sets allowWhileTyping: true regardless of direct-execute opt-in (direct-execute branch)', () => {
    const services = servicesWithFocus('s1')
    const action = buildHostActionDef(descriptor('foo'), services, new Set([hostCommandActionId('foo')]))
    expect(action.allowWhileTyping).toBe(true)
  })

  it('no focused session at run() time -> no-op (neither insert nor execute)', () => {
    const commandFn = vi.fn(async () => ({ ok: true as const, value: { matched: true } }))
    const services = servicesWithFocus(undefined, () => ({ session: { command: commandFn } }))
    const { seat, textarea } = seatIn()
    const action = buildHostActionDef(descriptor('foo'), services, new Set([hostCommandActionId('foo')]))
    expect(() => action.run()).not.toThrow()
    expect(commandFn).not.toHaveBeenCalled()
    expect(textarea.value).toBe('')
    seat.remove()
  })
})

describe('insertIntoComposer', () => {
  it('writes "/name " into the focused pane composer, focuses it, and fires a real input event', () => {
    const pane = document.createElement('section')
    pane.dataset.sessionPane = 's1'
    mount(pane)
    const { textarea } = seatIn(pane)
    const inputListener = vi.fn()
    textarea.addEventListener('input', inputListener)
    insertIntoComposer(servicesWithFocus('s1'), 's1', 'foo')
    expect(textarea.value).toBe('/foo ')
    expect(document.activeElement).toBe(textarea)
    expect(inputListener).toHaveBeenCalledOnce()
  })

  it('scopes insertion to the pane matching the passed-in sessionId, not an unfocused sibling pane', () => {
    const focused = mount(document.createElement('section'))
    focused.dataset.sessionPane = 's1'
    const other = mount(document.createElement('section'))
    other.dataset.sessionPane = 's2'
    const focusedSeat = seatIn(focused)
    const otherSeat = seatIn(other)
    insertIntoComposer(servicesWithFocus('s1'), 's1', 'foo')
    expect(focusedSeat.textarea.value).toBe('/foo ')
    expect(otherSeat.textarea.value).toBe('')
  })

  it('no composer seat present -> no-op, does not throw', () => {
    const services = servicesWithFocus('s1')
    expect(() => insertIntoComposer(services, 's1', 'foo')).not.toThrow()
  })
})

describe('directExecuteCommand — async-identity rule', () => {
  it('calls binding() synchronously with the id passed in, never re-reading focus after an await', () => {
    let currentFocus = 's1'
    const bindingCalls: string[] = []
    const services = servicesWithFocus(
      // getSnapshot() is intentionally never consulted by directExecuteCommand
      // itself — this stub exists only so servicesWithFocus type-checks.
      currentFocus,
      (id: string) => {
        bindingCalls.push(id)
        return {
          session: {
            command: vi.fn(async () => {
              currentFocus = 's2' // focus "moves" while the call is in flight
              return { ok: true as const, value: { matched: true } }
            }),
          },
        }
      },
    )
    directExecuteCommand(services, 's1', 'foo')
    // binding() already ran, synchronously, with the id this function was
    // handed — not a re-read of "current" focus (which a naive
    // implementation might do after the promise settles).
    expect(bindingCalls).toEqual(['s1'])
  })

  it('binding absent on the sessions service -> silent no-op, no throw', () => {
    const services = servicesWithFocus('s1') // no bindingFn supplied
    expect(() => directExecuteCommand(services, 's1', 'foo')).not.toThrow()
  })
})

// NIT 7: buildHostActionDef's run() reads focusedSessionId() exactly once
// and then hands the CAPTURED value down to whichever branch it dispatches
// to (insertIntoComposer no longer re-reads it itself) — exercised on BOTH
// branches, not just direct-execute.
describe('buildHostActionDef.run() reads focus exactly once (both dispatch branches)', () => {
  function trapFocus(sequence: readonly string[]) {
    let calls = 0
    const services = servicesWithFocus(
      undefined,
      (id: string) => ({ session: { command: vi.fn(async () => ({ ok: true as const, value: { matched: true } })) } }),
    )
    services.sessions!.presentation!.state.getSnapshot = () => {
      const focused = sequence[Math.min(calls, sequence.length - 1)]
      calls++
      return { focused }
    }
    return { services, callCount: () => calls }
  }

  it('direct-execute branch: binding() receives the id from the FIRST read, even though a second read would differ', () => {
    const { services, callCount } = trapFocus(['s1', 's2'])
    const bindingIds: string[] = []
    const originalBinding = services.sessions!.binding!
    services.sessions!.binding = ((id: string) => { bindingIds.push(id); return originalBinding(id) }) as typeof originalBinding
    const action = buildHostActionDef(descriptor('foo'), services, new Set([hostCommandActionId('foo')]))
    action.run()
    expect(callCount()).toBe(1)
    expect(bindingIds).toEqual(['s1'])
  })

  it('insert branch: the composer targeted is the pane for the FIRST read, even though a second read would differ', () => {
    const { services, callCount } = trapFocus(['s1', 's2'])
    const pane1 = mount(document.createElement('section'))
    pane1.dataset.sessionPane = 's1'
    const pane2 = mount(document.createElement('section'))
    pane2.dataset.sessionPane = 's2'
    const seat1 = seatIn(pane1)
    const seat2 = seatIn(pane2)
    const action = buildHostActionDef(descriptor('foo'), services, new Set()) // no opt-in -> insert branch
    action.run()
    expect(callCount()).toBe(1)
    expect(seat1.textarea.value).toBe('/foo ')
    expect(seat2.textarea.value).toBe('')
  })
})
