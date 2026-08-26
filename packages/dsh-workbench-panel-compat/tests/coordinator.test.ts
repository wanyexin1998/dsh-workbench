// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanePanelCoordinator } from '../src/client/coordinator.ts'

function pane(sessionId: string, focused = false): HTMLElement {
  const node = document.createElement('section')
  node.dataset.sessionPane = sessionId
  if (focused) node.dataset.focused = 'true'
  node.innerHTML = '<aside data-session-pane-right></aside><aside data-session-pane-bottom></aside>'
  return node
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('PanePanelCoordinator', () => {
  beforeEach(() => { document.body.replaceChildren() })
  afterEach(() => { vi.restoreAllMocks() })

  it('does not observe or mutate the page before a provider registers', () => {
    const coordinator = new PanePanelCoordinator(document)
    document.body.append(pane('a'))
    expect(document.querySelector('[data-panel-adapter]')).toBeNull()
    coordinator.dispose()
  })

  it('attaches once per Pane, updates focus without remounting, and disposes removed Panes', async () => {
    const first = pane('a', true)
    const second = pane('b')
    document.body.append(first, second)
    const attach = vi.fn((target: { sessionId: string }) => ({ update: vi.fn(), dispose: vi.fn() }))
    const coordinator = new PanePanelCoordinator(document)
    const unregister = coordinator.register({ id: 'provider', attach })
    expect(attach.mock.calls.map(call => call[0].sessionId)).toEqual(['a', 'b'])

    const firstAttachment = attach.mock.results[0]?.value
    first.removeAttribute('data-focused')
    second.dataset.focused = 'true'
    await flush()
    expect(firstAttachment.update).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'a', focused: false }))
    expect(attach).toHaveBeenCalledTimes(2)

    second.remove()
    await flush()
    expect(attach.mock.results[1]?.value.dispose).toHaveBeenCalledOnce()
    unregister()
    expect(firstAttachment.dispose).toHaveBeenCalledOnce()
  })

  it('rejects duplicate adapter ids', () => {
    const coordinator = new PanePanelCoordinator(document)
    const adapter = { id: 'same', attach: () => ({ update() {}, dispose() {} }) }
    coordinator.register(adapter)
    expect(() => coordinator.register(adapter)).toThrow(/already registered/)
    coordinator.dispose()
  })

  it('contains one provider failure while another provider remains attached', () => {
    document.body.append(pane('a'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const healthy = vi.fn(() => ({ update() {}, dispose() {} }))
    const coordinator = new PanePanelCoordinator(document)
    expect(() => coordinator.register({ id: 'broken', attach: () => { throw new Error('broken') } })).not.toThrow()
    coordinator.register({ id: 'healthy', attach: healthy })
    expect(healthy).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('adapter "broken" failed'), expect.any(Error))
    coordinator.dispose()
  })

  it('contains a provider failure when a Pane host is replaced', async () => {
    const firstPane = pane('a')
    document.body.append(firstPane)
    const firstAttachment = { update: vi.fn(), dispose: vi.fn() }
    const attach = vi.fn()
      .mockReturnValueOnce(firstAttachment)
      .mockImplementationOnce(() => { throw new Error('replacement failed') })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const coordinator = new PanePanelCoordinator(document)
    coordinator.register({ id: 'provider', attach })

    firstPane.replaceWith(pane('a'))
    await flush()

    expect(firstAttachment.dispose).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('adapter "provider" failed'),
      expect.any(Error),
    )
    coordinator.dispose()
  })
})
