// T7+T8 — App Shortcuts: Action Registry + keydown dispatcher + native
// Settings → Shortcuts section with recording, browser-reserved warnings,
// conflict handling, enabled toggles, and best-effort Host-backed persistence.
// GA-012/013: the glass chord button is the record entry; advanced controls
// (enabled / clear / unbind) live in a per-row overflow menu.
// GA-023: capability-aware registration — an action whose capability is
// missing is not registered (absent from Settings, binds no chord).
import * as React from 'react'
import { ActionRegistry, DEFAULT_PROVIDER, type ActionDef } from '../core/action-registry.js'
import { chordFromEvent, formatChord, parseChord, type Chord, type Platform } from '../core/chord.js'
import { bindingReport, parseBindingOverrides, validateChordSpec, UNBOUND_SENTINEL, type BindingOverrides } from '../core/shortcut-settings.js'
import {
  FallbackShortcutPersistence,
  HostShortcutPersistence,
  LocalShortcutPersistence,
} from './shortcut-persistence.js'
import { NS } from './locales.js'
import { warnOnce } from './capabilities.js'
import { navigatorBus } from './navigator-bus.js'
import {
  focusedSessionId,
  resolveHarnessServices,
  type HarnessContext,
  type HarnessServices,
  type SettingsScopeFace,
} from './harness-adapter.js'
import { focusedPaneScope, locateComposerInput } from './conversation-dom.js'
import {
  createHostCommandsHandle,
  HOST_PROVIDER,
  microtaskCoalesce,
  type HostCommandsHandle,
} from './host-commands.js'
import { createThirdPartyActionsHandle, type ThirdPartyActionsHandle } from './actions-api.js'

export function platformOf(): Platform {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? 'mac' : 'other'
}

/**
 * Narrow a host settings snapshot (typed `unknown` by the harness) to the
 * section that holds shortcut bindings. The bound third-party namespace
 * answers either `user` or `value`; anything else is treated as empty.
 * Single narrowing point so the section body stays `any`-free.
 */
export function settingsBindingSection(snapshot: unknown): Record<string, unknown> {
  if (typeof snapshot !== 'object' || snapshot === null) return {}
  const obj = snapshot as Record<string, unknown>
  const section = obj.user ?? obj.value
  return typeof section === 'object' && section !== null ? (section as Record<string, unknown>) : {}
}

// focusedSessionId now lives in harness-adapter.ts (shared with
// host-commands.ts, W2) — see its doc comment there for the full
// fail-closed rationale this used to carry inline.

function focusComposer(services: HarnessServices): void {
  locateComposerInput(focusedPaneScope(focusedSessionId(services)))?.focus()
}

function stopSession(services: HarnessServices): void {
  const sessionId = focusedSessionId(services)
  if (sessionId === undefined) return
  const scoped = services.sessions?.scope(sessionId)
  scoped?.get('conversation')?.cancel?.()
}

// GA-023: the favorite-agent console.warn placeholder is gone. favorite
// actions register only when the caller asserts the capability (a real
// open API is not exposed by the harness rc yet — issue #1 proposal 4).

export function isEditableEvent(event: Event): boolean {
  // composedPath()[0] is the real target even across shadow boundaries.
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  const realTarget: EventTarget | null = path.length > 0 ? (path[0] as EventTarget) : event.target
  if (realTarget === null || typeof (realTarget as HTMLElement).tagName !== 'string') return false
  const el = realTarget as HTMLElement
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return el.isContentEditable === true || el.contentEditable === 'true' || el.contentEditable === 'plaintext-only'
}

/** Node-only variant for non-event targets (tests). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || typeof (target as HTMLElement).tagName !== 'string') return false
  const el = target as HTMLElement
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return el.isContentEditable === true || el.contentEditable === 'true' || el.contentEditable === 'plaintext-only'
}

/** GA-023: capability switches consulted at registry-construction time.
 * All default to `true` for call compatibility except `favoriteAgent`
 * (default `false`: the harness rc has no favorite-agent API, and GA-002
 * forbids registering fake placeholder actions). */
export interface ShortcutCapabilities {
  navigator?: boolean
  composerFocus?: boolean
  sidebarToggle?: boolean
  sessionStop?: boolean
  favoriteAgent?: boolean
}

export interface ShortcutActionOptions {
  services?: HarnessServices
  overrides?: BindingOverrides
  disabled?: ReadonlySet<string>
  caps?: ShortcutCapabilities
  /** W2.1: host slash-command bridge — resolved once by applyShortcuts and
   * threaded through every rebuild so host.command.* actions stay in sync
   * with the same overrides/disabled/reload lifecycle as built-ins. Absent
   * in tests that do not exercise W2 (registerInto is simply never called). */
  hostCommandsHandle?: HostCommandsHandle
  /** W2.2: persisted per-action direct-execute opt-in (host.command.<name>
   * ids). Consulted by host-commands.ts only for input-less commands. */
  hostDirectExecute?: ReadonlySet<string>
  /** W3.1: public `workbench.actions` third-party registrations — mirrors
   * hostCommandsHandle's registerInto threading (see actions-api.ts). Absent
   * in tests that do not exercise W3 (registerInto is simply never called). */
  thirdPartyActionsHandle?: ThirdPartyActionsHandle
}

/** Explicit-unbound sentinel maps to the registry's unbind marker (''). */
function unbind(spec: string | undefined): string | null {
  return spec === UNBOUND_SENTINEL ? '' : (spec ?? null)
}

/** Build the registry with the frozen V1.1.1 default keymap + overrides.
 * GA-023: each action registers only when its capability is present (absent
 * capability → action is neither registered nor shown in Settings). */
