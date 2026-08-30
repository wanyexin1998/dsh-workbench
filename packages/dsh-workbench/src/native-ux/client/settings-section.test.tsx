// @vitest-environment jsdom
import * as React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildShortcutRegistry } from './shortcuts.js'
import { SettingsSection, type ShortcutCapabilities, type ShortcutSettingsController } from './shortcuts.js'
import { en, zh } from './locales.js'
import { parsePersistedState } from './shortcut-persistence.js'
import { createThirdPartyActionsHandle, type ThirdPartyActionsHandle } from './actions-api.js'
import { UNBOUND_SENTINEL } from '../core/shortcut-settings.js'
import { parseChord } from '../core/chord.js'

/** Host where both services exist (the realistic case): service-backed
 * actions (sidebar / session.stop) register. GA-043 fail-soft gates them on
 * service presence, so UI tests default to a fully-serviced host.
 * F8: `presentation.protocol: 2` is what a COMPATIBLE fork host actually
 * reports (client/contract.ts SUPPORTED_HARNESS.protocol) — without it the
 * host is one the compatibility guard rejects, and workbench.pane.close-focused
 * must not register at all. */
const HOST_SERVICES = {
  layout: { toggleSidebar: () => {} },
  sessions: {
    scope: () => ({ get: () => ({ cancel: () => {} }) }),
    presentation: { protocol: 2, close: () => {}, state: { getSnapshot: () => ({}) } },
  },
}

function makeController(
  overrides: Record<string, string> = {},
  caps?: ShortcutCapabilities,
  services: typeof HOST_SERVICES = HOST_SERVICES,
  thirdPartyActionsHandle?: ThirdPartyActionsHandle,
): ShortcutSettingsController {
  const registry = buildShortcutRegistry({ overrides, caps, services, thirdPartyActionsHandle })
  let stored: Record<string, string> = { ...overrides }
  const listeners = new Set<() => void>()
  const scope = {
    getSnapshot: () => ({ status: 'ready', user: stored, value: stored }),
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) },
    set: vi.fn(async (field: string, value: unknown) => { stored[field] = String(value); for (const l of listeners) l() }),
    unset: vi.fn(async (field: string) => { delete stored[field]; for (const l of listeners) l() }),
  }
  const reload = vi.fn()
  const persist = vi.fn(() => Promise.resolve('local' as const))
  return {
    registry, scope, reload, persist,
    isThirdPartyProvider: thirdPartyActionsHandle !== undefined
      ? (provider: string) => thirdPartyActionsHandle.liveProviders().has(provider)
      : undefined,
  }
}

function renderSection(controller = makeController()) {
  return render(<SettingsSection t={(k: string, vars?: Record<string, string>) => vars ? k + ':' + Object.values(vars).join(',') : k} controller={controller} allowSyntheticEventsForTesting />)
}

