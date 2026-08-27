// @vitest-environment jsdom
import * as React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildShortcutRegistry } from './shortcuts.js'
import { SettingsSection, type ShortcutCapabilities, type ShortcutSettingsController } from './shortcuts.js'
import { en, zh } from './locales.js'
import { parsePersistedState } from './shortcut-persistence.js'

/** Host where both services exist (the realistic case): service-backed
 * actions (sidebar / session.stop) register. GA-043 fail-soft gates them on
 * service presence, so UI tests default to a fully-serviced host. */
const HOST_SERVICES = {
  layout: { toggleSidebar: () => {} },
  sessions: {
    scope: () => ({ get: () => ({ cancel: () => {} }) }),
    presentation: { close: () => {}, state: { getSnapshot: () => ({}) } },
  },
}

function makeController(
  overrides: Record<string, string> = {},
  caps?: ShortcutCapabilities,
  services: typeof HOST_SERVICES = HOST_SERVICES,
): ShortcutSettingsController {
  const registry = buildShortcutRegistry({ overrides, caps, services })
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
  return { registry, scope, reload, persist }
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
})