export function buildShortcutRegistry(options: ShortcutActionOptions = {}): ActionRegistry {
  const services = options.services ?? {}
  const overrides = options.overrides ?? {}
  const disabled = options.disabled ?? new Set<string>()
  const caps = options.caps ?? {}
  // GA-043 fail-soft (§9A.11): service-backed actions register only when the
  // service actually exists — an absent seam degrades that action locally
  // (not shown, not registered) instead of throwing at apply() time.
  const sidebarOn = caps.sidebarToggle !== false && services.layout?.toggleSidebar !== undefined
  const stopOn = caps.sessionStop !== false && services.sessions !== undefined
  // DOM-backed features stay registered: the conversation DOM mounts per
  // session (after apply()), so a one-shot probe can't decide at build time.
  // They fail-soft at runtime — navigator renders null until the scrollport
  // resolves; composer.focus is a no-op without a seat. Presence is reported
  // via the capability probe (capabilities.ts), not hard-removed here.
  const navigatorOn = caps.navigator !== false
  const composerOn = caps.composerFocus !== false
  const favoriteOn = caps.favoriteAgent === true // default false: no real API yet
  const registry = new ActionRegistry()
  if (navigatorOn) {
    registry.register({
      id: 'workbench.conversation.navigator.toggle',
      label: 'shortcuts.action.navigator.toggle',
      defaultChord: 'Primary+Shift+O',
      run: () => navigatorBus.emitToggle(focusedSessionId(services)),
    }, unbind(overrides['workbench.conversation.navigator.toggle']), disabled.has('workbench.conversation.navigator.toggle'))
  }
  if (composerOn) {
    registry.register({
      id: 'workbench.conversation.composer.focus',
      label: 'shortcuts.action.composer.focus',
      defaultChord: 'Primary+/',
      run: () => { focusComposer(services) },
    }, unbind(overrides['workbench.conversation.composer.focus']), disabled.has('workbench.conversation.composer.focus'))
  }
  if (sidebarOn) {
    registry.register({
      id: 'workbench.layout.sidebar.toggle',
      label: 'shortcuts.action.sidebar.toggle',
      defaultChord: 'Primary+B',
      run: () => services.layout?.toggleSidebar(),
    }, unbind(overrides['workbench.layout.sidebar.toggle']), disabled.has('workbench.layout.sidebar.toggle'))
  }
  if (stopOn) {
    registry.register({
      id: 'workbench.session.stop',
      label: 'shortcuts.action.session.stop',
      defaultChord: 'Primary+Shift+X',
      run: () => stopSession(services),
    }, unbind(overrides['workbench.session.stop']), disabled.has('workbench.session.stop'))
  }
  if (services.sessions?.presentation !== undefined) {
    registry.register({
      id: 'workbench.pane.close-focused',
      label: 'shortcuts.action.pane.closeFocused',
      defaultChord: 'Primary+\\',
      run: () => {
        const focused = focusedSessionId(services)
        if (focused !== undefined) services.sessions?.presentation?.close(focused)
      },
    }, unbind(overrides['workbench.pane.close-focused']), disabled.has('workbench.pane.close-focused'))
  }
  if (favoriteOn) {
    for (let index = 1; index <= 9; index++) {
      // W1.2: 'workbench.' + the frozen pre-namespace id (never change the
      // suffix independently of shortcut-persistence.ts's
      // LEGACY_BUILTIN_ACTION_IDS, which migrates the bare form forward).
      const id = 'workbench.agent.favorite.open:' + index
      registry.register({
        id,
        label: 'shortcuts.action.favorite.' + index,
        defaultChord: 'Primary+Shift+' + index,
        run: () => {}, // real implementation deferred until harness exposes an open API
      }, unbind(overrides[id]), disabled.has(id))
    }
  }
  // W2.1: host slash-command actions — registered/removed incrementally by
  // host-commands.ts's own sync logic (see createHostCommandSync), driven
  // by whatever descriptor snapshot is currently known. A missing handle
  // (tests that never construct one) simply means no host group, exactly
  // like an absent remote face at runtime.
  options.hostCommandsHandle?.registerInto(registry, services, {
    overrides,
    disabled,
    directExecute: options.hostDirectExecute ?? new Set(),
  })
  // W3.1: third-party workbench.actions registrations — same "registry
  // build consults the current live store" shape as the host bridge above.
  options.thirdPartyActionsHandle?.registerInto(registry, { overrides, disabled })
  return registry
}

// Recording state shared with the dispatcher: while a row is recording,
// the dispatcher must not fire bound actions for recorded chords.
let recordingActive = false
export function setRecordingActive(active: boolean): void {
  recordingActive = active
}

// Editable targets such as the Composer suppress shortcuts by default. Only
// this allowlist remains reachable while typing; Session stop stays blocked.
// NOTE: this is a *dispatch-time* allowlist (keydown-while-typing policy) —
// unrelated to EDITABLE_PROVIDERS below, which gates *Settings-UI* rebinding.
// The similar name is coincidental; do not conflate the two.
// A per-action escape hatch also reaches while-typing dispatch without
// joining this hardcoded set: ActionDef.allowWhileTyping (action-registry.ts)
// — see attachDispatcher's onKeydown below for where the two are combined.
// This legacy Set itself is frozen; never add to it — a new built-in that
// needs to fire while typing should set allowWhileTyping instead.
const EDITABLE_ALLOWED_ACTIONS = new Set(['workbench.conversation.navigator.toggle'])

// W1.3 — open catalog: the Settings UI now renders every registered action
// (any provider), but only lets the user rebind/clear/unbind/toggle actions
// from a provider we trust today. Per design.md §4/§7 the catalog is open
// but nothing auto-discovered (L1 host commands, L2 plugin API, L3 pinned
// adapters) had landed until W2. A foreign-provider action still renders —
// label, id, current binding, conflict/reserved badges — just without the
// record button or overflow menu.
// W2: 'host' joins the trusted set — host.command.* actions come from a
// verified, declared access route (the remote commands bridge), not an
// arbitrary third-party plugin, so users may bind chords to them exactly
// like Workbench's own actions. A provider beyond workbench/host (future
// L2 public-API plugins, L3 pinned adapters) stays read-only until its own
// work lands.
const EDITABLE_PROVIDERS: ReadonlySet<string> = new Set([DEFAULT_PROVIDER, HOST_PROVIDER])
// W3: a provider with at least one LIVE registration through the public
// `workbench.actions` service (design.md §3 "L2") joins the trusted set too
// — that's the whole point of the API. The trust boundary is the
// REGISTRATION ROUTE, not the provider label: `isThirdPartyProvider` (when
// supplied) answers "did this provider's actions arrive through the
// verified workbench.actions API", so an action manually poked into an
// ActionRegistry some other way (a test double, or a future L3 adapter that
// has not landed its own trust review) stays read-only exactly as before —
// see settings-section.test.tsx's pinned "foreign-provider action ... is
// not editable" regression, which simulates precisely that untrusted path.
function isProviderEditable(provider: string | undefined, isThirdPartyProvider?: (provider: string) => boolean): boolean {
  const id = provider ?? DEFAULT_PROVIDER
  if (EDITABLE_PROVIDERS.has(id)) return true
  return isThirdPartyProvider?.(id) === true
}

/** Accept native user input in production; Vitest uses synthetic DOM events. */
export function isTrustedShortcutEvent(
  event: Pick<KeyboardEvent, 'isTrusted'>,
  allowSyntheticEventsForTesting = false,
): boolean {
  return event.isTrusted || allowSyntheticEventsForTesting
}

/** MEDIUM 1 (Opus review, round 2 of the Finding-1 smoke fix): a chord's
 * `key` (Chord.key — already lowercased by chordFromEvent) is "printable"
 * iff it is exactly one character: a letter, digit, or punctuation mark
 * that Shift alone turns into a different literal character (Shift+a ->
 * 'A', Shift+/ -> '?', Shift+Enter inserts a newline in some composers).
 * Multi-character key names (enter, escape, arrowup, f5, ...) are never a
 * character the user could be trying to type, so they are never
 * "printable" here regardless of Shift. Scoped to gating allowWhileTyping's
 * escape below (see onKeydown) — not a general-purpose key classifier. */
