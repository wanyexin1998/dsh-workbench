// Keyless assembled stock-Harness smoke for Workbench selection actions and Chat mode.
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./workbench-selection-actions-stock.overlay.yml', import.meta.url))
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const SHIPPED_PRESETS = fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url))
const SEED_ID = 'workbench-selection-actions-stock'
const DOWNGRADE = 'Split view is unavailable in this edition, so the Chat mode session was opened in place.'
const SCAFFOLD_MODULE = './scaffold.ts'

interface HostSession {
  readonly id: unknown
  readonly header: { readonly agentPreset?: string }
  readonly events: readonly unknown[]
}

interface HostAgent {
  readonly session: HostSession
}

interface WebScaffold {
  readonly baseUrl: string
  readonly harnessHome: string
  readonly workspaceCwd: string
  readonly ctx: {
    readonly agentPresets: { list(): Promise<readonly { id: string; name?: string }[]> }
    readonly sessions: { list(): readonly HostSession[] }
    readonly agents: { list(): readonly HostAgent[] }
    readonly tools: { schemas(agent: HostAgent): readonly unknown[] }
    readonly apiProxy: {
      readonly workspace: {
        create(request: { rpcId: string; payload: { path: string } }): Promise<{
          result: { ok: true; value: { workspaceId: string } } | { ok: false; error: { message: string } }
        }>
      }
    }
  }
  close(): Promise<void>
}

interface ScaffoldModule {
  launchWebScaffold(options: {
    extraOverlayPath: string
    harnessHome: string
    agentPresets: {
      roots: readonly { path: string; trust: 'system' | 'user' }[]
      default: string
    }
  }): Promise<WebScaffold>
  seedSession(scaffold: WebScaffold, fixtureText: string, id: string): Promise<unknown>
}

async function selectExactText(page: Page, text: string): Promise<void> {
  const target = page.getByText(text, { exact: true }).last()
  await target.waitFor({ state: 'visible', timeout: 15_000 })
  await target.evaluate((element, expected) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let current = walker.nextNode()
    while (current !== null) {
      const value = current.textContent ?? ''
      const start = value.indexOf(expected)
      if (current instanceof Text && start >= 0) {
        const range = document.createRange()
        range.setStart(current, start)
        range.setEnd(current, start + expected.length)
        const selection = window.getSelection()
        if (selection === null) throw new Error('browser exposes no Selection')
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        return
      }
      current = walker.nextNode()
    }
    throw new Error(`text node not found: ${expected}`)
  }, text)
}

