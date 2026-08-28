// W2 — Host slash-command bridge (design.md §3 "L1", §6 W2 rows).
//
// Three responsibilities, kept in one module because they share the same
// fail-soft resolution and the same descriptor snapshot:
//   W2.1 enumeration + `commands/change` subscription (debounced) + a
//        focus-change subscription (also debounced) that closes the
//        cold-start gap where apply() runs before any session is focused
//        yet — see createHostCommandsHandle / createHostCommandSync.
//   W2.2 dual mapping (insert-into-composer default, opt-in direct-execute)
//        — see buildHostActionDef / insertIntoComposer / directExecuteCommand.
//
// Verified access routes (file:line citations live on the types themselves,
// in harness-adapter.ts — HostCommandDescriptor, RemoteResult,
// RemoteCommandsFace, RemoteFace, SessionBindingFace, and the
// ObservableSnapshot contract behind subscribeFocusedSessionId).
import { ActionRegistry, type ActionDef } from '../core/action-registry.js'
import { UNBOUND_SENTINEL, type BindingOverrides } from '../core/shortcut-settings.js'
import { focusedPaneScope, locateComposerInput, setComposerValue } from './conversation-dom.js'
import { warnOnce } from './capabilities.js'
import {
  focusedSessionId,
  resolveRemoteServices,
  subscribeFocusedSessionId,
  type HarnessContext,
  type HarnessServices,
  type HostCommandDescriptor,
  type RemoteResult,
} from './harness-adapter.js'

/** Provider id for every action this module registers (Settings grouping —
 * design.md §4 "按 provider 分组"). */
export const HOST_PROVIDER = 'host'

/** `host.command.<name>` — the frozen id shape from design.md §3/§5. */
export function hostCommandActionId(name: string): string {
  return 'host.command.' + name
}

/** Same '' -> explicit-unbind / undefined -> default-chord mapping
 * shortcuts.tsx's private `unbind()` applies to built-ins. Duplicated
 * (not imported) rather than exported across the shortcuts.tsx <->
 * host-commands.ts boundary: shortcuts.tsx already imports from this
 * module (to wire host actions into the registry it builds), so importing
 * back the other way would be circular. One line, frozen semantics — see
 * shortcut-persistence.ts's BUILTIN_NAMESPACE_PREFIX comment for the same
 * duplicate-a-constant-not-a-coupling precedent in this codebase. Host
 * actions never have a default chord (see buildHostActionDef), so in
 * practice this only ever distinguishes "explicit Unbound" from "no
 * override yet" for a host action id — but the mapping is kept identical
 * to the built-in path for a single obvious semantics across providers.
 */
function unbindSpec(spec: string | undefined): string | null {
  return spec === UNBOUND_SENTINEL ? '' : (spec ?? null)
}

// ---------------------------------------------------------------------
// W2.2 — dual mapping execution
// ---------------------------------------------------------------------