function isPrintableKey(key: string): boolean {
  return Array.from(key).length === 1
}

export function attachDispatcher(
  registry: ActionRegistry,
  options: { allowSyntheticEventsForTesting?: boolean } = {},
): () => void {
  const onKeydown = (event: KeyboardEvent) => {
    if (!isTrustedShortcutEvent(event, options.allowSyntheticEventsForTesting === true)) return
    if (event.isComposing) return
    if (event.repeat) return
    if (recordingActive) return
    // Resolve first, then apply the editable-target policy by action ID.
    const chord = chordFromEvent(event, platformOf())
    const action = registry.resolve(chord)
    if (action === null) return
    // Finding 1 (smoke test): a bound host-command chord used to be dead
    // while the composer was focused, because the default insert-mode
    // mapping's whole job is to fire FROM the composer — the legacy
    // allowlist above never covered host.command.* (or any third-party)
    // ids. `action.allowWhileTyping === true` is the per-action opt-in that
    // fixes this without touching the frozen legacy set.
    // MEDIUM 1 (Opus review, round 2): that escape must not swallow a
    // character the user is actually typing. A Shift-only chord on a
    // printable key IS that character (Shift+A = 'A', Shift+/ = '?') —
    // firing + preventDefault() on it while typing would eat it. Discrete
    // editing gestures (Shift+Enter, Shift+Arrow, Shift+Tab) are DELIBERATELY
    // not covered: binding one means taking it over, same as Primary+A —
    // see ACTIONS_API.md. So the escape only applies when the
    // chord carries a real modifier (Primary/Alt) or targets a non-printable
    // key (Enter, Escape, F-keys, arrows, ...); a Shift-only printable
    // chord stays suppressed while typing, exactly like the pre-Finding-1
    // behavior, for precisely that dangerous subset.
    const allowedWhileTyping =
      EDITABLE_ALLOWED_ACTIONS.has(action.id) ||
      (action.allowWhileTyping === true && (chord.primary || chord.alt || !isPrintableKey(chord.key)))
    if (isEditableEvent(event) && !allowedWhileTyping) return
    event.preventDefault()
    action.run()
  }
  window.addEventListener('keydown', onKeydown)
  return () => window.removeEventListener('keydown', onKeydown)
}

// -------------------------------------------------------------------------
// Settings section (T8)

export interface ShortcutSettingsController {
  registry: ActionRegistry
  scope: SettingsScopeFace
  /** W2.2: `hostDirectExecute` is optional here (unlike the required field
   * of the same name in shortcut-persistence.ts's ShortcutPersistedStateV1)
   * so every pre-W2 caller/test double keeps compiling unchanged; omitting
   * it means "leave the currently committed opt-in set untouched". */
  reload(overrides: BindingOverrides, disabled?: ReadonlySet<string>, hostDirectExecute?: ReadonlySet<string>): void
  /** GA-003/022: persist the full shortcut state (host-first, local fallback). */
  persist(state: { bindings: BindingOverrides; disabled: ReadonlySet<string>; hostDirectExecute?: ReadonlySet<string> }): Promise<'host' | 'local'>
  /** Committed state: the same state the registry dispatches from (host if
   * durable, else the localStorage fallback). Set at hydration and on every
   * save/clear/unbind/toggle. */
  persisted?: { bindings: BindingOverrides; disabled: ReadonlySet<string>; hostDirectExecute?: ReadonlySet<string> }
  /** Observe committed-state changes (hydration is async). Optional: test
   * controllers may omit it. */
  subscribeState?(fn: () => void): () => void
  /** W3.1: true when `provider` currently has a live registration through
   * the public `workbench.actions` service — the Settings-UI editability
   * gate (see isProviderEditable). Optional so every pre-W3 controller/test
   * double keeps compiling; omitting it just means no provider is trusted
   * beyond the existing workbench/host set. */
  isThirdPartyProvider?(provider: string): boolean
}

export interface SettingsSectionProps {
  t: (key: string, vars?: Record<string, string>) => string
  controller: ShortcutSettingsController
  /** Unit-test seam; production registration never supplies it. */
  allowSyntheticEventsForTesting?: boolean
}

const RECORDING_MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock'])

// GA-012: glass chord button visual tokens (no shadow, frosted glass).
const CHORD_BTN_BASE: React.CSSProperties = {
  minWidth: 138,
  padding: '8px 12px',
  borderRadius: 11,
  border: '1px solid rgba(255,255,255,.55)',
  background: 'rgba(255,255,255,.48)',
  backdropFilter: 'blur(14px) saturate(140%)',
  WebkitBackdropFilter: 'blur(14px) saturate(140%)',
  boxShadow: 'none',
  color: '#3f444c',
  cursor: 'pointer',
  fontSize: 13,
  textAlign: 'center',
}