describe('web e2e: Workbench selection actions on stock Harness', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  const dialogs: string[] = []
  const consoleLines: string[] = []

  beforeAll(async () => {
    harnessHome = await mkdtemp(join(tmpdir(), 'dsh-workbench-stock-home-'))
    const userPresetRoot = join(harnessHome, '.agent-presets')
    await mkdir(userPresetRoot, { recursive: true })
    const scaffoldModule = await import(/* @vite-ignore */ SCAFFOLD_MODULE) as unknown as ScaffoldModule
    scaffold = await scaffoldModule.launchWebScaffold({
      extraOverlayPath: OVERLAY,
      harnessHome,
      agentPresets: {
        roots: [
          { path: SHIPPED_PRESETS, trust: 'system' },
          { path: userPresetRoot, trust: 'user' },
        ],
        default: 'standard',
      },
    })
    const escapedCwd = JSON.stringify(scaffold.workspaceCwd).slice(1, -1)
    const seed = (await readFile(SEED, 'utf8')).split('{{cwd}}').join(escapedCwd)
    await scaffoldModule.seedSession(scaffold, seed, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    page.on('console', message => consoleLines.push(`${message.type()}:${message.text()}`))
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message())
      await dialog.accept()
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
  })

  it('keeps Add available and opens/reuses one blank Chat mode Session in place', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workbench-selection-actions-stock'))

    await expect.poll(async () => {
      const composition = await readFile(
        join(scaffold.harnessHome, '.agent-presets', 'chat', 'agent.cordis.yml'),
        'utf8',
      ).catch(() => '')
      return {
        seeded: composition.includes('zero-tool, conversation-only'),
        preset: (await scaffold.ctx.agentPresets.list()).find(preset => preset.id === 'chat'),
      }
    }, { timeout: 15_000 }).toMatchObject({
      seeded: true,
      preset: { id: 'chat', name: '聊天模式 / Chat mode' },
    })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await page.getByText('DONE', { exact: true }).last().waitFor({ state: 'visible', timeout: 15_000 })

    const composer = page.locator('[data-composer-seat] textarea:enabled').first()
    await composer.fill('ordinary draft')
    await selectExactText(page, 'DONE')
    const toolbar = page.locator('[data-dsh-selection-toolbar]')
    await toolbar.waitFor({ state: 'visible', timeout: 10_000 })
    await toolbar.getByRole('button', { name: 'Add to conversation' }).waitFor()
    expect(await toolbar.getByRole('button').allTextContents()).toEqual(['Add to conversation'])
    expect(await page.getByRole('button', { name: 'More details' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Ask in side chat' }).count()).toBe(0)
    await toolbar.getByRole('button', { name: 'Add to conversation' }).click()

    await page.locator('[data-dsh-selection-dock]').waitFor({ state: 'visible', timeout: 10_000 })
    expect(await page.locator('[data-dsh-selection-dock]').count()).toBe(1)
    expect(await page.locator('[data-dsh-selection-dock]').textContent()).toContain('DONE')
    const draft = await composer.inputValue()
    expect(draft.startsWith('ordinary draft')).toBe(true)
    expect(draft.match(/@Selected context/gu)).toHaveLength(1)

    const chatWorkspacePath = join(scaffold.workspaceCwd, 'chat')
    await mkdir(chatWorkspacePath, { recursive: true })
    const workspace = await scaffold.ctx.apiProxy.workspace.create({
      rpcId: 'workbench-selection-actions-stock-workspace',
      payload: { path: chatWorkspacePath },
    })
    if (!workspace.result.ok) throw new Error(`workspace.create failed: ${workspace.result.error.message}`)
    await page.waitForTimeout(250)
    await page.evaluate(() => {
      const observed: string[] = []
      ;(window as unknown as { __workbenchKeys: string[] }).__workbenchKeys = observed
      document.addEventListener('keydown', (event) => {
        observed.push(`${event.ctrlKey ? 'C' : '-'}${event.shiftKey ? 'S' : '-'}:${event.key}`)
      }, true)
    })
    await page.keyboard.press('Control+Shift+C')
    await expect.poll(async () => ({
      dialogs: [...dialogs],
      chatCount: scaffold.ctx.sessions.list().filter(session => session.header.agentPreset === 'chat').length,
      keyEvents: await page.evaluate(() => (window as unknown as { __workbenchKeys: string[] }).__workbenchKeys),
      workbenchDiagnostics: consoleLines.filter(line => line.includes('[dsh-workbench] workbench.chat.open')),
    }), { timeout: 15_000 }).toEqual({
      dialogs: [DOWNGRADE],
      chatCount: 1,
      keyEvents: ['C-:Control', 'CS:Shift', 'CS:C'],
      workbenchDiagnostics: [],
    })
    await page.getByText('聊天模式 / Chat mode', { exact: true }).last()
      .waitFor({ state: 'visible', timeout: 15_000 })

    await expect.poll(
      () => scaffold.ctx.sessions.list().filter(session => session.header.agentPreset === 'chat').length,
      { timeout: 15_000 },
    ).toBe(1)
    const firstChat = scaffold.ctx.sessions.list().find(session => session.header.agentPreset === 'chat')
    if (firstChat === undefined) throw new Error('Chat mode Session was not created')
    expect(firstChat.events.some(event => {
      const type = (event as { type?: string }).type
      return type === 'user/message' || type === 'turn/start' || type === 'request/header'
    })).toBe(false)
    const chatAgent = scaffold.ctx.agents.list().find(agent => agent.session.id === firstChat.id)
    expect(chatAgent?.session.header.agentPreset).toBe('chat')
    expect(chatAgent === undefined ? undefined : scaffold.ctx.tools.schemas(chatAgent)).toEqual([])

    await page.keyboard.press('Control+Shift+C')
    await page.waitForTimeout(1_300)
    expect(scaffold.ctx.sessions.list().filter(session => session.header.agentPreset === 'chat').map(session => session.id))
      .toEqual([firstChat.id])
    expect(dialogs).toEqual([DOWNGRADE])
  }, 120_000)
})
