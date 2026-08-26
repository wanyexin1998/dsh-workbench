// GA-040 (Roadmap §9A.1) — the plugin's minimal typed contract for the
// harness boundary. The harness is in RC and its API will drift, so we
// deliberately do NOT replicate the full SDK type tree: only the seams this
// plugin actually consumes are named. `ctx.get()` returns `unknown` at the
// boundary and is narrowed exactly once, at the few sites below, so a
// signature change surfaces at compile time here instead of as a runtime
// `any`-propagated crash throughout the business layer.
//
// Slot wiring stays on ctx.slots.inject/register (a slot's existence is not
// probed via an invented ctx.slots.has / service.capabilities — §9A.1).

/** Conversation face exposed per session (the only methods the plugin calls). */
export interface ConversationFace {
  cancel?(): Promise<unknown> | unknown
  loadOlder?(): Promise<void> | void
}

/** Scope handle for one session: the plugin reads only `conversation`. */
export interface SessionScope {
  get(name: 'conversation'): ConversationFace | undefined
}

export interface SessionsService {
  scope(sessionId: string): SessionScope | undefined
  presentation?: {
    state: { getSnapshot(): { focused?: string } }
    close(id: string): void
  }
}

export interface LayoutService {
  toggleSidebar(): void
}

/** Aggregate of the injected services the plugin uses. */
export interface HarnessServices {
  layout?: LayoutService
  sessions?: SessionsService
}

/** Bound third-party settings scope (shortcut persistence reads/writes this). */
export interface SettingsScopeFace {
  getSnapshot(): unknown
  subscribe(fn: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

export interface LocaleService {
  register(ns: string, dicts: Record<string, unknown>): void
  bind(ns: string): (key: string, vars?: Record<string, string>) => string
}

export interface SlotDef {
  name: string
  id: string
  order?: number
  label?: () => string
  inject?: () => Record<string, unknown>
}

export interface SlotService {
  register(def: SlotDef, component: unknown): void
  inject(slot: string, fn: () => void): void
}

/**
 * The plugin context surface the client consumes. `get` returns `unknown`:
 * the harness injects untyped services, and every consumer narrows it once
 * (via resolveHarnessServices or a local cast) rather than trusting `any`.
 */
export interface HarnessContext {
  get(name: 'layout' | 'sessions'): unknown
  locale: LocaleService
  slots: SlotService
  settingsScope: { bind(options: { namespace: string }): SettingsScopeFace }
  effect(fn: () => void, label?: string): void
  on(event: 'dispose', fn: () => void): void
}

/**
 * Collapse the injected service seams into a typed bundle. The single
 * narrowing point for ctx.get() — the business layer never calls ctx.get()
 * with `any` again.
 */
export function resolveHarnessServices(ctx: HarnessContext): HarnessServices {
  return {
    layout: ctx.get('layout') as LayoutService | undefined,
    sessions: ctx.get('sessions') as SessionsService | undefined,
  }
}