export function SettingsSection({ t, controller, allowSyntheticEventsForTesting = false }: SettingsSectionProps) {
  const [, force] = React.useReducer((x: number) => x + 1, 0)
  const [recordingId, setRecordingId] = React.useState<string | null>(null)
  const [pendingChord, setPendingChord] = React.useState<Chord | null>(null)
  const [pendingSpec, setPendingSpec] = React.useState<string>('')
  // GA-013: which row's overflow menu (enabled/clear/unbind) is open.
  const [overflowId, setOverflowId] = React.useState<string | null>(null)
  // W1.3: search box query (filters rows by label/id) and per-provider
  // disclosure collapse state. design.md §4 only requires groups to be
  // collapsible ("组可折叠"); whether that collapse state survives a remount
  // is left to the implementation. Both are kept ephemeral here — never
  // persisted, reset on remount — to keep the first cut simple.
  const [searchQuery, setSearchQuery] = React.useState('')
  const [collapsedProviders, setCollapsedProviders] = React.useState<ReadonlySet<string>>(new Set())

  React.useEffect(() => controller.scope.subscribe(force), [controller])
  // Re-render when the committed state changes (hydration resolves async and
  // does not go through scope.set). Optional: test controllers omit it.
  React.useEffect(() => controller.subscribeState?.(force) ?? (() => {}), [controller])
  // Sync the session-local disabled set from the committed state when it
  // changes (hydration). Without this, a persisted disabled action would
  // display as enabled even though the registry excluded it.
  React.useEffect(() => {
    if (controller.persisted !== undefined) {
      setLocalDisabled(new Set(controller.persisted.disabled))
      // W2.2: same hydration-sync reasoning as localDisabled above.
      setLocalHostDirectExecute(new Set(controller.persisted.hostDirectExecute ?? []))
    }
  }, [controller.persisted])

  // Close any open overflow menu on outside click.
  React.useEffect(() => {
    if (overflowId === null) return
    const close = (event: MouseEvent) => {
      const el = event.target as HTMLElement | null
      if (el !== null && el.closest('[data-dsh-nux-overflow-root]') === null) setOverflowId(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [overflowId])

  // Local overlay: the harness settings proxy only exposes an official
  // namespace allowlist, so a third-party namespace answers
  // settings-not-exposed (issue #1 proposal 3). Overrides still apply
  // in-memory for the session (dispatcher + UI).
  const [localOverrides, setLocalOverrides] = React.useState<BindingOverrides>({})
  // Defense-in-depth, not a bug fix: the sync effect above (`if
  // (controller.persisted !== undefined) setLocalDisabled(...)`) already
  // handles the mounted case at HEAD — it seeds localDisabled from
  // controller.persisted as soon as persisted state is available, so a
  // persisted `disabled` action does not stay rendered as enabled once that
  // effect has run. What the effect cannot cover is the single render frame
  // between mount and its first run: chordOwners is computed synchronously
  // during render (below), before any effect fires, so on that one frame it
  // could still count an already-disabled action as holding its chord. Lazy-
  // initializing localDisabled straight from `controller.persisted?.disabled`
  // — available synchronously whenever the controller is constructed with it
  // already set (as it is at hydration) — removes that frame entirely
  // instead of relying solely on the effect to patch it in after the fact.
  const [localDisabled, setLocalDisabled] = React.useState<ReadonlySet<string>>(
    () => new Set(controller.persisted?.disabled ?? []),
  )
  // W2.2: mirrors localDisabled's own lazy-init reasoning (closes the same
  // one-frame window before the hydration-sync effect above first runs).
  const [localHostDirectExecute, setLocalHostDirectExecute] = React.useState<ReadonlySet<string>>(
    () => new Set(controller.persisted?.hostDirectExecute ?? []),
  )

  const snapshot = controller.scope.getSnapshot()
  // The display must mirror the registry (what actually dispatches). That is
  // `controller.persisted` — host state when durable, else the localStorage
  // fallback — not the raw host snapshot, which is empty when the namespace
  // is not exposed to this client (settings-not-exposed). Fall back to
  // parsing the snapshot for controllers without a committed state (tests /
  // boot before hydration).
  const persistedOverrides = React.useMemo(() => {
    if (controller.persisted !== undefined) return { ...controller.persisted.bindings }
    return parseBindingOverrides(settingsBindingSection(snapshot))
  }, [controller.persisted, snapshot])
  const overrides = React.useMemo(
    () => ({ ...persistedOverrides, ...localOverrides }),
    [persistedOverrides, localOverrides],
  )

  const platform = platformOf()
  const actions = controller.registry.all()
  const chordOwners = new Map<string, string[]>()
  for (const action of actions) {
    if (localDisabled.has(action.id)) continue // disabled actions hold no chord
    const spec = overrides[action.id] ?? action.defaultChord
    if (spec === null) continue
    const chord = parseChord(spec)
    if (chord === null) continue
    const id = chordKeyOf(chord)
    const list = chordOwners.get(id) ?? []
    list.push(action.id)
    chordOwners.set(id, list)
  }

  // W1.3 — search box: case-insensitive substring match against the
  // localized label OR the raw action id. Empty query = everything matches.
  const query = searchQuery.trim().toLowerCase()
  const matchesQuery = (action: ActionDef): boolean => {
    if (query === '') return true
    if (action.id.toLowerCase().includes(query)) return true
    return t(action.label).toLowerCase().includes(query)
  }
  // A row currently mid-recording must stay visible even if a query typed
  // mid-record would otherwise filter it out — losing the row out from under
  // an in-progress key capture would be jarring. (Recording state itself
  // — recordingId/pendingChord/pendingSpec — lives on this parent component,
  // not inside per-row components, so filtering can never *unmount* it; this
  // guard is purely to keep the row's UI visible while recording.)
  const isVisible = (action: ActionDef): boolean => matchesQuery(action) || action.id === recordingId

  // W1.3 — provider grouping (design.md §4): Workbench first (today's only
  // provider, keeping the page unchanged apart from the new group header),
  // any other provider after it in registry insertion order.
  const byProvider = controller.registry.byProvider()
  const providerIds = [...byProvider.keys()].sort((a, b) => {
    if (a === DEFAULT_PROVIDER) return -1
    if (b === DEFAULT_PROVIDER) return 1
    return 0
  })
  const workbenchActions = byProvider.get(DEFAULT_PROVIDER) ?? []
  const navigationActions = workbenchActions.filter((a) => !a.id.startsWith('workbench.agent.favorite'))
  const favoriteActions = workbenchActions.filter((a) => a.id.startsWith('workbench.agent.favorite'))

  // W1.3 — orphaned overrides (design principle 3, design.md §4 缺席态):
  // a persisted binding key that matches no live registry action — its
  // provider is currently absent. The binding is never dropped by the
  // settings page merely rendering (it comes straight from `overrides`,
  // never filtered out of storage); it only disappears from storage if the
  // user explicitly removes it below.
  // Review fix (should-fix): exclude the built-in `workbench.` namespace from
  // this derivation. buildShortcutRegistry deliberately does NOT register a
  // built-in action whose capability/service seam is absent — e.g.
  // favorite.open:1..9 when caps.favoriteAgent is off (the default shipping
  // config), or sidebar.toggle without services.layout. Such an action's
  // provider is never "absent" the way a foreign plugin's can be; the
  // "provider not loaded" framing and destructive Remove button are simply
  // wrong for it, and would invite deleting the user's own binding for a
  // capability that is merely off right now. Only a genuinely foreign
  // (non-workbench) persisted id can be orphaned here.
  const liveActionIds = new Set(actions.map((a) => a.id))
  const orphanedOverrides = Object.entries(overrides).filter(
    ([id]) => !liveActionIds.has(id) && !id.startsWith(DEFAULT_PROVIDER + '.'),
  )
  // nit: the search box only filtered provider-group rows, leaving the
  // orphaned section unfiltered (and visible, empty-looking-but-not, when a
  // query matched nothing there). Apply the same lowercase substring test —
  // an orphan row has no label to match against, just its raw id.
  const visibleOrphanedOverrides = orphanedOverrides.filter(([id]) => query === '' || id.toLowerCase().includes(query))

  const providerLabel = (providerId: string): string =>
    providerId === DEFAULT_PROVIDER ? t('shortcuts.provider.workbench')
      : providerId === HOST_PROVIDER ? t('shortcuts.provider.host')
      : providerId

  const toggleGroupCollapsed = (providerId: string) => {
    const next = new Set(collapsedProviders)
    if (next.has(providerId)) next.delete(providerId)
    else next.add(providerId)
    setCollapsedProviders(next)
  }

  // Recording capture: only while a row is recording.
  React.useEffect(() => {
    if (recordingId === null) return
    setRecordingActive(true)
    const timeout = window.setTimeout(cancelRecording, 10_000) // auto-cancel safety
    const onKeydown = (event: KeyboardEvent) => {
      if (!isTrustedShortcutEvent(event, allowSyntheticEventsForTesting)) return
      if (event.isComposing) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        cancelRecording()
        return
      }
      if (RECORDING_MODIFIER_KEYS.has(event.key)) return
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        const chord = chordFromEvent(event, platform)
        setPendingChord(chord)
        setPendingSpec(chordToSpec(chord))
      }
    }
    window.addEventListener('keydown', onKeydown, true)
    return () => {
      window.clearTimeout(timeout)
      setRecordingActive(false)
      window.removeEventListener('keydown', onKeydown, true)
    }
  }, [allowSyntheticEventsForTesting, recordingId, platform])

  const cancelRecording = () => {
    setRecordingId(null)
    setPendingChord(null)
    setPendingSpec('')
  }

  const saveRecording = async (actionId: string) => {
    if (pendingChord === null) return
    const newChordId = chordKeyOf(pendingChord)
    // Hard-conflict resolution covers both explicit overrides AND default
    // chords: the recorded chord must have exactly one owner. Displaced
    // bindings become an explicit visible UNBOUND sentinel (never silently
    // deleted, never a silent dead-lock with the default).
    const next: BindingOverrides = {}
    for (const [id, spec] of Object.entries(overrides)) {
      if (id === actionId) continue
      const existing = parseChord(spec)
      if (existing !== null && chordKeyOf(existing) === newChordId) {
        next[id] = UNBOUND_SENTINEL // displaced override → visible unbound
        continue
      }
      next[id] = spec
    }
    for (const action of controller.registry.all()) {
      if (action.id === actionId) continue
      if (action.id in next) continue
      const defaultChord = parseChord(action.defaultChord ?? '')
      if (defaultChord !== null && chordKeyOf(defaultChord) === newChordId) {
        next[action.id] = UNBOUND_SENTINEL // displaced default → explicit unbound
      }
    }
    next[actionId] = pendingSpec
    // GA-003/022: full-state persistence (host first, local fallback on
    // settings-not-exposed). The per-field scope.set below stays for host
    // snapshots that the settings UI reads back via getSnapshot.
    void controller.persist({ bindings: next, disabled: localDisabled, hostDirectExecute: localHostDirectExecute }).catch(() => {})
    controller.scope.set(actionId, pendingSpec).catch(() => {})
    for (const [id, spec] of Object.entries(next)) {
      if (id !== actionId) controller.scope.set(id, spec).catch(() => {})
    }
    setLocalOverrides(next)
    controller.reload(next, localDisabled, localHostDirectExecute)
    cancelRecording()
  }

  const clearBinding = async (actionId: string) => {
    const next = { ...overrides }
    delete next[actionId]
    void controller.persist({ bindings: next, disabled: localDisabled, hostDirectExecute: localHostDirectExecute }).catch(() => {})
    controller.scope.unset(actionId).catch(() => {})
    setLocalOverrides(next)
    controller.reload(next, localDisabled, localHostDirectExecute)
  }

  const unbindAction = async (actionId: string) => {
    const next = { ...overrides, [actionId]: UNBOUND_SENTINEL }
    void controller.persist({ bindings: next, disabled: localDisabled, hostDirectExecute: localHostDirectExecute }).catch(() => {})
    controller.scope.set(actionId, UNBOUND_SENTINEL).catch(() => {})
    setLocalOverrides(next)
    controller.reload(next, localDisabled, localHostDirectExecute)
  }

  const toggleEnabled = async (actionId: string) => {
    const disabled = new Set(localDisabled)
    if (disabled.has(actionId)) disabled.delete(actionId)
    else disabled.add(actionId)
    setLocalDisabled(disabled)
    void controller.persist({ bindings: overrides, disabled, hostDirectExecute: localHostDirectExecute }).catch(() => {})
    controller.reload(overrides, disabled, localHostDirectExecute)
  }

  // W2.2 — overflow toggle offered only on input-less host command rows
  // (renderRow gates its render; buildHostActionDef re-enforces at dispatch
  // time regardless of what this persisted set claims for a has-input id).
  const toggleDirectExecute = async (actionId: string) => {
    const next = new Set(localHostDirectExecute)
    if (next.has(actionId)) next.delete(actionId)
    else next.add(actionId)
    setLocalHostDirectExecute(next)
    void controller.persist({ bindings: overrides, disabled: localDisabled, hostDirectExecute: next }).catch(() => {})
    controller.reload(overrides, localDisabled, next)
  }

  // W1.3 — orphaned overrides (design principle 3): the only mutation an
  // absent-provider row allows is deleting its own persisted footprint
  // (binding override + disabled flag, if any). Every other action's
  // entries are left byte-for-byte untouched.
  const removeOrphan = async (actionId: string) => {
    const next = { ...overrides }
    delete next[actionId]
    const disabled = new Set(localDisabled)
    disabled.delete(actionId)
    const hostDirectExecute = new Set(localHostDirectExecute)
    hostDirectExecute.delete(actionId)
    void controller.persist({ bindings: next, disabled, hostDirectExecute }).catch(() => {})
    controller.scope.unset(actionId).catch(() => {})
    setLocalOverrides(next)
    setLocalDisabled(disabled)
    setLocalHostDirectExecute(hostDirectExecute)
    controller.reload(next, disabled, hostDirectExecute)
  }

  const startRecording = (actionId: string) => {
    setRecordingId(actionId)
    setPendingChord(null)
    setPendingSpec('')
    setOverflowId(null)
  }

  const renderRow = (action: ActionDef) => {
    // W1.3: editing (record / clear / unbind / enable toggle) is gated to
    // EDITABLE_PROVIDERS — see that constant's comment. A foreign-provider
    // action still renders fully (label, id, binding, conflict/reserved
    // badges) — see design.md §4 缺席态/design principle 3 — it just cannot
    // be rebound from here yet.
    const editable = isProviderEditable(action.provider, controller.isThirdPartyProvider)
    const report = bindingReport(action.id, action.defaultChord, overrides, ownerOf(chordOwners, action.id), platform)
    const recording = editable && recordingId === action.id
    const pending = recording ? validateChordSpec(pendingSpec) : null
    const unbound = report.unbound === true
    const overflowOpen = editable && overflowId === action.id
    // W2.2: the direct-execute opt-in is offered ONLY on host-provider rows
    // whose command declares no `input` — a has-input command never gets
    // the toggle at all (not merely disabled), since direct-execute could
    // never carry the free-form argument the command needs. This is UI
    // gating only; buildHostActionDef (host-commands.ts) independently
    // re-checks the live descriptor at dispatch time, so a stale/hostile
    // persisted opt-in for a has-input id can never take effect even if
    // this condition were ever wrong.
    const showDirectExecuteToggle = editable && action.provider === HOST_PROVIDER && action.hasInput !== true
    // GA-012: the chord button itself is the record entry. Its label is the
    // live chord display (or the recording hint / unbound state).
    const chordButtonLabel = recording
      ? (pendingChord !== null ? formatChord(pendingChord, platform) : t('shortcuts.recording'))
      : unbound
        ? t('shortcuts.unbound')
        : (report.display || t('shortcuts.unbound'))
    return (
      <div
        key={action.id}
        data-dsh-nux-shortcut-row={action.id}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l2, #e6e7e9)' }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-primary)' }}>{t(action.label)}</div>
          <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{action.id}</div>
          {/* GA-013: conflict / reserved warnings are secondary info under the label. */}
          {report.conflictWith !== null && (
            <div data-dsh-nux-conflict={action.id} style={{ fontSize: 11, color: 'var(--dsw-alias-state-error, #d24c4c)' }}>
              {t('shortcuts.conflict', { id: report.conflictWith })}
            </div>
          )}
          {report.browserReservedNote !== null && (
            <div style={{ fontSize: 11, color: 'var(--dsw-alias-state-warn, #b76e00)' }}>
              {t(report.browserReservedNote)}
            </div>
          )}
          {recording && pending !== null && pending.chord === null && (
            <div style={{ fontSize: 11, color: 'var(--dsw-alias-state-error, #d24c4c)' }}>{t('shortcuts.invalid')}</div>
          )}
        </div>

        {/* GA-012: glass chord button = record entry. W1.3: non-editable
            (foreign-provider) rows render the same button, disabled and
            inert — the binding is still visible, just not changeable here. */}
        <button
          type="button"
          data-dsh-nux-chord={action.id}
          data-dsh-nux-chord-button
          disabled={!editable}
          aria-pressed={recording}
          aria-label={recording ? t('shortcuts.recording') : (chordButtonLabel + ' — ' + t('shortcuts.recordHint'))}
          onClick={editable ? () => (recording ? cancelRecording() : startRecording(action.id)) : undefined}
          style={{
            ...CHORD_BTN_BASE,
            color: unbound && !recording ? 'var(--dsw-alias-label-tertiary)' : undefined,
            opacity: editable ? 1 : 0.55,
            cursor: editable ? 'pointer' : 'default',
            ...(recording
              ? { borderColor: 'rgba(138,166,255,.85)', background: 'rgba(237,242,255,.74)', color: '#3559b7' }
              : null),
          }}
        >
          {chordButtonLabel}
        </button>

        {recording && pendingChord !== null && pending?.chord !== null && (
          <button type="button" onClick={() => void saveRecording(action.id)}>{t('shortcuts.save')}</button>
        )}

        {/* GA-013: overflow menu holds enabled / clear / unbind / reset.
            W1.3: absent for non-editable (foreign-provider) rows — no
            mutation is offered there at all. */}
        {editable && (
        <div data-dsh-nux-overflow-root style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            data-dsh-nux-overflow={action.id}
            aria-expanded={overflowOpen}
            aria-label={t('shortcuts.more')}
            onClick={() => setOverflowId(overflowOpen ? null : action.id)}
            style={{ fontSize: 14, padding: '4px 8px', color: 'var(--dsw-alias-label-tertiary)', border: 'none', background: 'transparent', cursor: 'pointer' }}
          >
            ⋯
          </button>
          {overflowOpen && (
            <div
              role="menu"
              data-dsh-nux-overflow-menu={action.id}
              style={{
                position: 'absolute', right: 0, top: '100%', zIndex: 10, minWidth: 132,
                background: 'var(--dsw-alias-bg-layer-2, #fff)', border: '1px solid var(--dsw-alias-border-l2, #e6e7e9)',
                borderRadius: 10, boxShadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(10,17,28,.10))', padding: 4,
              }}
            >
              <label
                data-dsh-nux-overflow-enabled={action.id}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', fontSize: 12, cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={!localDisabled.has(action.id)}
                  onChange={() => void toggleEnabled(action.id)}
                  aria-label={t('shortcuts.enabled')}
                />
                {t('shortcuts.enabled')}
              </label>
              {showDirectExecuteToggle && (
                <label
                  data-dsh-nux-overflow-direct-execute={action.id}
                  style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '6px 8px', fontSize: 12, cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={localHostDirectExecute.has(action.id)}
                    onChange={() => void toggleDirectExecute(action.id)}
                    aria-label={t('shortcuts.host.directExecute')}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    {t('shortcuts.host.directExecute')}
                    <div style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', fontWeight: 400 }}>
                      {t('shortcuts.host.directExecute.description')}
                    </div>
                  </span>
                </label>
              )}
              <button
                type="button"
                role="menuitem"
                data-dsh-nux-unbind={action.id}
                disabled={overrides[action.id] === undefined || overrides[action.id] === ''}
                onClick={() => { void unbindAction(action.id); setOverflowId(null) }}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', fontSize: 12, border: 'none', background: 'transparent', cursor: 'pointer' }}
              >
                {t('shortcuts.clear')}
              </button>
              <button
                type="button"
                role="menuitem"
                data-dsh-nux-reset={action.id}
                disabled={overrides[action.id] === undefined}
                onClick={() => { void clearBinding(action.id); setOverflowId(null) }}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', fontSize: 12, border: 'none', background: 'transparent', cursor: 'pointer' }}
              >
                {t('shortcuts.reset')}
              </button>
            </div>
          )}
        </div>
        )}
      </div>
    )
  }

  // W1.3 — orphaned overrides row: a persisted binding whose action id
  // matches nothing in the live registry. Grayed out, raw id only (we have
  // no label — the provider that would supply one is not loaded), and the
  // only control is "remove" (delete this action's persisted footprint).
  const renderOrphanRow = ([actionId, spec]: [string, string]) => {
    const display = spec === UNBOUND_SENTINEL
      ? t('shortcuts.unbound')
      : (() => {
          const parsed = parseChord(spec)
          return parsed !== null ? formatChord(parsed, platform) : spec
        })()
    return (
      <div
        key={actionId}
        data-dsh-nux-orphan-row={actionId}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l2, #e6e7e9)', opacity: 0.55 }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-primary)' }}>{actionId}</div>
          <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{t('shortcuts.orphaned.providerNotLoaded')}</div>
        </div>
        <div style={{ minWidth: 138, padding: '8px 12px', fontSize: 13, textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)' }}>
          {display}
        </div>
        <button
          type="button"
          data-dsh-nux-orphan-remove={actionId}
          onClick={() => void removeOrphan(actionId)}
          style={{ fontSize: 12, padding: '4px 8px', color: 'var(--dsw-alias-state-error, #d24c4c)', border: 'none', background: 'transparent', cursor: 'pointer' }}
        >
          {t('shortcuts.orphaned.remove')}
        </button>
      </div>
    )
  }

  // W1.3 — one collapsible section per provider (design.md §4). Skips a
  // provider entirely once search filters every one of its rows out, so an
  // active query never leaves an empty header on screen.
  const renderProviderGroup = (providerId: string) => {
    const isWorkbench = providerId === DEFAULT_PROVIDER
    const groupActions = isWorkbench ? workbenchActions : (byProvider.get(providerId) ?? [])
    const visibleNavigation = isWorkbench ? navigationActions.filter(isVisible) : []
    const visibleFavorites = isWorkbench ? favoriteActions.filter(isVisible) : []
    const visibleForeign = isWorkbench ? [] : groupActions.filter(isVisible)
    const visibleCount = visibleNavigation.length + visibleFavorites.length + visibleForeign.length
    if (visibleCount === 0) return null
    // nit: two read-only overrides of the user's own collapse toggle
    // (collapsedProviders), neither of which mutates that state:
    //  - a group must never collapse out from under a row that is actively
    //    recording — the chord-capture UI (and its Save button) has to stay
    //    reachable while a capture is in progress.
    //  - while a search query is active, a group is never left collapsed
    //    behind a bare header when it has visible matches (guaranteed here,
    //    since visibleCount === 0 already returned above) — a collapsed
    //    header reads as "no matches" even though there are some.
    // Once recording ends / the query clears, the user's own toggle choice
    // is exactly what renders again.
    const collapseOverrideActive = query !== '' || groupActions.some((a) => a.id === recordingId)
    const collapsed = collapsedProviders.has(providerId) && !collapseOverrideActive
    return (
      <div key={providerId} data-dsh-nux-group={providerId} style={{ marginBottom: 8 }}>
        <button
          type="button"
          data-dsh-nux-group-header={providerId}
          aria-expanded={!collapsed}
          // nit: while an override above is forcing this group open, a click
          // here cannot change anything visible — the header already reads
          // expanded. Without this guard the click would still flip
          // collapsedProviders underneath the override, so once the query
          // clears / recording ends the group would silently land in
          // whichever state that invisible click left it in, instead of the
          // state the user actually last chose. No-op the click instead.
          onClick={() => { if (!collapseOverrideActive) toggleGroupCollapsed(providerId) }}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
            fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', margin: '8px 0 4px',
            border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
          }}
        >
          <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
          {providerLabel(providerId)}
        </button>
        {!collapsed && (
          <>
            {visibleNavigation.length > 0 && (
              <>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: 4 }}>{t('shortcuts.group.navigation')}</div>
                {visibleNavigation.map(renderRow)}
              </>
            )}
            {visibleFavorites.length > 0 && (
              <>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', margin: '8px 0 4px' }}>{t('shortcuts.group.favorites')}</div>
                {visibleFavorites.map(renderRow)}
              </>
            )}
            {visibleForeign.map(renderRow)}
          </>
        )}
      </div>
    )
  }

  return (
    <div data-dsh-nux-smoke="shortcuts" style={{ padding: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 8 }}>{t('shortcuts.scopeNote')}</div>
      <input
        type="text"
        data-dsh-nux-search
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder={t('shortcuts.search.placeholder')}
        aria-label={t('shortcuts.search.placeholder')}
        style={{
          width: '100%', boxSizing: 'border-box', marginBottom: 8, padding: '6px 10px', fontSize: 13,
          borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2, #e6e7e9)', background: 'transparent',
        }}
      />
      {providerIds.map(renderProviderGroup)}
      {visibleOrphanedOverrides.length > 0 && (
        <div data-dsh-nux-orphaned-section style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 4 }}>
            {t('shortcuts.orphaned.section')}
          </div>
          {visibleOrphanedOverrides.map(renderOrphanRow)}
        </div>
      )}
    </div>
  )
}

