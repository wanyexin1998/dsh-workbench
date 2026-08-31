// Temporary keyless Edition E2E for the packaged Workbench selection actions.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

interface HostAgent {
  readonly session: {
    readonly id: string
    readonly header: {
      readonly agentPreset?: string
      readonly parentSession?: string
      readonly seedLength?: number
    }
    readonly events: readonly SessionEvent[]
  }
}

interface HostContext {
  readonly agentPresets: { list(): Promise<readonly { readonly id: string }[]> }
  readonly agents: {
    list(): HostAgent[]
    get(id: string): HostAgent | undefined
  }
  readonly tools: { schemas(agent: HostAgent): readonly unknown[] }
  readonly sessions: { flush(session: HostAgent['session']): Promise<unknown> }
  readonly sessionPersistence: {
    inspect(id: string): Promise<{ readonly events: readonly SessionEvent[] }>
  }
}

interface WebScaffold {
  readonly baseUrl: string
  readonly ctx: unknown
  readonly workspaceCwd: string
  close(): Promise<void>
}

interface ScaffoldModule {
  launchWebScaffold(options: Record<string, unknown>): Promise<WebScaffold>
  seedSession(scaffold: WebScaffold, fixture: string, id: string, agentPreset?: string): Promise<string>
  watchConsole(page: Page): { warnings: string[]; pageErrors: string[] }
}

const MODE = process.env.DSH_SNAPSHOT === 'record' ? 'record' : 'replay'
const OVERLAY = fileURLToPath(new URL('./workbench-selection-actions.overlay.yml', import.meta.url))
const SHIPPED_PRESETS = fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url))
const LEFT_ID = 'workbench-selection-left'
const RIGHT_ID = 'workbench-selection-right'
const DONE = 'DONE'
const ASK_QUESTION = 'What does DONE mean here?'
const FIXED_REQUEST = 'Explain the selected context in more detail.'

