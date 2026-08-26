import { useEffect, useMemo, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * Canonical workspace identity of ONE visible pane (§5.7, UI-05). Two tiers:
 * the workspace-registry path (host-side realpath canon) wins; the raw
 * session cwd is the fallback and is normalized lexically client-side.
 */
export interface PaneWorkspace {
  /** Host-canonical workspace path (WorkspaceView.path) when the session is accounted to a workspace. */
  workspacePath?: string
  /** Session cwd (host-reported); fallback identity below the workspace tier. */
  cwd?: string
}

/** Session facts the warning needs: every visible Pane identity. */
export interface WorkspaceFacts {
  visible: readonly (PaneWorkspace | undefined)[]
}

/**
 * Conservative client-side lexical cwd normalization (UI-05 fallback tier):
 * unifies separators, strips trailing slashes, folds '.'/'..', and
 * case-folds Windows drive-prefixed paths. It CANNOT resolve symlinks —
 * canonical identity must come from the host workspace tier; resolving
 * symlinks in the client is a documented V1 limitation.
 * @param cwd - raw workspace directory path.
 * @returns the normalized comparison key.
 */
export function normalizeCwd(cwd: string): string {
  const unified = cwd.replaceAll('\\', '/')
  const absolute = unified.startsWith('/')
  let value = unified.replace(/\/+$/u, '')
  const parts: string[] = []
  for (const part of value.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') { parts.pop(); continue }
    parts.push(part)
  }
  value = parts.join('/')
  // Preserve POSIX absolute-ness ('' after folding the root would otherwise
  // collide with a relative path); drive-prefixed forms are never prefixed.
  if (absolute && !/^[A-Za-z]:/u.test(value)) value = `/${value}`
  // Windows drive-prefixed paths are case-insensitive: fold conservatively.
  if (/^[A-Za-z]:/u.test(value)) value = value.toLowerCase()
  return value
}

/**
 * Identity key of one pane: the workspace-registry tier wins (keying by the
 * canonical path subsumes workspaceId equality — one workspace has one
 * canonical path — AND still conflicts when two distinct workspaces point at
 * the same directory), normalized cwd is the fallback tier. Both tiers share
 * ONE key space: an accounted pane and an unaccounted pane on the same
 * directory still conflict.
 * @param pane - the pane's identity facts.
 * @returns the comparison key, or undefined when the pane has no identity.
 */
export function paneWorkspaceKey(pane: PaneWorkspace | undefined): string | undefined {
  if (pane === undefined) return undefined
  if (pane.workspacePath !== undefined && pane.workspacePath !== '') {
    return normalizeCwd(pane.workspacePath)
  }
  if (pane.cwd !== undefined && pane.cwd !== '') {
    return normalizeCwd(pane.cwd)
  }
  return undefined
}

/** Defined identity keys of every visible Pane in spatial order. */
export function paneWorkspaceKeys(facts: WorkspaceFacts): string[] {
  return facts.visible
    .map(pane => paneWorkspaceKey(pane))
    .filter((key): key is string => key !== undefined)
}

/**
 * Compute whether a same-workspace conflict exists: ANY two visible panes
 * share a workspace identity (both defined). A shared workspace means two
 * agents may write the same files; the product warns, it never blocks
 * (worktree isolation is V1.5).
 * @param facts - visible Pane identities.
 * @returns true when at least two panes share an identity key.
 */
export function hasSameWorkspaceConflict(facts: WorkspaceFacts): boolean {
  const keys = paneWorkspaceKeys(facts)
  return new Set(keys).size !== keys.length
}

/**
 * Same Workspace Warning banner (product P0, §5.7): renders inside the
 * shell.overlay slot when any two panes share a workspace. The dismiss
 * button is a per-mount acknowledgment; a later version may add an
 * open-in-isolated-worktree action.
 */
export function SameWorkspaceWarning({ facts, onDismiss, t }: {
  facts: WorkspaceFacts
  onDismiss: () => void
  t: (key: string) => string
}) {
  const [dismissed, setDismissed] = useState(false)
  const conflict = hasSameWorkspaceConflict(facts)
  // The shell.overlay entry stays mounted for the app lifetime, so a single
  // ack must acknowledge ONE conflict identity — a genuinely NEW conflict
  // (different shared-workspace key set) re-arms the warning. Keys are
  // notation-insensitive (canonical tier first, normalized cwd below), so
  // 'C:\repo' vs 'c:/repo/' is the SAME identity, not a re-arm.
  const signature = conflict ? [...new Set(paneWorkspaceKeys(facts))].sort().join('\u0000') : ''
  useEffect(() => { setDismissed(false) }, [signature])
  if (dismissed || !conflict) return null
  // The shell.overlay layer floats ABOVE the pane headers: the banner must
  // stay click-through (pointer-events: none) so pane chrome (28px close
  // buttons) stays reachable — only the ack button opts back in.
  return (
    <div
      role="status"
      aria-live="polite"
      className="dsw-workbench-warning"
      data-same-workspace
      style={{
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        margin: '12px auto 0',
        width: 'fit-content',
        padding: '8px 14px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))',
        background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #0f1115)',
        fontSize: 13,
      }}
    >
      <span className="dsw-workbench-warning-text">{t('banner.text')}</span>
      <button
        type="button"
        className="dsw-workbench-warning-ack"
        style={{
          pointerEvents: 'auto',
          cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))',
          background: 'transparent',
          color: 'inherit',
          borderRadius: 6,
          padding: '3px 10px',
          fontSize: 12,
        }}
        onClick={() => { setDismissed(true); onDismiss() }}
      >
        {t('banner.ack')}
      </button>
    </div>
  )
}

/** Marker type re-export so tests can import the session id helper-free. */
export type { SessionId }

/** Build a SessionId -> canonical workspace path index from the workspaces list. */
export function buildWorkspacePathIndex(items: readonly {
  sessionIds: readonly string[]
  path: string
}[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const workspace of items) {
    for (const sessionId of workspace.sessionIds) index.set(sessionId, workspace.path)
  }
  return index
}

/** Memoized empty index for banner renders without the workspaces seat. */
export function useWorkspacePathIndex(useWorkspaces?: <S>(selector: (state: { items: readonly { sessionIds: readonly string[]; path: string }[] }) => S) => S): Map<string, string> {
  const items = useWorkspaces?.(state => state.items)
  return useMemo(() => buildWorkspacePathIndex(items ?? []), [items])
}