function ownerOf(chordOwners: Map<string, string[]>, actionId: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const [chord, ids] of chordOwners) {
    if (ids.length <= 1) continue
    for (const id of ids) {
      if (id === actionId) {
        const other = ids.find((o) => o !== actionId)
        if (other !== undefined) out.set(chord, other)
      }
    }
  }
  return out
}

function chordKeyOf(chord: Chord): string {
  const mods: string[] = []
  if (chord.alt) mods.push('Alt')
  if (chord.primary) mods.push('Primary')
  if (chord.shift) mods.push('Shift')
  return mods.concat(chord.key).join('+')
}

function chordToSpec(chord: Chord): string {
  const parts: string[] = []
  if (chord.alt) parts.push('Alt')
  if (chord.primary) parts.push('Primary')
  if (chord.shift) parts.push('Shift')
  const key = chord.key === ' ' ? 'Space' : chord.key.length === 1 ? chord.key.toUpperCase() : chord.key
  parts.push(key)
  return parts.join('+')
}

/**
 * @returns the W3.1 third-party-actions handle this call created, so
 * src/client/index.tsx can expose its `.service` as the `ctx.workbenchActions`
 * cordis service (release-on-dispose is owned here, alongside
 * hostCommandsHandle — see the `ctx.on('dispose', ...)` call at the bottom).
 */
