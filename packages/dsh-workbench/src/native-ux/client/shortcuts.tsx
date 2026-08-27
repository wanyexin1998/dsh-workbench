// T7+T8 — App Shortcuts: Action Registry + keydown dispatcher + native
// Settings → Shortcuts section with recording, browser-reserved warnings,
// conflict handling, enabled toggles, and best-effort Host-backed persistence.
// GA-012/013: the glass chord button is the record entry; advanced controls
// (enabled / clear / unbind) live in a per-row overflow menu.
// GA-023: capability-aware registration — an action whose capability is
// missing is not registered (absent from Settings, binds no chord).
import * as React from 'react'
import { ActionRegistry, type ActionDef } from '../core/action-registry.js'
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
import { resolveHarnessServices, type HarnessContext, type HarnessServices, type SettingsScopeFace } from './harness-adapter.js'

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

/** Adapter (temporary, tracked in issue #1 proposal 4): no public composer
 * focus API exists in the harness rc — locate the composer input via DOM.
 * Defensive: `presentation` is a host-provided (protocol 2) face; its
 * `state`/`getSnapshot` shape is asserted by HarnessServices but not
 * guaranteed at runtime. The split-pane guard fails closed by *leaving
 * shortcuts registered* on a bad presentation face (by design), so this
 * accessor must degrade to "no focused session" on a malformed or
 * throwing `state`/`getSnapshot` rather than throw inside the keydown
 * handler. An uncaught throw here would *not* "take shortcuts down" —
 * the dispatcher already calls event.preventDefault() before action.run()
 * (see attachDispatcher, shortcuts.tsx:251-252) — it would just swallow
 * that one chord and make the action silently fail. Narrowed via
 * `unknown` once, here, rather than trusting the static type of a value
 * that ultimately came from `ctx.get()`. */
function focusedSessionId(services: HarnessServices): string | undefined {
  const state: unknown = services.sessions?.presentation?.state
  if (typeof state !== 'object' || state === null) return undefined
  const getSnapshot = (state as { getSnapshot?: unknown }).getSnapshot
  if (typeof getSnapshot !== 'function') return undefined
  let snapshot: unknown
  try {
    snapshot = getSnapshot.call(state)
  } catch {
    return undefined
  }
  return typeof snapshot === 'object' && snapshot !== null ? (snapshot as { focused?: string }).focused : undefined
}

function focusedPane(services: HarnessServices): ParentNode {
  const focused = focusedSessionId(services)
  if (focused === undefined) return document
  for (const pane of Array.from(document.querySelectorAll<HTMLElement>('[data-session-pane]'))) {
    if (pane.dataset.sessionPane === focused) return pane
  }
  return document
}