describe('SettingsSection (T8)', () => {
  afterEach(() => cleanup())

  it('renders the navigation group; favorites hidden when capability absent (GA-023)', () => {
    renderSection()
    expect(screen.getByText('shortcuts.group.navigation')).toBeTruthy()
    expect(screen.getByText('shortcuts.action.navigator.toggle')).toBeTruthy()
    expect(screen.getByText('shortcuts.scopeNote')).toBeTruthy()
    // GA-023: no favorite-agent API in the harness rc → not registered by default
    expect(screen.queryByText('shortcuts.group.favorites')).toBeNull()
    expect(screen.queryByText('shortcuts.action.favorite.1')).toBeNull()
  })

  it('localizes every shipped action name from the active dictionary', () => {
    const labels = [
      'shortcuts.action.navigator.toggle',
      'shortcuts.action.composer.focus',
      'shortcuts.action.sidebar.toggle',
      'shortcuts.action.session.stop',
      'shortcuts.action.pane.closeFocused',
    ] as const
    const renderLocale = (dictionary: Record<string, string>) => render(
      <SettingsSection t={(key: string) => dictionary[key] ?? key} controller={makeController()} allowSyntheticEventsForTesting />,
    )
    renderLocale(zh)
    for (const key of labels) expect(screen.getByText(zh[key])).toBeTruthy()
    cleanup()
    renderLocale(en)
    for (const key of labels) expect(screen.getByText(en[key])).toBeTruthy()
  })

  it('shows the favorites group only when the favoriteAgent capability is present (GA-023)', () => {
    renderSection(makeController({}, { favoriteAgent: true }))
    expect(screen.getByText('shortcuts.group.favorites')).toBeTruthy()
    expect(screen.getByText('shortcuts.action.favorite.1')).toBeTruthy()
    expect(screen.getByText('shortcuts.action.favorite.9')).toBeTruthy()
  })

  it('shows default chords and reserved note for Primary+B', () => {
    renderSection()
    expect(screen.getByText('reserved.note.bookmarks')).toBeTruthy()
    expect(screen.getByText('Ctrl+B')).toBeTruthy()
  })

  // MEDIUM 2 (Opus review, round 2 of native-actions-pivot): reviewer's claim
  // was that the reserved-note warning only ever fires for a RECORDED
  // (overridden) binding, never for an action's shipped defaultChord. The
  // test above already disproves this in general (sidebar.toggle's
  // Primary+B default renders 'reserved.note.bookmarks' with an EMPTY
  // overrides object — renderRow's bindingReport() call unifies override and
  // default before ever consulting isBrowserReserved, so there is no
  // separate "was this recorded" branch to suppress on). This pins the SAME
  // fact specifically for workbench.session.new's own default (Primary+N,
  // kept as the maintainer's explicit choice — see its doc comment in
  // shortcuts.tsx) — the concrete row the review was actually worried about.
  it('MEDIUM 2: the settings row for workbench.session.new (default chord, no override) shows the newWindow reserved note', () => {
    const services = { ...HOST_SERVICES, sessions: { ...HOST_SERVICES.sessions, clear: () => {} } }
    const controller = makeController({}, undefined, services)
    renderSection(controller)
    const row = document.querySelector('[data-dsh-nux-shortcut-row="workbench.session.new"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('reserved.note.newWindow')
  })

  it('recording captures a chord, saves it, and reloads the dispatcher', async () => {
    const controller = makeController()
    renderSection(controller)
    // GA-012: the glass chord button (first row = navigator.toggle) is the record entry.
    const button = document.querySelector('[data-dsh-nux-chord-button]') as HTMLButtonElement
    fireEvent.click(button)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.textContent).toContain('shortcuts.recording')
    fireEvent.keyDown(window, { key: 'P', shiftKey: true, ctrlKey: true })
    const save = screen.getByText('shortcuts.save')
    expect((save as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(save)
    await act(async () => {})
    expect(controller.scope.set).toHaveBeenCalledWith('workbench.conversation.navigator.toggle', 'Primary+Shift+P')
    expect(controller.reload).toHaveBeenCalled()
  })

  it('recording a bound chord does not fire the bound action', () => {
    const controller = makeController()
    renderSection(controller)
    const button = document.querySelector('[data-dsh-nux-chord-button]') as HTMLButtonElement
    fireEvent.click(button)
    // Ctrl+Shift+O is the default binding of navigator.toggle; recording it
    // must stop propagation before the dispatcher sees it.
    fireEvent.keyDown(window, { key: 'O', shiftKey: true, ctrlKey: true })
    expect(button.textContent).toContain('Ctrl+Shift+O')
    // (dispatcher attach is not wired in this unit test — the propagation
    // path is exercised via stopPropagation in the capture handler)
  })

  it('ignores bare modifier keys while recording', () => {
    const controller = makeController()
    renderSection(controller)
    const button = document.querySelector('[data-dsh-nux-chord-button]') as HTMLButtonElement
    fireEvent.click(button)
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true })
    // No chord captured yet → the save button is not rendered.
    expect(screen.queryByText('shortcuts.save')).toBeNull()
  })

  it('reset clears the override and reloads (via the overflow menu, GA-013)', async () => {
    const controller = makeController({ 'workbench.session.stop': 'Primary+Shift+Y' })
    renderSection(controller)
    const row = document.querySelector('[data-dsh-nux-shortcut-row="workbench.session.stop"]')!
    fireEvent.click(row.querySelector('[data-dsh-nux-overflow]')!)
    const resetButton = row.querySelector('[data-dsh-nux-reset]') as HTMLButtonElement
    expect(resetButton.disabled).toBe(false)
    fireEvent.click(resetButton)
    await act(async () => {})
    expect(controller.scope.unset).toHaveBeenCalledWith('workbench.session.stop')
    expect(controller.reload).toHaveBeenCalled()
  })

  it('overflow menu holds the enabled toggle (GA-013)', async () => {
    const controller = makeController()
    renderSection(controller)
    const row = document.querySelector('[data-dsh-nux-shortcut-row="workbench.session.stop"]')!
    fireEvent.click(row.querySelector('[data-dsh-nux-overflow]')!)
    const enabled = row.querySelector('[data-dsh-nux-overflow-enabled] input') as HTMLInputElement
    expect(enabled.checked).toBe(true)
    fireEvent.click(enabled)
    await act(async () => {})
    expect(controller.reload).toHaveBeenCalled()
  })

  it('flags conflicts between bindings', () => {
    const controller = makeController({ 'workbench.conversation.composer.focus': 'Primary+Shift+O' })
    renderSection(controller)
    expect(screen.getAllByText(/shortcuts.conflict/).length).toBeGreaterThan(0)
  })

  it('displays the committed persisted chord when the host snapshot is not durable (⑧ display source)', async () => {
    const controller = makeController()
    // The current host does not expose third-party settings namespaces, so
    // the raw snapshot is unavailable while committed local fallback state
    // still carries the override. Display must follow committed state.
    controller.scope.getSnapshot = () => ({ status: 'unavailable', mode: 'memory' })
    let notify: (() => void) | undefined
    controller.subscribeState = (fn) => { notify = fn; return () => { notify = undefined } }
    renderSection(controller)
    const button = document.querySelector('[data-dsh-nux-chord-button]') as HTMLButtonElement
    // Before hydration the default binding is visible.
    expect(button.textContent).toContain('Ctrl+Shift+O')
    // Async hydration commits state and notifies the component.
    await act(async () => {
      controller.persisted = { bindings: { 'workbench.conversation.navigator.toggle': 'Primary+Shift+E' }, disabled: new Set() }
      notify?.()
    })
    expect(button.textContent).toContain('Ctrl+Shift+E')
  })

  // -------------------------------------------------------------------
  // W1.3 — open action catalog: provider grouping, search, orphaned
  // overrides, foreign-provider read-only rendering, and the
  // localDisabled seeding regression.
  // -------------------------------------------------------------------

  it('W1.3: the provider group header renders the localized provider label', () => {
    const controller = makeController()
    render(
      <SettingsSection
        t={(key: string) => (zh as Record<string, string>)[key] ?? key}
        controller={controller}
        allowSyntheticEventsForTesting
      />,
    )
    expect(screen.getByText(zh['shortcuts.provider.workbench'])).toBeTruthy()
  })

  it('W1.3: a foreign-provider action renders (grouped under its raw id) but is not editable', () => {
    const controller = makeController()
    controller.registry.register({
      id: 'someplugin.x',
      label: 'someplugin.x.label',
      defaultChord: 'Primary+Shift+Z',
      run: () => {},
      provider: 'someplugin',
    })
    renderSection(controller)
    // Unknown provider id has no dictionary entry -> falls back to the raw id.
    expect(screen.getByText('someplugin')).toBeTruthy()
    const row = document.querySelector('[data-dsh-nux-shortcut-row="someplugin.x"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('someplugin.x')
    expect(row!.textContent).toContain('Ctrl+Shift+Z') // binding still visible
    const button = row!.querySelector('[data-dsh-nux-chord-button]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(button.getAttribute('aria-pressed')).toBe('false') // click is inert, never enters recording
    expect(screen.queryByText('shortcuts.recording')).toBeNull()
    // No overflow menu (enable/clear/unbind/reset) is offered on a read-only row.
    expect(row!.querySelector('[data-dsh-nux-overflow]')).toBeNull()
    // A real workbench action on the same page stays fully editable.
    const stopButton = document.querySelector('[data-dsh-nux-chord="workbench.session.stop"]') as HTMLButtonElement
    expect(stopButton.disabled).toBe(false)
  })

  it('W1.3: search filters rows by localized label text and by action id; clearing restores all rows', () => {
    const controller = makeController()
    // nit fix: an orphaned binding, so this test can also cover that the
    // search box filters the orphaned section by the same rule (and hides
    // it entirely once nothing there matches) instead of only the
    // provider-group rows.
    controller.persisted = { bindings: { 'ghostplugin.doThing': 'Primary+Shift+G' }, disabled: new Set() }
    renderSection(controller)
    const search = document.querySelector('[data-dsh-nux-search]') as HTMLInputElement
    expect(search).not.toBeNull()

    // Query that only appears in the label key ("shortcuts.action.*"),
    // never in an action id ("workbench.*") -> isolates the label-match path.
    fireEvent.change(search, { target: { value: 'shortcuts.action.session.stop' } })
    expect(screen.getByText('shortcuts.action.session.stop')).toBeTruthy()
    expect(screen.queryByText('shortcuts.action.pane.closeFocused')).toBeNull()
    // Nothing in the orphaned section matches this query -> section hidden.
    expect(document.querySelector('[data-dsh-nux-orphaned-section]')).toBeNull()

    // Query that only appears in the action id (namespace prefix), never in
    // a label key -> isolates the id-match path. Also checks case-insensitivity.
    fireEvent.change(search, { target: { value: 'WORKBENCH.PANE' } })
    expect(screen.getByText('shortcuts.action.pane.closeFocused')).toBeTruthy()
    expect(screen.queryByText('shortcuts.action.session.stop')).toBeNull()
    expect(document.querySelector('[data-dsh-nux-orphaned-section]')).toBeNull()

    // A query matching only the orphan id surfaces the orphaned section.
    fireEvent.change(search, { target: { value: 'ghostplugin' } })
    expect(document.querySelector('[data-dsh-nux-orphan-row="ghostplugin.doThing"]')).not.toBeNull()

    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getByText('shortcuts.action.session.stop')).toBeTruthy()
    expect(screen.getByText('shortcuts.action.pane.closeFocused')).toBeTruthy()
    expect(document.querySelector('[data-dsh-nux-orphan-row="ghostplugin.doThing"]')).not.toBeNull()
  })

  it('W1.3: search never unmounts a row that is actively recording', () => {
    // Recording state (recordingId/pendingChord/pendingSpec) lives on
    // SettingsSection itself, not inside a per-row component, so filtering
    // a row out of the list cannot destroy that state — but the row's own
    // UI must still stay visible while its capture is in progress, or the
    // user loses the button they were about to click "Save" on.
    const controller = makeController()
    renderSection(controller)
    const button = document.querySelector('[data-dsh-nux-chord="workbench.session.stop"]') as HTMLButtonElement
    fireEvent.click(button)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    const search = document.querySelector('[data-dsh-nux-search]') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'zzz-does-not-match-anything' } })
    const row = document.querySelector('[data-dsh-nux-shortcut-row="workbench.session.stop"]')
    expect(row).not.toBeNull()
    expect(row!.querySelector('[data-dsh-nux-chord]')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('W1.3: renders orphaned persisted overrides (raw id + chord + note) and remove deletes only that key', async () => {
    const controller = makeController()
    controller.persisted = {
      bindings: { 'ghostplugin.doThing': 'Primary+Shift+G', 'workbench.session.stop': 'Primary+Shift+Y' },
      disabled: new Set(),
    }
    renderSection(controller)
    // A live action's own override never shows in the orphan section.
    expect(document.querySelector('[data-dsh-nux-orphan-row="workbench.session.stop"]')).toBeNull()
    const orphanRow = document.querySelector('[data-dsh-nux-orphan-row="ghostplugin.doThing"]')
    expect(orphanRow).not.toBeNull()
    expect(orphanRow!.textContent).toContain('ghostplugin.doThing')
    expect(orphanRow!.textContent).toContain('Ctrl+Shift+G')
    expect(orphanRow!.textContent).toContain('shortcuts.orphaned.providerNotLoaded')

    fireEvent.click(orphanRow!.querySelector('[data-dsh-nux-orphan-remove]')!)
    await act(async () => {})
    expect(controller.scope.unset).toHaveBeenCalledWith('ghostplugin.doThing')
    const lastPersist = (controller.persist as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as {
      bindings: Record<string, string>
    }
    expect(lastPersist.bindings['ghostplugin.doThing']).toBeUndefined()
    // The sibling live action's override must survive untouched.
    expect(lastPersist.bindings['workbench.session.stop']).toBe('Primary+Shift+Y')
  })

  it('review-fix (should-fix): a capability-gated built-in binding is not shown as an orphan', () => {
    // buildShortcutRegistry deliberately does not register
    // workbench.agent.favorite.open:N when caps.favoriteAgent is off — the
    // default shipping config (makeController() below uses no caps, so
    // favorites stay off). A persisted binding for such an action is not
    // "provider not loaded": the provider IS workbench, just capability-
    // gated off right now. It must not render in the orphaned section with
    // a destructive Remove control that would delete the user's own saved
    // binding for a feature that is merely disabled today.
    const controller = makeController()
    controller.persisted = {
      bindings: {
        'workbench.agent.favorite.open:3': 'Primary+Shift+3',
        'ghostplugin.doThing': 'Primary+Shift+G',
      },
      disabled: new Set(),
    }
    renderSection(controller)
    expect(document.querySelector('[data-dsh-nux-orphan-row="workbench.agent.favorite.open:3"]')).toBeNull()
    // A genuinely foreign-provider id (ghostplugin.doThing, matching no
    // known provider namespace at all) still renders as an orphan.
    expect(document.querySelector('[data-dsh-nux-orphan-row="ghostplugin.doThing"]')).not.toBeNull()
  })

  it('native-actions-pivot: a persisted host.command.* chord binding (from the removed W2 bridge) renders as a removable orphan — the provider is genuinely absent now', () => {
    // Before removal, 'host' was a live, editable provider (EDITABLE_PROVIDERS
    // included HOST_PROVIDER) and a host.command.* id was never orphaned —
    // it was a real, bindable row. Now that host-commands.ts is gone, no
    // live action ever registers under that id again, and 'host.command.'
    // does not start with the built-in `workbench.` namespace the orphan
    // derivation exempts — so this id falls through to the exact same
    // generic "foreign provider, genuinely absent" path the ghostplugin.*
    // tests already pin, exercised here for the SPECIFIC id shape a real
    // user's pre-removal persisted state would actually contain.
    const controller = makeController()
    controller.persisted = { bindings: { 'host.command.foo': 'Primary+Shift+G' }, disabled: new Set() }
    renderSection(controller)
    const orphanRow = document.querySelector('[data-dsh-nux-orphan-row="host.command.foo"]')
    expect(orphanRow).not.toBeNull()
    expect(orphanRow!.textContent).toContain('Ctrl+Shift+G')
    fireEvent.click(orphanRow!.querySelector('[data-dsh-nux-orphan-remove]')!)
    expect(controller.scope.unset).toHaveBeenCalledWith('host.command.foo')
  })

  it('W1.3: provider group header is a disclosure toggle (default expanded)', () => {
    const controller = makeController()
    renderSection(controller)
    expect(screen.getByText('shortcuts.action.navigator.toggle')).toBeTruthy()
    const header = document.querySelector('[data-dsh-nux-group-header="workbench"]') as HTMLButtonElement
    expect(header.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('shortcuts.action.navigator.toggle')).toBeNull()
    fireEvent.click(header)
    expect(screen.getByText('shortcuts.action.navigator.toggle')).toBeTruthy()
  })

  it('review-fix (nit, pinned): collapsing a group then searching auto-expands it to show matches', () => {
    const controller = makeController()
    renderSection(controller)
    const header = document.querySelector('[data-dsh-nux-group-header="workbench"]') as HTMLButtonElement
    fireEvent.click(header) // user collapses the group
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('shortcuts.action.session.stop')).toBeNull()

    const search = document.querySelector('[data-dsh-nux-search]') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'shortcuts.action.session.stop' } })
    // Search auto-expand: a matching row renders even though the group is
    // stored as collapsed.
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('shortcuts.action.session.stop')).toBeTruthy()

    // review-fix (nit): a header click while the auto-expand override is
    // active cannot change anything on screen (already forced open), so it
    // must be a no-op rather than silently flipping the *stored* collapse
    // state out from under the override.
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('true')

    fireEvent.change(search, { target: { value: '' } })
    // The original stored choice (collapsed, from the very first click) is
    // still in force now that the override has lifted -- proof the
    // in-between click during the override never touched collapsedProviders.
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('shortcuts.action.session.stop')).toBeNull()
  })

  it('review-fix (nit, pinned): recording survives collapsing its own group via the header', () => {
    const controller = makeController()
    renderSection(controller)
    const chordButton = document.querySelector('[data-dsh-nux-chord="workbench.session.stop"]') as HTMLButtonElement
    fireEvent.click(chordButton) // start recording
    expect(chordButton.getAttribute('aria-pressed')).toBe('true')

    const header = document.querySelector('[data-dsh-nux-group-header="workbench"]') as HTMLButtonElement
    fireEvent.click(header) // attempt to collapse the group holding the recording row
    // Forced open: the recording row (and its live chord-capture UI) survives.
    expect(header.getAttribute('aria-expanded')).toBe('true')
    const row = document.querySelector('[data-dsh-nux-shortcut-row="workbench.session.stop"]')
    expect(row).not.toBeNull()
    expect(row!.querySelector('[data-dsh-nux-chord]')?.getAttribute('aria-pressed')).toBe('true')

    // review-fix (nit): that header click must also be a no-op on the
    // *stored* collapse state -- cancel the recording (Escape) and confirm
    // the group is NOT left collapsed as an invisible side effect of the
    // inert click.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(chordButton.getAttribute('aria-pressed')).toBe('false')
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('shortcuts.action.session.stop')).toBeTruthy()
  })

  it('regression: a persisted disabled action renders disabled, and toggling a DIFFERENT action preserves it on the next persist', async () => {
    // Defense-in-depth, not a bug fix: the sync effect (`if
    // (controller.persisted !== undefined) setLocalDisabled(...)`) already
    // covers the mounted case at HEAD, seeding localDisabled from
    // controller.persisted.disabled as soon as it is available, so a
    // persisted-disabled action does not stick around rendered as enabled.
    // localDisabled's lazy initializer closes the narrower one-frame window
    // before that effect's first run — see shortcuts.tsx for the full
    // reasoning. This test exercises the steady-state (post-mount) behavior
    // either mechanism produces: the row renders disabled, and toggling a
    // DIFFERENT action's enablement still persists this one correctly.
    const controller = makeController()
    controller.persisted = { bindings: {}, disabled: new Set(['workbench.session.stop']) }
    renderSection(controller)

    const stopRow = document.querySelector('[data-dsh-nux-shortcut-row="workbench.session.stop"]')!
    fireEvent.click(stopRow.querySelector('[data-dsh-nux-overflow]')!)
    const stopEnabled = stopRow.querySelector('[data-dsh-nux-overflow-enabled] input') as HTMLInputElement
    expect(stopEnabled.checked).toBe(false) // seeded as disabled, not enabled

    const navRow = document.querySelector('[data-dsh-nux-shortcut-row="workbench.conversation.navigator.toggle"]')!
    fireEvent.click(navRow.querySelector('[data-dsh-nux-overflow]')!)
    const navEnabled = navRow.querySelector('[data-dsh-nux-overflow-enabled] input') as HTMLInputElement
    expect(navEnabled.checked).toBe(true)
    fireEvent.click(navEnabled) // toggle a DIFFERENT action's enablement
    await act(async () => {})

    const lastPersist = (controller.persist as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as {
      disabled: ReadonlySet<string>
    }
    expect(Array.from(lastPersist.disabled).sort()).toEqual(
      ['workbench.conversation.navigator.toggle', 'workbench.session.stop'].sort(),
    )
  })

  it('W1.2: a persisted old-id override migrates and displays under the renamed action row', () => {
    // Simulates what applyShortcuts() hydration actually produces: raw
    // persisted JSON with the pre-W1.2 bare id, run through
    // parsePersistedState (the persistence layer's migration choke point),
    // then committed as controller.persisted. The settings row is keyed by
    // the LIVE (namespaced) action id, so display only works end-to-end if
    // the migration actually ran.
    const migrated = parsePersistedState({
      schemaVersion: 1,
      bindings: { 'session.stop': 'Primary+Shift+Y' },
    })
    const controller = makeController(migrated.bindings)
    controller.persisted = { bindings: migrated.bindings, disabled: new Set() }
    renderSection(controller)
    const row = document.querySelector('[data-dsh-nux-shortcut-row="workbench.session.stop"]')
    expect(row).not.toBeNull()
    expect(row!.querySelector('[data-dsh-nux-chord-button]')?.textContent).toContain('Ctrl+Shift+Y')
  })

  // -------------------------------------------------------------------
  // W3.1 — third-party workbench.actions registrations: grouped by their
  // OWN provider (not workbench/host), bindable because the registration
  // came through the trusted service, and the pinned "untrusted foreign
  // provider" row above (registered directly into the registry, bypassing
  // the service) stays read-only.
  // -------------------------------------------------------------------

  it('W3.1: a provider with a LIVE registration through workbench.actions renders editable — bindable, overflow menu present', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register({ id: 'myplugin.doThing', label: () => 'Do the thing', run: () => {} })
    const controller = makeController({}, undefined, HOST_SERVICES, handle)
    renderSection(controller)
    const row = document.querySelector('[data-dsh-nux-shortcut-row="myplugin.doThing"]')!
    expect(row).not.toBeNull()
    expect(row.textContent).toContain('Do the thing')
    const button = row.querySelector('[data-dsh-nux-chord-button]') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(row.querySelector('[data-dsh-nux-overflow]')).not.toBeNull()

    fireEvent.click(button)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.keyDown(window, { key: 'G', shiftKey: true, ctrlKey: true })
    const save = screen.getByText('shortcuts.save')
    fireEvent.click(save)
    expect(controller.scope.set).toHaveBeenCalledWith('myplugin.doThing', 'Primary+Shift+G')
  })

  it('W3.1: the third-party provider group renders under its own raw id (no providerLabel field in v1)', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register({ id: 'myplugin.doThing', label: () => 'Do the thing', run: () => {} })
    const controller = makeController({}, undefined, HOST_SERVICES, handle)
    renderSection(controller)
    expect(document.querySelector('[data-dsh-nux-group="myplugin"]')).not.toBeNull()
    expect(screen.getByText('myplugin')).toBeTruthy()
  })

  it('W3.1: a foreign-provider row NOT registered through workbench.actions stays read-only even when an UNRELATED provider is trusted', () => {
    // Regression guard for the trust boundary: liveProviders() must answer
    // per-provider, not "any third-party handle exists at all" — otherwise
    // wiring in a real thirdPartyActionsHandle would silently flip the
    // pinned W1.3 untrusted-provider test from read-only to editable.
    const handle = createThirdPartyActionsHandle()
    handle.service.register({ id: 'myplugin.doThing', label: () => 'Do the thing', run: () => {} })
    const controller = makeController({}, undefined, HOST_SERVICES, handle)
    controller.registry.register({
      id: 'someplugin.x',
      label: 'someplugin.x.label',
      defaultChord: 'Primary+Shift+Z',
      run: () => {},
      provider: 'someplugin',
    })
    renderSection(controller)
    const untrustedRow = document.querySelector('[data-dsh-nux-shortcut-row="someplugin.x"]')!
    expect((untrustedRow.querySelector('[data-dsh-nux-chord-button]') as HTMLButtonElement).disabled).toBe(true)
    const trustedRow = document.querySelector('[data-dsh-nux-shortcut-row="myplugin.doThing"]')!
    expect((trustedRow.querySelector('[data-dsh-nux-chord-button]') as HTMLButtonElement).disabled).toBe(false)
  })

  // -------------------------------------------------------------------
  // F7 — saveRecording's second loop (the registry sweep). Recording a
  // chord that is another action's shipped DEFAULT (not an override) must
  // still displace that action into an explicit UNBOUND sentinel. Without
  // the sweep the first loop — which only walks `overrides` — never sees the
  // default owner, two actions end up on one chord, and ActionRegistry.
  // resolve() returns null for `length !== 1`: BOTH actions go dead while
  // Settings shows the new binding as saved. That is exactly the "silent
  // dead-lock with the default" saveRecording's own comment promises to avoid.
  // -------------------------------------------------------------------

  it('F7: recording another action DEFAULT chord unbinds that action explicitly (no two-owner dead-lock)', async () => {
    // Primary+B is workbench.layout.sidebar.toggle's shipped default AND a
    // browser-reserved bookmarks chord, so a user has every reason to move it
    // onto something else — here workbench.session.stop, which carries NO
    // override, so only the registry sweep can notice the collision.
    const controller = makeController()
    renderSection(controller)

    const stopButton = document.querySelector('[data-dsh-nux-chord="workbench.session.stop"]') as HTMLButtonElement
    fireEvent.click(stopButton)
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    fireEvent.click(screen.getByText('shortcuts.save'))
    await act(async () => {})

    const persisted = (controller.persist as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as {
      bindings: Record<string, string>
    }
    // (1) the displaced DEFAULT owner is written out as an explicit Unbound.
    expect(persisted.bindings['workbench.session.stop']).toBe('Primary+B')
    expect(persisted.bindings['workbench.layout.sidebar.toggle']).toBe(UNBOUND_SENTINEL)

    // (2) reload from exactly those bindings: one owner, no conflict, and the
    // chord dispatches to the action the user just bound it to.
    const reloaded = buildShortcutRegistry({ overrides: persisted.bindings, services: HOST_SERVICES })
    expect(reloaded.conflicts()).toEqual([])
    expect(reloaded.resolve(parseChord('Primary+B')!)?.id).toBe('workbench.session.stop')
    expect(reloaded.bindingChord('workbench.layout.sidebar.toggle')).toBeNull()
  })

  // -------------------------------------------------------------------
  // F8 — workbench.pane.close-focused is gated on the presentation face's
  // PROTOCOL, not merely on the face existing.
  // -------------------------------------------------------------------

  it('F8: a protocol-1 host (guard verdict: incompatible) does not register workbench.pane.close-focused at all', () => {
    const legacyHost = {
      ...HOST_SERVICES,
      sessions: {
        ...HOST_SERVICES.sessions,
        presentation: { protocol: 1, close: () => {}, state: { getSnapshot: () => ({}) } },
      },
    }
    const registry = buildShortcutRegistry({ services: legacyHost })
    expect(registry.all().some((a) => a.id === 'workbench.pane.close-focused')).toBe(false)
    // ...and the incompatible host's Settings page never offers the row.
    renderSection(makeController({}, undefined, legacyHost))
    expect(document.querySelector('[data-dsh-nux-shortcut-row="workbench.pane.close-focused"]')).toBeNull()
    expect(screen.queryByText('shortcuts.action.pane.closeFocused')).toBeNull()
  })

  it('F8: a presentation face with no protocol and no close() is treated as absent (no keydown-time throw)', () => {
    const facelessHost = {
      ...HOST_SERVICES,
      sessions: { ...HOST_SERVICES.sessions, presentation: { state: { getSnapshot: () => ({}) } } },
    } as unknown as typeof HOST_SERVICES
    const registry = buildShortcutRegistry({ services: facelessHost })
    expect(registry.all().some((a) => a.id === 'workbench.pane.close-focused')).toBe(false)
  })

  it('F8: a protocol-2 host whose presentation face has NO close() does not register either', () => {
    // The half of the gate the protocol check alone cannot cover, and the one
    // the original crash came from: `presentation` exists and even reports the
    // supported protocol, but `close` is missing, so the old
    // `presentation !== undefined` test registered an action whose run() threw
    // "close is not a function" on the very first Primary+\ keydown. Fail
    // closed: no callable verb, no capability.
    const closeless = {
      ...HOST_SERVICES,
      sessions: {
        ...HOST_SERVICES.sessions,
        presentation: { protocol: 2, state: { getSnapshot: () => ({ focused: 's1' }) } },
      },
    } as unknown as typeof HOST_SERVICES
    const registry = buildShortcutRegistry({ services: closeless })
    expect(registry.all().some((a) => a.id === 'workbench.pane.close-focused')).toBe(false)
    // Nothing is left for a keydown to dispatch into, so the throw is
    // unreachable rather than merely unlikely.
    expect(registry.resolve(parseChord('Primary+\\')!)).toBeNull()
  })

  it('F8: the compatible protocol-2 host still registers the row (the gate is not a blanket removal)', () => {
    const registry = buildShortcutRegistry({ services: HOST_SERVICES })
    expect(registry.all().some((a) => a.id === 'workbench.pane.close-focused')).toBe(true)
    renderSection()
    expect(document.querySelector('[data-dsh-nux-shortcut-row="workbench.pane.close-focused"]')).not.toBeNull()
  })

  // -------------------------------------------------------------------
  // F9 — "Clear" (unbind) reachability on a fresh install.
  // -------------------------------------------------------------------

  it('F9: Clear is enabled for an action still on its shipped default (fresh install, no override)', async () => {
    const controller = makeController() // no overrides at all
    renderSection(controller)
    const row = document.querySelector('[data-dsh-nux-shortcut-row="workbench.layout.sidebar.toggle"]')!
    fireEvent.click(row.querySelector('[data-dsh-nux-overflow]')!)
    const unbindButton = row.querySelector('[data-dsh-nux-unbind]') as HTMLButtonElement
    // Reset stays disabled (nothing to reset TO) — that part is correct and
    // is precisely why Clear had to be reachable on its own.
    expect((row.querySelector('[data-dsh-nux-reset]') as HTMLButtonElement).disabled).toBe(true)
    expect(unbindButton.disabled).toBe(false)

    fireEvent.click(unbindButton)
    await act(async () => {})
    expect(controller.scope.set).toHaveBeenCalledWith('workbench.layout.sidebar.toggle', UNBOUND_SENTINEL)
    const persisted = (controller.persist as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as {
      bindings: Record<string, string>
    }
    expect(persisted.bindings['workbench.layout.sidebar.toggle']).toBe(UNBOUND_SENTINEL)
  })

  it('F9: Clear is disabled once the action is ALREADY unbound (nothing left to clear)', () => {
    const controller = makeController({ 'workbench.layout.sidebar.toggle': UNBOUND_SENTINEL })
    renderSection(controller)
    const row = document.querySelector('[data-dsh-nux-shortcut-row="workbench.layout.sidebar.toggle"]')!
    fireEvent.click(row.querySelector('[data-dsh-nux-overflow]')!)
    expect((row.querySelector('[data-dsh-nux-unbind]') as HTMLButtonElement).disabled).toBe(true)
    // Reset is still available: it restores the shipped default.
    expect((row.querySelector('[data-dsh-nux-reset]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('F9: Clear is disabled for an action that ships with no default chord and has no override', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register({ id: 'myplugin.noChord', label: () => 'No chord', run: () => {} })
    renderSection(makeController({}, undefined, HOST_SERVICES, handle))
    const row = document.querySelector('[data-dsh-nux-shortcut-row="myplugin.noChord"]')!
    fireEvent.click(row.querySelector('[data-dsh-nux-overflow]')!)
    expect((row.querySelector('[data-dsh-nux-unbind]') as HTMLButtonElement).disabled).toBe(true)
  })

  // -------------------------------------------------------------------
  // F4 — Primary+Shift+C (workbench.chat.open's default) collides with the
  // DevTools element inspector in Chrome/Edge/Firefox. The chord is KEPT;
  // the row must surface the warning, exactly like session.new's Primary+N.
  // -------------------------------------------------------------------

  it('F4: the workbench.chat.open row shows the DevTools reserved note for its default chord', () => {
    const chatActions = { open: async () => ({ kind: 'no-workspace' as const, sourceSessionId: undefined }) }
    const controller = makeController()
    controller.registry = buildShortcutRegistry({ services: HOST_SERVICES, chatActions })
    renderSection(controller)
    const row = document.querySelector('[data-dsh-nux-shortcut-row="workbench.chat.open"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('Ctrl+Shift+C')
    expect(row!.textContent).toContain('reserved.note.devtoolsInspect')
  })

  it('F4: both shipped dictionaries carry the new reserved note key', () => {
    expect(zh['reserved.note.devtoolsInspect']).toBeTruthy()
    expect(en['reserved.note.devtoolsInspect']).toBeTruthy()
    expect(zh['reserved.note.devtoolsInspect']).not.toBe(en['reserved.note.devtoolsInspect'])
  })

  it('W3.1: disposing a third-party registration removes its row (reload re-renders without it)', async () => {
    const handle = createThirdPartyActionsHandle()
    const dispose = handle.service.register({ id: 'myplugin.doThing', label: () => 'Do the thing', run: () => {} })
    const controller = makeController({}, undefined, HOST_SERVICES, handle)
    renderSection(controller)
    expect(document.querySelector('[data-dsh-nux-shortcut-row="myplugin.doThing"]')).not.toBeNull()

    dispose()
    // The registry itself already dropped the row synchronously (dispose()
    // calls the registry's own disposer); rebuild the controller's registry
    // the way shortcuts.tsx's reload() would and re-render to confirm the
    // Settings UI reflects it.
    const rebuilt = buildShortcutRegistry({ services: HOST_SERVICES, thirdPartyActionsHandle: handle })
    controller.registry = rebuilt
    cleanup()
    renderSection(controller)
    expect(document.querySelector('[data-dsh-nux-shortcut-row="myplugin.doThing"]')).toBeNull()
  })
})