/**
 * Default mapping for EVERY host command action: insert `/name ` into the
 * focused pane's composer and focus it, so the user confirms with Enter
 * (design.md §3 rule 3 — v1 default is always composer-insert; execute is
 * opt-in per action).
 *
 * Insertion mechanism, chosen after checking for a public API first: the
 * only local @deepseek-ai client package that exposes a composer/draft
 * write surface is `dsh-client-ui-conversation`'s `IConversation.input:
 * SessionInputResolver` — `SessionInputResolver.for(actx: ClientContext):
 * SessionInput`, `SessionInput.setDraft(text): void` (verified at the
 * pinned 0.1.1-rc.2 store: `lib/types/client/input/contract.ts:29,55-58`,
 * `lib/types/client/service.d.ts:25-27`). It genuinely exists, is reachable
 * (the `actx` `setDraft()` needs is exactly what `sessions.scope()` already
 * returns, and this package already injects `dsh-client-ui-conversation`),
 * and was NOT used here for one reason, not several: it only writes the
 * draft text — it has no "focus the composer" verb. Using it would still
 * need the DOM `[data-composer-seat]` marker for focus anyway (the same
 * marker `focusComposer`, shortcuts.tsx, already uses), so pairing a public
 * API for the value with DOM for the focus buys nothing over one
 * consistent, already-proven mechanism doing both.
 *
 * So: reuse the established `[data-composer-seat]` marker + the native
 * value-setter/input-event dispatch pattern for React-controlled inputs
 * (setComposerValue, conversation-dom.ts), scoped to the focused pane's
 * seat with a document-wide fallback — identical scoping to
 * `focusComposer`.
 *
 * Limits of this DOM path, documented rather than hidden:
 *   - It breaks silently (no action, no error) if the host renames/removes
 *     `[data-composer-seat]`, or swaps the seat's editable child for
 *     something outside `COMPOSER_EDITABLE_SELECTOR`. Same fail-soft
 *     trade-off `focusComposer` already accepted for the composer-focus L0
 *     action; W2 does not introduce a new risk class here, just a second
 *     consumer of it.
 *   - `SessionInput`'s own doc comment is explicit that "[a]ll mutation
 *     rides machine events" — `setDraft()` is the one sanctioned write path
 *     precisely so every draft change goes through the input state
 *     machine's own bookkeeping (occurrence tracking, undo log, etc). The
 *     native-setter route below does not go through that machine at all —
 *     it fakes the DOM-level signal (`input` event) the real composer
 *     listens for, without the state machine ever recording the edit as one
 *     of its own transactions. Accepted risk, not an oversight: for this
 *     action's narrow shape (append `/name ` to what is normally an empty
 *     draft, immediately followed by the user typing or pressing Enter) the
 *     divergence between "DOM says X" and "the machine thinks X" is
 *     transient and self-healing on the user's very next keystroke, but a
 *     future consumer of this pattern for a different composer interaction
 *     should not assume the same is true for theirs.
 */
export function insertIntoComposer(services: HarnessServices, sessionId: string, name: string): void {
  const target = locateComposerInput(focusedPaneScope(sessionId))
  if (target === null) return
  setComposerValue(target, '/' + name + ' ')
  target.focus()
}

/**
 * Opt-in mapping: execute the command immediately via the focused session's
 * public face — `ISessions.binding(id).session.command(line)` (verified:
 * see `SessionBindingFace` in harness-adapter.ts for the exact citation).
 * `sessionId` MUST be the id the caller captured at keypress (async-identity
 * rule — design.md §3, V2 report): this function makes exactly one
 * synchronous call chain (`binding(sessionId) -> .session.command(line)`)
 * and never re-reads "the current focused session" after an await, so a
 * focus change that happens while the returned promise is in flight cannot
 * retarget an execution that has already been dispatched.
 *
 * Fire-and-forget, matching the existing L0 `stopSession` pattern
 * (shortcuts.tsx): a business/transport failure is the session's own
 * concern (it settles into that session's own state), not a second
 * plugin-level toast here. `binding` itself is optional on `SessionsService`
 * (a `sessions` double predating W2 legitimately lacks it) — absence
 * degrades to a silent no-op, matching every other capability-gated path
 * in this plugin.
 */
export function directExecuteCommand(services: HarnessServices, sessionId: string, name: string): void {
  const binding = services.sessions?.binding?.(sessionId)
  if (binding === undefined) return
  void binding.session.command('/' + name).catch(() => {})
}

/**
 * Build the ActionDef for one host command. `directExecuteOptIn` is
 * consulted ONLY when the descriptor declares no `input` — a has-input
 * command NEVER direct-executes, enforced here (not just in the Settings
 * UI that offers the toggle), against the live descriptor captured in this
 * closure, so a stale or hostile persisted opt-in can never bypass the ban
 * even if the UI toggle were somehow shown for it.
 */