async function waitFor<T>(read: () => T | Promise<T>, ready: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (ready(value)) return value
    if (Date.now() >= deadline) throw new Error(`condition did not settle within ${timeoutMs}ms`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

function seedLog(title: string): string {
  const createdAt = 1785600000000
  const at = (seq: number, event: Record<string, unknown>): string =>
    JSON.stringify({ ...event, seq, time: createdAt + seq })
  return [
    JSON.stringify({ type: 'session', version: 0, id: '{{sessionId}}', createdAt }),
    at(0, { type: 'turn/start', data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user', rpcId: 'seed' } } } }),
    at(1, { type: 'user/message', data: { content: [{ type: 'text', text: `Seed ${title}` }], source: { kind: 'user', rpcId: 'seed' } }, surfaceOp: 'append' }),
    at(2, { type: 'session/title', data: { title, messageSeqs: [1], source: { kind: 'fallback' } } }),
    at(3, { type: 'step/start', data: { turn: 1, step: 1 } }),
    at(4, { type: 'assistant/message', data: { turn: 1, step: 1, content: [{ type: 'text', text: DONE }], provenance: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }, sourceEventSeqs: [], surfaceOp: 'append' }),
    at(5, { type: 'step/end', data: { turn: 1, step: 1 } }),
    at(6, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
  ].join('\n')
}

function pane(page: Page, id: string) {
  return page.locator(`[data-session-pane="${id}"]`)
}

function host(scaffold: WebScaffold): HostContext {
  return scaffold.ctx as HostContext
}

async function paneOrder(page: Page): Promise<string[]> {
  return await page.locator('[data-session-pane]').evaluateAll(nodes =>
    nodes.map(node => (node as HTMLElement).dataset.sessionPane ?? ''))
}

async function selectDone(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(({ id, text }) => {
    const root = document.querySelector(`[data-session-pane="${CSS.escape(id)}"]`)
    if (root === null) throw new Error(`Pane ${id} is absent`)
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node: Node | null = walker.nextNode()
    while (node !== null && node.textContent !== text) node = walker.nextNode()
    if (node === null) throw new Error(`Text ${text} is absent from Pane ${id}`)
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, text.length)
    const selection = window.getSelection()
    if (selection === null) throw new Error('window.getSelection() is unavailable')
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }, { id: sessionId, text: DONE })
  await page.locator('[data-dsh-selection-toolbar]').waitFor({ timeout: 10_000 })
}

function eventText(event: SessionEvent): string {
  if (event.type !== 'user/message') return ''
  return event.data.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function durableTitle(events: readonly SessionEvent[]): string | undefined {
  for (const event of events as readonly { readonly type: string; readonly data?: { readonly title?: unknown } }[]) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') return event.data.title
  }
  return undefined
}

async function durableOwnUserMessages(scaffold: WebScaffold, id: string): Promise<string[]> {
  const agent = host(scaffold).agents.get(id)
  if (agent === undefined) throw new Error(`Agent ${id} is not live`)
  await host(scaffold).sessions.flush(agent.session)
  const inspected = await host(scaffold).sessionPersistence.inspect(id)
  return inspected.events
    .filter(event => event.type === 'user/message')
    .map(eventText)
    .filter(text => text.includes('<side_chat_boundary>'))
}

function childrenOf(scaffold: WebScaffold, parentId: string): string[] {
  return host(scaffold).agents.list()
    .filter(agent => agent.session.header.parentSession === SessionId(parentId))
    .map(agent => agent.session.id)
}

async function listedSeedIds(page: Page): Promise<string[]> {
  return await page.evaluate(async (wanted) => {
    const response = await fetch('/api/session.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: crypto.randomUUID(), method: 'session.list', payload: {},
      }),
    })
    const body = await response.json() as { result?: { value?: { items?: { sessionId: string }[] } } }
    return (body.result?.value?.items ?? []).map(item => item.sessionId).filter(id => wanted.includes(id))
  }, [LEFT_ID, RIGHT_ID])
}

async function openSeed(page: Page, id: string): Promise<void> {
  const order = await listedSeedIds(page)
  const index = order.indexOf(id)
  if (index < 0) throw new Error(`Seeded Session ${id} is absent from session.list`)
  const group = page.getByRole('treeitem', { name: /^Ungrouped/ })
  const section = group.locator('xpath=ancestor::*[contains(@class, "groupSection")][1]')
  const row = section.locator('[role="treeitem"]').nth(index + 1)
  await row.click()
  await pane(page, id).waitFor({ timeout: 15_000 })
  await page.getByText(DONE, { exact: true }).last().waitFor({ timeout: 15_000 })
}

describe.skipIf(MODE === 'record')('web e2e: Workbench selection actions in Edition', () => {
  let harnessHome: string
  let scaffold: WebScaffold
  let scaffoldApi: ScaffoldModule
  let browser: Browser
  let page: Page
  let tripwire: { warnings: string[]; pageErrors: string[] }
  const api = { fork: 0, prompt: 0 }

  beforeAll(async () => {
    const scaffoldModulePath = './scaffold.ts'
    scaffoldApi = await import(scaffoldModulePath) as unknown as ScaffoldModule
    harnessHome = await mkdtemp(join(tmpdir(), 'dsh-workbench-edition-home-'))
    scaffold = await scaffoldApi.launchWebScaffold({
      extraOverlayPath: OVERLAY,
      harnessHome,
      agentPresets: {
        roots: [
          { path: SHIPPED_PRESETS, trust: 'system' },
          { path: join(harnessHome, '.agent-presets'), trust: 'user' },
        ],
        default: 'standard',
      },
    })
    const presetMetadata = await waitFor(async () => readFile(
      join(harnessHome, '.agent-presets', 'chat', 'preset.yml'),
      'utf8',
    ).catch(() => ''), value => value.includes('聊天模式 / Chat mode'))
    expect(presetMetadata).toContain('聊天模式 / Chat mode')
    const presetIds = await waitFor(
      async () => (await host(scaffold).agentPresets.list()).map(preset => preset.id),
      ids => ids.includes('chat'),
    )
    expect(presetIds).toContain('chat')
    await scaffoldApi.seedSession(scaffold, seedLog('Workbench Left'), LEFT_ID, 'standard')
    await scaffoldApi.seedSession(scaffold, seedLog('Workbench Right'), RIGHT_ID, 'standard')

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (path === '/api/session.fork') api.fork++
      if (path === '/api/session.prompt') api.prompt++
    })
    tripwire = scaffoldApi.watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch(error => failures.push(error))
    await scaffold?.close().catch(error => failures.push(error))
    if (harnessHome !== undefined) await rm(harnessHome, { recursive: true, force: true }).catch(error => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Workbench Edition E2E cleanup failed')
  })

  it('keeps pane identity while chat, Add, Ask, and More Details use real Host paths', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workbench-selection-actions'))

    // Fresh chat: one working Session becomes a stable source beside a zero-tool chat child.
    const sourceAgents = host(scaffold).agents.list().filter(agent => agent.session.header.parentSession === undefined)
    if (sourceAgents.length !== 1) throw new Error(`expected one live working Agent, found ${sourceAgents.length}`)
    const sourceId = sourceAgents[0]!.session.id
    const sourceComposer = page.locator('textarea:enabled').first()
    const sourceDraft = Array.from({ length: 24 }, (_, index) => `source draft ${index}`).join('\n')
    await sourceComposer.fill(sourceDraft)
    const sourceScrollBefore = page.locator('[data-conversation-scroll]').first()
    const scrollBefore = await sourceScrollBefore.evaluate((element: HTMLElement) => {
      element.scrollTop = element.scrollHeight
      return element.scrollTop
    })
    await sourceComposer.press('Control+Shift+C')
    await expect.poll(() => page.locator('[data-session-pane]').count(), { timeout: 15_000 }).toBe(2)
    let chatId = ''
    await expect.poll(() => {
      chatId = host(scaffold).agents.list().find(agent => agent.session.header.agentPreset === 'chat')?.session.id ?? ''
      return chatId
    }, { timeout: 15_000 }).not.toBe('')
    const chatAgent = host(scaffold).agents.get(chatId)
    if (chatAgent === undefined) throw new Error('chat Agent was not published')
    const chatPane = pane(page, chatId)
    const sourcePane = pane(page, sourceId)
    const sourceScroll = sourcePane.locator('[data-conversation-scroll]')
    await chatPane.getByText('聊天模式 / Chat mode', { exact: true }).waitFor({ timeout: 15_000 })
    expect(chatAgent.session.header.agentPreset).toBe('chat')
    expect(host(scaffold).tools.schemas(chatAgent)).toHaveLength(0)
    expect(await paneOrder(page)).toEqual([sourceId, chatId])
    expect(await sourceComposer.inputValue()).toBe(sourceDraft)
    expect(await sourceScroll.evaluate((element: HTMLElement) => element.scrollTop)).toBe(scrollBefore)
    await sourcePane.evaluate(element => { (element as HTMLElement).dataset.e2eIdentity = 'post-split-source-pane' })
    await sourceScroll.evaluate(element => { (element as HTMLElement).dataset.e2eIdentity = 'post-split-source-scroll' })
    const chatComposer = chatPane.locator('textarea:enabled')
    expect(await chatComposer.evaluate(element => document.activeElement === element)).toBe(true)

    // Replace the focused chat with Right, focus the original source, then replace it with Left.
    const ungrouped = page.getByRole('treeitem', { name: /^Ungrouped/ })
    await ungrouped.waitFor({ timeout: 15_000 })
    if (await ungrouped.getAttribute('aria-expanded') !== 'true') await ungrouped.click()
    await openSeed(page, RIGHT_ID)
    expect(await paneOrder(page)).toEqual([sourceId, RIGHT_ID])
    expect(await sourcePane.getAttribute('data-e2e-identity')).toBe('post-split-source-pane')
    expect(await sourceScroll.getAttribute('data-e2e-identity')).toBe('post-split-source-scroll')
    expect(await sourceComposer.inputValue()).toBe(sourceDraft)
    expect(await sourceScroll.evaluate((element: HTMLElement) => element.scrollTop)).toBe(scrollBefore)
    await sourceComposer.click()
    await expect.poll(() => sourcePane.getAttribute('data-focused'), { timeout: 5_000 }).not.toBeNull()
    expect(await paneOrder(page)).toEqual([sourceId, RIGHT_ID])
    expect(await sourcePane.getAttribute('data-e2e-identity')).toBe('post-split-source-pane')
    expect(await sourceScroll.getAttribute('data-e2e-identity')).toBe('post-split-source-scroll')
    await openSeed(page, LEFT_ID)
    expect(await paneOrder(page)).toEqual([LEFT_ID, RIGHT_ID])

    const leftPane = pane(page, LEFT_ID)
    const rightPane = pane(page, RIGHT_ID)
    const leftLog = await host(scaffold).sessionPersistence.inspect(LEFT_ID)
    const rightLog = await host(scaffold).sessionPersistence.inspect(RIGHT_ID)
    expect(durableTitle(leftLog.events)).toBe('Workbench Left')
    expect(durableTitle(rightLog.events)).toBe('Workbench Right')
    await leftPane.evaluate(element => { (element as HTMLElement).dataset.e2eIdentity = 'left-source' })
    const leftComposer = leftPane.locator('textarea:enabled')

    // Add to conversation is pane-scoped: only Left owns the aggregate dock/reference.
    await selectDone(page, LEFT_ID)
    await page.getByRole('button', { name: 'Add to conversation' }).click()
    await leftPane.locator('[data-dsh-selection-dock]').waitFor({ timeout: 10_000 })
    expect(await leftPane.locator('[data-dsh-selection-dock]').count()).toBe(1)
    expect(await rightPane.locator('[data-dsh-selection-dock]').count()).toBe(0)
    const leftDraft = await leftComposer.inputValue()
    expect(leftDraft).toContain('@Selected context')

    // Ask in side chat: one accepted double click => one fork, no prompt until explicit Enter.
    await selectDone(page, LEFT_ID)
    const askForkBefore = api.fork
    const askPromptBefore = api.prompt
    const parent = host(scaffold).agents.get(LEFT_ID)
    if (parent === undefined) throw new Error('Left Agent is not live')
    const parentBeforeAsk = JSON.stringify(parent.session.events)
    page.once('dialog', dialog => { void dialog.accept() })
    await page.getByRole('button', { name: 'Ask in side chat' }).dblclick()
    await expect.poll(() => api.fork, { timeout: 15_000 }).toBe(askForkBefore + 1)
    expect(api.prompt).toBe(askPromptBefore)
    let askChildId = ''
    await expect.poll(() => {
      askChildId = childrenOf(scaffold, LEFT_ID)[0] ?? ''
      return askChildId
    }, { timeout: 15_000 }).not.toBe('')
    await expect.poll(() => paneOrder(page), { timeout: 15_000 }).toEqual([LEFT_ID, askChildId])
    expect(await leftPane.getAttribute('data-e2e-identity')).toBe('left-source')
    expect(await leftComposer.inputValue()).toBe(leftDraft)
    expect(await pane(page, RIGHT_ID).count()).toBe(0)
    const askPane = pane(page, askChildId)
    const askComposer = askPane.locator('textarea:enabled')
    await expect.poll(() => askPane.locator('[data-decoration="chip"]').count(), { timeout: 10_000 }).toBe(1)
    expect(await askComposer.evaluate(element => document.activeElement === element)).toBe(true)
    await askComposer.evaluate((element: HTMLTextAreaElement) => {
      element.focus()
      element.setSelectionRange(element.value.length, element.value.length)
    })
    await askComposer.pressSequentially(ASK_QUESTION)
    await askComposer.press('Enter')
    await expect.poll(() => api.prompt, { timeout: 10_000 }).toBe(askPromptBefore + 1)
    await expect.poll(async () => (await durableOwnUserMessages(scaffold, askChildId)).length, {
      timeout: 15_000,
    }).toBe(1)
    const askMessages = await durableOwnUserMessages(scaffold, askChildId)
    expect(askMessages[0]).toContain('Inherited conversation history is reference-only.')
    expect(askMessages[0]).toContain('<selected_context')
    expect(askMessages[0]).toContain(DONE)
    expect(askMessages[0]).toContain(ASK_QUESTION)
    expect(JSON.stringify(parent.session.events)).toBe(parentBeforeAsk)

    // More Details: cancel creates nothing; accept/double-click creates and sends exactly once.
    await selectDone(page, LEFT_ID)
    const moreForkBefore = api.fork
    const morePromptBefore = api.prompt
    const parentBeforeMore = JSON.stringify(parent.session.events)
    page.once('dialog', dialog => { void dialog.dismiss() })
    await page.getByRole('button', { name: 'More details' }).click()
    await page.getByRole('status').filter({ hasText: 'Cancelled' }).waitFor({ timeout: 10_000 })
    expect(api.fork).toBe(moreForkBefore)
    expect(api.prompt).toBe(morePromptBefore)

    page.once('dialog', dialog => { void dialog.accept() })
    await page.getByRole('button', { name: 'More details' }).dblclick()
    await expect.poll(() => api.fork, { timeout: 15_000 }).toBe(moreForkBefore + 1)
    await expect.poll(() => api.prompt, { timeout: 15_000 }).toBe(morePromptBefore + 1)
    let moreChildId = ''
    await expect.poll(() => {
      moreChildId = childrenOf(scaffold, LEFT_ID).find(id => id !== askChildId) ?? ''
      return moreChildId
    }, { timeout: 15_000 }).not.toBe('')
    await expect.poll(() => paneOrder(page), { timeout: 15_000 }).toEqual([LEFT_ID, moreChildId])
    expect(await leftPane.getAttribute('data-e2e-identity')).toBe('left-source')
    expect(await pane(page, askChildId).count()).toBe(0)
    const moreChild = host(scaffold).agents.get(moreChildId)
    if (moreChild === undefined) throw new Error('More Details child is not live')
    expect(moreChild.session.header.parentSession).toBe(SessionId(LEFT_ID))
    await expect.poll(async () => (await durableOwnUserMessages(scaffold, moreChildId)).length, {
      timeout: 15_000,
    }).toBe(1)
    const moreMessages = await durableOwnUserMessages(scaffold, moreChildId)
    expect(moreMessages[0]).toContain('Inherited conversation history is reference-only.')
    expect(moreMessages[0]).toContain('<selected_context')
    expect(moreMessages[0]).toContain(DONE)
    expect(moreMessages[0]).toContain(FIXED_REQUEST)
    expect(JSON.stringify(parent.session.events)).toBe(parentBeforeMore)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 180_000)
})