export function applyShortcuts(ctx: HarnessContext): ThirdPartyActionsHandle {
  const t = ctx.locale.bind(NS)
  const services = resolveHarnessServices(ctx)
  const scope = ctx.settingsScope.bind({ namespace: 'dsh-native-ux-shortcuts' })
  const persistence = new FallbackShortcutPersistence(
    new HostShortcutPersistence(scope),
    new LocalShortcutPersistence(),
    // Dev-only: the current rc does not expose this third-party namespace to
    // configuration clients, so shortcuts persist in localStorage. Surface it
    // once in the console (§9A.17 rule 6) without product UI.
    () =>
      warnOnce(
        'shortcut-persistence.local-fallback',
        'host settings namespace "dsh-native-ux-shortcuts" is not durable for this client (not exposed / memory mode); shortcut chords persist in localStorage',
      ),
  )
  // W2.1: resolves the remote commands face fail-soft (zero actions if
  // absent/malformed — see host-commands.ts's own doc comment); enumerates
  // for the focused agent and subscribes to commands/change (debounced).
  const hostCommandsHandle = createHostCommandsHandle(ctx, services)
  // W3.1: created (and disposed) here, alongside hostCommandsHandle — see
  // this function's own return-value doc comment above.
  const thirdPartyActionsHandle = createThirdPartyActionsHandle()
  let registry = buildShortcutRegistry({ services, hostCommandsHandle, thirdPartyActionsHandle })
  let detach = attachDispatcher(registry)
  // Last-known full state, threaded through every reload() call so a
  // commands/change-triggered resync (which does not itself carry
  // overrides/disabled/hostDirectExecute) can rebuild with the CURRENT
  // committed values instead of reverting them to defaults.
  let currentOverrides: BindingOverrides = {}
  let currentDisabled: ReadonlySet<string> = new Set()
  let currentHostDirectExecute: ReadonlySet<string> = new Set()
  const reload = (overrides: BindingOverrides, disabled?: ReadonlySet<string>, hostDirectExecute?: ReadonlySet<string>) => {
    currentOverrides = overrides
    if (disabled !== undefined) currentDisabled = disabled
    if (hostDirectExecute !== undefined) currentHostDirectExecute = hostDirectExecute
    detach()
    registry = buildShortcutRegistry({
      services,
      overrides,
      disabled: currentDisabled,
      hostCommandsHandle,
      hostDirectExecute: currentHostDirectExecute,
      thirdPartyActionsHandle,
    })
    detach = attachDispatcher(registry)
    controller.registry = registry
  }
  // Committed-state observers: the Settings UI and the registry both dispatch
  // from `controller.persisted` (host when durable, else the localStorage
  // fallback — the same state the dispatcher resolves). `persisted` is set
  // synchronously at the start of persist(), before the async store resolves,
  // so the display and the dispatcher can never disagree about what is bound.
  const stateListeners = new Set<() => void>()
  const emitState = () => { for (const fn of stateListeners) fn() }
  const controller: ShortcutSettingsController = {
    registry, scope, reload,
    isThirdPartyProvider: (provider) => thirdPartyActionsHandle.hasLiveProvider(provider),
    subscribeState: (fn) => { stateListeners.add(fn); return () => { stateListeners.delete(fn) } },
    persist: (state) => {
      // Falls back to whatever is already committed when this call omits
      // hostDirectExecute (every pre-W2 call site does) — never silently
      // wipes a previously-saved opt-in just because a binding/disabled
      // change did not mention it. Note: a persist() call that races
      // hydration (fired before controller.persisted is ever set) still
      // falls through to `new Set()` here, the same pre-hydration window
      // `disabled` (and `bindings`) have always had — this is parity with
      // existing, pre-W2 behavior, not a new risk hostDirectExecute
      // introduces.
      const hostDirectExecute = state.hostDirectExecute ?? controller.persisted?.hostDirectExecute ?? new Set<string>()
      controller.persisted = { bindings: { ...state.bindings }, disabled: new Set(state.disabled), hostDirectExecute: new Set(hostDirectExecute) }
      emitState()
      return persistence.save({
        schemaVersion: 1,
        bindings: state.bindings,
        disabled: Array.from(state.disabled),
        hostDirectExecute: Array.from(hostDirectExecute),
      })
    },
  }
  // GA-003/022: hydrate persisted bindings/disabled/hostDirectExecute (host
  // first, local fallback) into the live registry + controller state on
  // startup. A hydration failure never blocks the dispatcher (defaults stay
  // active).
  void persistence.load().then((state) => {
    controller.persisted = { bindings: state.bindings, disabled: new Set(state.disabled), hostDirectExecute: new Set(state.hostDirectExecute) }
    if (Object.keys(state.bindings).length > 0 || state.disabled.length > 0 || state.hostDirectExecute.length > 0) {
      controller.reload(state.bindings, new Set(state.disabled), new Set(state.hostDirectExecute))
    }
    emitState()
  }).catch(() => {})
  // W2.1: re-sync whenever the host command catalog actually changes
  // (initial async enumeration counts as one such change, same as a later
  // commands/change or focus-change resync) — rebuilds the registry with
  // the CURRENT committed overrides/disabled/hostDirectExecute so an
  // unrelated catalog change never reverts a pending settings change. Not
  // captured for later unsubscription: hostCommandsHandle.dispose() below
  // is self-sufficient (it clears every onChange listener itself — SF3),
  // so there is no ordering requirement between the two calls.
  hostCommandsHandle.onChange(() => {
    reload(currentOverrides, currentDisabled, currentHostDirectExecute)
  })
  // W3.1: same reasoning as hostCommandsHandle.onChange above — a
  // third-party register()/dispose() is an external change outside the
  // settings-mutation flow, so it goes through the same reload path (a full
  // registry rebuild, which is also what makes the new/removed action
  // actually appear/disappear in the Settings UI's next render).
  thirdPartyActionsHandle.onChange(() => {
    reload(currentOverrides, currentDisabled, currentHostDirectExecute)
  })
  // Finding 2 (smoke test): a build-time-evaluated label (a third-party's
  // `toActionDef` snapshot, or a foreign/L3 provider poked into a registry
  // some other way) goes stale on a global language switch until something
  // rebuilds the registry — Workbench's own dictionary-key labels are exempt
  // (t() re-evaluates them at render, see renderRow), but nothing previously
  // drove a rebuild on a locale switch itself. `locale/change` (see
  // HarnessContext.on's doc comment, harness-adapter.ts, for the verified
  // citation) is exactly that "language changed" signal — subscribing here
  // and reusing the same debounced-reload shape as hostCommandsHandle.
  // onChange (microtaskCoalesce, imported from host-commands.ts) means a
  // registry rebuild — the same rebuild ACTIONS_API.md's "When label() is
  // called" already documents as re-evaluating every function-label — now
  // also runs on a language switch, not only on a settings/catalog change.
  const localeChangeResync = microtaskCoalesce(() => {
    reload(currentOverrides, currentDisabled, currentHostDirectExecute)
  })
  const localeChangeUnsub = ctx.on('locale/change', localeChangeResync)
  // LOW 3 (Opus review, round 2): HarnessContext.on('locale/change', ...)'s
  // return type is `(() => void) | undefined` (see its doc comment,
  // harness-adapter.ts) precisely because a test double built from a plain
  // `vi.fn()` resolves to `undefined` at runtime even though real cordis
  // always returns a disposer — this typeof check is a genuinely reachable
  // branch under that type, not dead code papering over a lie.
  const offLocaleChange = typeof localeChangeUnsub === 'function' ? localeChangeUnsub : () => {}
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'shortcuts',
        order: 50,
        label: () => t('shortcuts.nav'),
        inject: () => ({ t, controller }),
      },
      SettingsSection,
    ),
  )
  // Late-bound detach: reload replaces the listener, dispose must remove
  // whatever is currently attached (PRD §16: no duplicate listeners).
  ctx.on('dispose', () => {
    detach()
    hostCommandsHandle.dispose()
    thirdPartyActionsHandle.dispose()
    offLocaleChange()
  })
  return thirdPartyActionsHandle
}