export function buildHostActionDef(
  descriptor: HostCommandDescriptor,
  services: HarnessServices,
  directExecuteOptIn: ReadonlySet<string>,
): ActionDef {
  const id = hostCommandActionId(descriptor.name)
  const hasInput = descriptor.input !== undefined
  return {
    id,
    // Host text verbatim, NOT a dictionary key: dsh-commands'
    // CommandDescriptor.description is host-authored, untranslated prose —
    // there is no locale hook for it client-side, and this client cannot
    // guess the user's language intent for someone else's plugin text. The
    // shared t() helper already falls back to returning an unrecognized key
    // verbatim (every call site in this package does, including the test
    // doubles), so handing it the raw description renders correctly without
    // inventing a translation seam for text this client can never localize.
    label: descriptor.description,
    // design.md anti-goals (§7): never auto-assign a default chord to a
    // discovered action — only an explicit user binding ever occupies a key.
    defaultChord: null,
    provider: HOST_PROVIDER,
    hasInput,
    // Finding 1 (smoke test): every host bridge action's own default mapping
    // IS an explicit chord gesture fired from inside the composer (insert
    // `/name ` there) — direct-execute is the same explicit gesture, just
    // skipping the composer round-trip. Suppressing the chord while the
    // composer itself is focused made the bridge dead for its primary use
    // case, so both modes opt into while-typing dispatch unconditionally.
    allowWhileTyping: true,
    run: () => {
      // Async-identity rule: captured now, at keypress — never re-read after
      // an await inside this closure or its callees.
      const sessionId = focusedSessionId(services)
      if (sessionId === undefined) return // fail-closed: no focused pane
      if (!hasInput && directExecuteOptIn.has(id)) {
        directExecuteCommand(services, sessionId, descriptor.name)
      } else {
        insertIntoComposer(services, sessionId, descriptor.name)
      }
    },
  }
}

// ---------------------------------------------------------------------
// W2.1 — enumeration, registry sync, and commands/change subscription
// ---------------------------------------------------------------------

export interface HostCommandSyncOptions {
  overrides: BindingOverrides
  disabled: ReadonlySet<string>
  directExecute: ReadonlySet<string>
}

/** One live registration this module owns: the descriptor it was built
 * from (so a later sync can detect the descriptor changing under the same
 * name) plus its W1.1 disposer. */
interface HostSyncEntry {
  descriptor: HostCommandDescriptor
  dispose: () => void
}

/** Structural equality for one descriptor — shared by `sameDescriptors`
 * (list-level, gates whether a re-sync is worth doing at all) and `sync()`
 * itself (per-command, gates whether an unchanged command's live
 * registration — and its chord binding — is left alone). */
function descriptorEquals(a: HostCommandDescriptor, b: HostCommandDescriptor): boolean {
  return a.name === b.name && a.description === b.description && JSON.stringify(a.input) === JSON.stringify(b.input)
}

/** Structural comparison so a `commands/change` burst that leaves the
 * effective set unchanged (e.g. an unrelated plugin's registry churn) does
 * not spuriously fire onChange / trigger a registry rebuild. */
function sameDescriptors(a: readonly HostCommandDescriptor[], b: readonly HostCommandDescriptor[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!descriptorEquals(a[i], b[i])) return false
  }
  return true
}

/**
 * Incremental register/dispose of `host.command.<name>` actions against a
 * registry, driven by the current descriptor snapshot. `sync()` is safe to
 * call repeatedly:
 *   - Called again with the SAME registry instance (a `commands/change`
 *     re-sync without an intervening shortcuts.tsx reload): diffs the new
 *     descriptor set against what is currently registered.
 *       - A name no longer wanted: disposed (through the W1.1
 *         `RegisterResult.dispose()` this module holds onto).
 *       - A name that is wanted AND whose descriptor is byte-identical to
 *         what is currently registered: left untouched — its ActionDef
 *         closure (and chord binding, if any) survives as-is.
 *       - A name that is wanted but whose descriptor CHANGED (e.g. a
 *         command that gained/lost `input`, or whose description changed):
 *         disposed and re-registered fresh with the new descriptor. This
 *         is required, not cosmetic — buildHostActionDef's `hasInput` flag
 *         and its dispatch-time has-input check are both closed over the
 *         descriptor at registration time, so leaving the OLD closure live
 *         under a NEW descriptor would silently keep dispatching against
 *         stale `hasInput`/label data (a has-input command that used to be
 *         input-less could keep direct-executing under an opt-in that was
 *         only ever valid for the old, input-less shape).
 *       - A newly wanted name: registered.
 *   - Called with a DIFFERENT registry instance (shortcuts.tsx's
 *     `buildShortcutRegistry` builds a brand-new `ActionRegistry` on every
 *     reload — settings changes, hydration): the old disposers are already
 *     moot (their registry was discarded wholesale), so bookkeeping resets
 *     and every wanted command registers fresh into the new registry.
 *
 * Not exported: consumed only by createHostCommandsHandle in this module.
 */