function focusComposer(services: HarnessServices): void {
  const seat = focusedPane(services).querySelector('[data-composer-seat]')
  const target = seat?.querySelector(
    'textarea, input[type="text"], [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
  )
  if (target instanceof HTMLElement) target.focus()
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
const EDITABLE_ALLOWED_ACTIONS = new Set(['workbench.conversation.navigator.toggle'])

/** Accept native user input in production; Vitest uses synthetic DOM events. */
export function isTrustedShortcutEvent(
  event: Pick<KeyboardEvent, 'isTrusted'>,
  allowSyntheticEventsForTesting = false,
): boolean {
  return event.isTrusted || allowSyntheticEventsForTesting
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
    if (isEditableEvent(event) && !EDITABLE_ALLOWED_ACTIONS.has(action.id)) return
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
  reload(overrides: BindingOverrides, disabled?: ReadonlySet<string>): void
  /** GA-003/022: persist the full shortcut state (host-first, local fallback). */
  persist(state: { bindings: BindingOverrides; disabled: ReadonlySet<string> }): Promise<'host' | 'local'>
  /** Committed state: the same state the registry dispatches from (host if
   * durable, else the localStorage fallback). Set at hydration and on every
   * save/clear/unbind/toggle. */
  persisted?: { bindings: BindingOverrides; disabled: ReadonlySet<string> }
  /** Observe committed-state changes (hydration is async). Optional: test
   * controllers may omit it. */
  subscribeState?(fn: () => void): () => void
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
  const [localDisabled, setLocalDisabled] = React.useState<ReadonlySet<string>>(new Set())

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
  const navigationActions = actions.filter((a) => !a.id.startsWith('workbench.agent.favorite'))
  const favoriteActions = actions.filter((a) => a.id.startsWith('workbench.agent.favorite'))
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
    void controller.persist({ bindings: next, disabled: localDisabled }).catch(() => {})
    controller.scope.set(actionId, pendingSpec).catch(() => {})
    for (const [id, spec] of Object.entries(next)) {
      if (id !== actionId) controller.scope.set(id, spec).catch(() => {})
    }
    setLocalOverrides(next)
    controller.reload(next, localDisabled)
    cancelRecording()
  }

  const clearBinding = async (actionId: string) => {
    const next = { ...overrides }
    delete next[actionId]
    void controller.persist({ bindings: next, disabled: localDisabled }).catch(() => {})
    controller.scope.unset(actionId).catch(() => {})
    setLocalOverrides(next)
    controller.reload(next, localDisabled)
  }

  const unbindAction = async (actionId: string) => {
    const next = { ...overrides, [actionId]: UNBOUND_SENTINEL }
    void controller.persist({ bindings: next, disabled: localDisabled }).catch(() => {})
    controller.scope.set(actionId, UNBOUND_SENTINEL).catch(() => {})
    setLocalOverrides(next)
    controller.reload(next, localDisabled)
  }

  const toggleEnabled = async (actionId: string) => {
    const disabled = new Set(localDisabled)
    if (disabled.has(actionId)) disabled.delete(actionId)
    else disabled.add(actionId)
    setLocalDisabled(disabled)
    void controller.persist({ bindings: overrides, disabled }).catch(() => {})
    controller.reload(overrides, disabled)
  }

  const startRecording = (actionId: string) => {
    setRecordingId(actionId)
    setPendingChord(null)
    setPendingSpec('')
    setOverflowId(null)
  }

  const renderRow = (action: ActionDef) => {
    const report = bindingReport(action.id, action.defaultChord, overrides, ownerOf(chordOwners, action.id), platform)
    const recording = recordingId === action.id
    const pending = recording ? validateChordSpec(pendingSpec) : null
    const unbound = report.unbound === true
    const overflowOpen = overflowId === action.id
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

        {/* GA-012: glass chord button = record entry. */}
        <button
          type="button"
          data-dsh-nux-chord={action.id}
          data-dsh-nux-chord-button
          aria-pressed={recording}
          aria-label={recording ? t('shortcuts.recording') : (chordButtonLabel + ' — ' + t('shortcuts.recordHint'))}
          onClick={() => (recording ? cancelRecording() : startRecording(action.id))}
          style={{
            ...CHORD_BTN_BASE,
            color: unbound && !recording ? 'var(--dsw-alias-label-tertiary)' : undefined,
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

        {/* GA-013: overflow menu holds enabled / clear / unbind / reset. */}
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
      </div>
    )
  }

  return (
    <div data-dsh-nux-smoke="shortcuts" style={{ padding: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 8 }}>{t('shortcuts.scopeNote')}</div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: 4 }}>{t('shortcuts.group.navigation')}</div>
      {navigationActions.map(renderRow)}
      {favoriteActions.length > 0 && (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', margin: '8px 0 4px' }}>{t('shortcuts.group.favorites')}</div>
          {favoriteActions.map(renderRow)}
        </>
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

export function applyShortcuts(ctx: HarnessContext) {
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
  let registry = buildShortcutRegistry({ services })
  let detach = attachDispatcher(registry)
  const reload = (overrides: BindingOverrides, disabled?: ReadonlySet<string>) => {
    detach()
    registry = buildShortcutRegistry({ services, overrides, disabled })
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
    subscribeState: (fn) => { stateListeners.add(fn); return () => { stateListeners.delete(fn) } },
    persist: (state) => {
      controller.persisted = { bindings: { ...state.bindings }, disabled: new Set(state.disabled) }
      emitState()
      return persistence.save({
        schemaVersion: 1,
        bindings: state.bindings,
        disabled: Array.from(state.disabled),
      })
    },
  }
  // GA-003/022: hydrate persisted bindings/disabled (host first, local
  // fallback) into the live registry + controller state on startup. A
  // hydration failure never blocks the dispatcher (defaults stay active).
  void persistence.load().then((state) => {
    controller.persisted = { bindings: state.bindings, disabled: new Set(state.disabled) }
    if (Object.keys(state.bindings).length > 0 || state.disabled.length > 0) {
      controller.reload(state.bindings, new Set(state.disabled))
    }
    emitState()
  }).catch(() => {})
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
  ctx.on('dispose', () => detach())
}
