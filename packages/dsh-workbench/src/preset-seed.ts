/**
 * Chat preset seeding — the Host entry's one sanctioned filesystem write.
 *
 * Product contract invariant 7 carve-out: Workbench may seed the bundled
 * `chat` agent preset into the Harness home's user preset directory
 * (`$DSH_HOME/.agent-presets/chat/`). The write is create-only: an existing
 * file is never overwritten, and a marker file records that seeding (or a
 * pre-existing user copy) happened so a user who deletes the preset is never
 * fought — Workbench does not re-create it.
 *
 * The one state it does repair is a directory that is not a mountable preset
 * at all — see {@link seedChatPreset}.
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

/** Composition file the Harness mounts; without it the preset id is unusable. */
export const CHAT_PRESET_COMPOSITION_FILE = 'agent.cordis.yml'

/** Display-metadata file; the Harness treats its absence as cosmetic. */
export const CHAT_PRESET_METADATA_FILE = 'preset.yml'

export type SeedOutcome =
  /** Fresh install: preset directory and marker were written. */
  | 'seeded'
  /** A mountable `chat/` preset already exists (hand-authored or previously seeded); left untouched. */
  | 'already-present'
  /** Marker exists but the directory does not: the user deleted it; respected. */
  | 'user-removed'
  /** The directory existed but was not mountable; only the missing files were written. */
  | 'repaired'

/**
 * Seed the bundled chat preset into one user preset root, create-only.
 *
 * **完整性判据是组合文件，不是目录。** 判「目录在 → 已播过」会把一次残缺的播种
 * 变成永久故障：宿主 mount 的是 `agent.cordis.yml`，目录里只剩 `preset.yml` 时它
 * 明确报 `agent-preset/invalid` ——"the directory still occupies the id; delete it
 * or restore the file"——于是随手问每次都失败，而播种器每次都判「已播过」，产品里
 * 没有任何一条路径能把用户救出来。真实机器上就是这一幕：`preset.yml` 与标记文件
 * 的时间戳差了 8 分钟，也就是第二次运行看见残缺目录、盖了章走人。
 *
 * 修的时候**只写缺的那个文件**，已存在的一个都不覆盖，所以手写过 preset 的用户
 * 不会被改。这也不违背「不跟删掉它的用户较劲」：那条约束的是**整个预设被删掉**
 * （目录不在 + 标记在 → `user-removed`，绝不重建）；而缺了组合文件的目录不是
 * 「用户删掉的预设」，是宿主自己判定坏掉、并明确要求恢复文件的槽位。
 *
 * @param presetRoot - the Harness home's user preset root (`$DSH_HOME/.agent-presets`).
 * @param io - filesystem face; the Host entry passes {@link nodeSeedIo}.
 * @returns what the seeder found and did.
 */
export async function seedChatPreset(presetRoot: string, io: SeedIo): Promise<SeedOutcome> {
  const presetDir = join(presetRoot, CHAT_PRESET_ID)
  const markerPath = join(presetRoot, SEED_MARKER)
  const compositionPath = join(presetDir, CHAT_PRESET_COMPOSITION_FILE)
  const metadataPath = join(presetDir, CHAT_PRESET_METADATA_FILE)
  if (await io.exists(presetDir)) {
    // A user-authored copy counts as seeded: record the marker so a later
    // deletion of the directory is read as intent, not as a fresh install.
    if (!(await io.exists(markerPath))) await io.writeFile(markerPath, CHAT_PRESET_ID + '\n')
    if (await io.exists(compositionPath)) return 'already-present'
    await io.writeFile(compositionPath, CHAT_PRESET_COMPOSITION)
    if (!(await io.exists(metadataPath))) await io.writeFile(metadataPath, CHAT_PRESET_METADATA)
    return 'repaired'
  }
  if (await io.exists(markerPath)) return 'user-removed'
  await io.mkdir(presetDir)
  await io.writeFile(metadataPath, CHAT_PRESET_METADATA)
  await io.writeFile(compositionPath, CHAT_PRESET_COMPOSITION)
  await io.writeFile(markerPath, CHAT_PRESET_ID + '\n')
  return 'seeded'
}