function createHostCommandSync() {
  let syncedRegistry: ActionRegistry | null = null
  const entries = new Map<string, HostSyncEntry>()

  function sync(
    registry: ActionRegistry,
    descriptors: readonly HostCommandDescriptor[],
    services: HarnessServices,
    opts: HostCommandSyncOptions,
  ): void {
    if (registry !== syncedRegistry) {
      entries.clear()
      syncedRegistry = registry
    }
    const wanted = new Map(descriptors.map((d) => [d.name, d] as const))
    for (const [name, entry] of [...entries]) {
      if (!wanted.has(name)) {
        entry.dispose()
        entries.delete(name)
      }
    }
    for (const [name, descriptor] of wanted) {
      const existing = entries.get(name)
      if (existing !== undefined) {
        if (descriptorEquals(existing.descriptor, descriptor)) continue // unchanged: leave the live registration alone
        existing.dispose() // descriptor changed under the same name: drop the stale closure first
        entries.delete(name)
      }
      const id = hostCommandActionId(name)
      const result = registry.register(
        buildHostActionDef(descriptor, services, opts.directExecute),
        unbindSpec(opts.overrides[id]),
        opts.disabled.has(id),
      )
      entries.set(name, { descriptor, dispose: result.dispose })
    }
  }

  function disposeAll(): void {
    for (const entry of entries.values()) entry.dispose()
    entries.clear()
    syncedRegistry = null
  }

  return { sync, disposeAll }
}

/** Coalesce a burst of synchronous calls into exactly one invocation of
 * `fn`, scheduled on the microtask queue — the "one microtask/short timer
 * coalescing bursts" debounce the V-report's residual-risk list calls for
 * (`commands/change` firing at high frequency across plugin
 * install/uninstall churn). Exported: shortcuts.tsx reuses this exact
 * coalescing shape for its own `locale/change`-triggered resync (Finding 2,
 * smoke test) — same "one microtask, whatever fired inside it wins" need,
 * imported rather than duplicated since the direction (shortcuts.tsx already
 * imports from this module) is not circular. */
export function microtaskCoalesce(fn: () => void): () => void {
  let scheduled = false
  return () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      fn()
    })
  }
}

export interface HostCommandsHandle {
  /** Current best-known descriptor snapshot (empty when the remote face is
   * absent/malformed, or no session is focused yet). */
  snapshot(): readonly HostCommandDescriptor[]
  /** Reconcile `registry` to the current snapshot — see createHostCommandSync. */
  registerInto(registry: ActionRegistry, services: HarnessServices, opts: HostCommandSyncOptions): void
  /** Fires after the descriptor snapshot actually changes (debounced). The
   * caller (shortcuts.tsx) re-triggers its own registry rebuild, which
   * calls registerInto again with the new snapshot. */
  onChange(fn: () => void): () => void
  dispose(): void
}

/**
 * W2.1 entry point: resolve the remote commands face (fail-soft), and if
 * present, enumerate for the focused agent and subscribe to `commands/change`
 * AND to focus changes (see the cold-start fix below).
 *
 * Fail-soft contract: if `ctx.get('remote')` or the `remote.commands` face
 * is absent or malformed, this returns a handle that contributes ZERO
 * actions, throws nothing, and logs exactly one warnOnce — the W1.3
 * settings page then simply shows no host group, and any persisted
 * `host.command.*` bindings render as orphans (correct: the provider
 * genuinely is not loaded, same as any other absent provider).
 */
