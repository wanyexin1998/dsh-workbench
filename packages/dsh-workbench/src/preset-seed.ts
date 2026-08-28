/**
 * Chat preset seeding — the Host entry's one sanctioned filesystem write.
 *
 * Product contract invariant 7 carve-out: Workbench may seed the bundled
 * `chat` agent preset into the Harness home's user preset directory
 * (`$DSH_HOME/.agent-presets/chat/`). The write is create-only: an existing
 * directory is never touched, and a marker file records that seeding (or a
 * pre-existing user copy) happened so a user who deletes the preset is never
 * fought — Workbench does not re-create it.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Preset directory name under the user preset root; the id UIs show. */
export const CHAT_PRESET_ID = 'chat'

/**
 * Marker recording that the chat preset was seeded (or found already
 * authored). Lives beside the preset directory, not inside it, so deleting
 * `chat/` leaves the marker behind and seeding stays a one-time act. The
 * leading dot keeps it outside the Harness's preset id grammar, so discovery
 * never mistakes it for a preset slot.
 */
export const SEED_MARKER = '.workbench-chat-seeded'

/**
 * `preset.yml` — display metadata. The Harness localizes only built-in
 * preset names, so the name carries both languages side by side.
 */
export const CHAT_PRESET_METADATA = `name: 聊天模式 / Chat mode
description: 零工具，只对话：不读写文件、不执行命令、不加载项目上下文，请求最小最快。
order: 5
`

/**
 * `agent.cordis.yml` — a zero-tool, conversation-only composition. The
 * persona is the complete system prompt (no identity, tool guidance, or
 * listener can append prompt text) and runtime context is suppressed,
 * mirroring the shipped `minimal` preset's prompt discipline. No tool plugin
 * joins, so the agent loop reaches the provider with no `tools` field at all.
 */
export const CHAT_PRESET_COMPOSITION = `# The \`chat\` agent preset: a zero-tool, conversation-only composition.
#
# The persona is the complete system prompt, so global identity, Web
# orientation, tool guidance, and later assembly listeners cannot add prompt
# text, and runtime context snapshots are suppressed — mirroring the \`minimal\`
# preset's prompt discipline. No tool plugin joins this composition, so the
# agent loop reaches the provider with no \`tools\` field at all. Context
# compaction is absent.

- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |-
      You are a helpful, knowledgeable conversation partner. You answer
      questions, discuss ideas, and help the user think things through.

      You have no tools in this mode: you cannot read or write files, execute
      commands, browse the web, or access the user's system in any way. Reply
      with text only. If the user asks for an action that would require tools,
      say so and suggest switching to an agent preset (standard / PTC /
      minimal) instead.

      Respond in the language the user uses.
    complete: true
    includeRuntimeContext: false
`

/** Filesystem face the seeder consumes; tests inject an in-memory double. */
export interface SeedIo {
  /** True when the path exists (any kind of entry). */
  exists(path: string): Promise<boolean>
  /** Create a directory, parents included; existing directories succeed. */
  mkdir(path: string): Promise<void>
  /** Write a UTF-8 text file, replacing nothing that exists (callers gate). */
  writeFile(path: string, text: string): Promise<void>
}

/** Node-backed {@link SeedIo} used by the Host entry. */
export const nodeSeedIo: SeedIo = {
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  },
  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
  },
  async writeFile(path: string, text: string): Promise<void> {
    await writeFile(path, text, 'utf8')
  },
}

export type SeedOutcome =
  /** Fresh install: preset directory and marker were written. */
  | 'seeded'
  /** A `chat/` directory already exists (hand-authored or previously seeded); left untouched. */
  | 'already-present'
  /** Marker exists but the directory does not: the user deleted it; respected. */
  | 'user-removed'

/**
 * Seed the bundled chat preset into one user preset root, create-only.
 * @param presetRoot - the Harness home's user preset root (`$DSH_HOME/.agent-presets`).
 * @param io - filesystem face; the Host entry passes {@link nodeSeedIo}.
 * @returns what the seeder found and did.
 */
export async function seedChatPreset(presetRoot: string, io: SeedIo): Promise<SeedOutcome> {
  const presetDir = join(presetRoot, CHAT_PRESET_ID)
  const markerPath = join(presetRoot, SEED_MARKER)
  if (await io.exists(presetDir)) {
    // A user-authored copy counts as seeded: record the marker so a later
    // deletion of the directory is read as intent, not as a fresh install.
    if (!(await io.exists(markerPath))) await io.writeFile(markerPath, CHAT_PRESET_ID + '\n')
    return 'already-present'
  }
  if (await io.exists(markerPath)) return 'user-removed'
  await io.mkdir(presetDir)
  await io.writeFile(join(presetDir, 'preset.yml'), CHAT_PRESET_METADATA)
  await io.writeFile(join(presetDir, 'agent.cordis.yml'), CHAT_PRESET_COMPOSITION)
  await io.writeFile(markerPath, CHAT_PRESET_ID + '\n')
  return 'seeded'
}
