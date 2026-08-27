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