export function createHostCommandsHandle(ctx: HarnessContext, services: HarnessServices): HostCommandsHandle {
  const { remote, remoteCommands } = resolveRemoteServices(ctx)
  const sync = createHostCommandSync()

  if (remote === undefined || remoteCommands === undefined) {
    warnOnce(
      'host-commands-remote-absent',
      'ctx.get("remote")/"remote.commands" is absent or malformed; host slash-command actions are not registered (fail-soft, zero actions)',
    )
    return {
      snapshot: () => [],
      registerInto: (registry, svc, opts) => sync.sync(registry, [], svc, opts),
      onChange: () => () => {},
      dispose: () => {},
    }
  }

  let current: readonly HostCommandDescriptor[] = []
  // The session id the last SUCCESSFUL (or successfully-determined-empty)
  // enumeration ran for — not merely the last one attempted. A failed
  // `list()` call leaves this untouched, so a later focus notification for
  // the same still-focused session is free to retry rather than being
  // treated as "no change, skip it".
  let lastEnumeratedSessionId: string | undefined
  // SF3 — dispose safety: once true, refresh() and the coalesced resync
  // callback both no-op immediately (checked both before AND after the one
  // await inside refresh(), so an in-flight list() call that resolves after
  // dispose() cannot mutate `current` or fire a listener that may itself
  // already be gone).
  let disposed = false
  // SF2 — stale-response guard: a `list()` call started, then superseded by
  // a NEWER refresh() (e.g. two focus changes in quick succession, or a
  // focus change racing a commands/change), must not let its late-arriving
  // result overwrite what the newer call already settled. Bumped
  // synchronously right before the await; a stored call's result is only
  // applied if the counter still matches after the await.
  let generation = 0
  const changeListeners = new Set<() => void>()
  const emitChange = () => {
    for (const fn of [...changeListeners]) fn()
  }

  const refresh = async (): Promise<void> => {
    if (disposed) return
    const sessionId = focusedSessionId(services)
    if (sessionId === undefined) {
      lastEnumeratedSessionId = undefined
      if (current.length !== 0) {
        current = []
        emitChange()
      }
      return
    }
    const gen = ++generation
    let result: RemoteResult<readonly HostCommandDescriptor[]>
    try {
      result = await remoteCommands.list(sessionId)
    } catch {
      return // transport hiccup: keep the last-known snapshot, stay silent
    }
    if (disposed || gen !== generation) return // superseded or torn down while in flight
    if (!result.ok) return
    lastEnumeratedSessionId = sessionId
    if (!sameDescriptors(current, result.value)) {
      current = result.value
      emitChange()
    }
  }

  const resync = microtaskCoalesce(() => {
    if (disposed) return
    void refresh()
  })

  // BLOCKING 1 — cold-start fix: apply() commonly runs before the session
  // list/focus has settled, so the eager refresh() below often finds no
  // focused session and returns immediately, and nothing previously drove a
  // SECOND enumeration once focus actually arrived — commands/change is
  // orthogonal to focus and may never fire in that window. Subscribing to
  // the focused-session store itself (verified ObservableSnapshot contract
  // — see subscribeFocusedSessionId's doc comment, harness-adapter.ts)
  // closes that gap: every notification re-reads focusedSessionId() and
  // triggers the same debounced resync whenever it differs from the id the
  // last enumeration actually ran for. A host without a real subscription
  // (subscribeFocusedSessionId's own fail-soft: missing/malformed
  // `subscribe`) gets a no-op unsubscribe here and simply keeps today's
  // behavior — commands/change-driven resync only.
  const onFocusChange = () => {
    if (disposed) return
    if (focusedSessionId(services) === lastEnumeratedSessionId) return
    resync()
  }

  void refresh() // initial enumeration; resolves async and fires onChange like any other change
  const offRemoteChange = remote.$on('commands/change', resync)
  const offFocusChange = subscribeFocusedSessionId(services, onFocusChange)

  return {
    snapshot: () => current,
    registerInto: (registry, svc, opts) => sync.sync(registry, current, svc, opts),
    onChange: (fn) => {
      changeListeners.add(fn)
      return () => changeListeners.delete(fn)
    },
    // SF3: self-sufficient — a caller only needs to call dispose() once,
    // with no required ordering against separately unsubscribing from
    // onChange() first (changeListeners is cleared here regardless).
    dispose: () => {
      disposed = true
      offRemoteChange()
      offFocusChange()
      sync.disposeAll()
      changeListeners.clear()
    },
  }
}
