/** Pane-addressed channel between Navigator instances and global actions. */
type ToggleListener = () => void

const listenersBySession = new Map<string, Set<ToggleListener>>()

/** Session-addressed Navigator action channel. */
export const navigatorBus = {
  /** Toggle only the Navigator owned by the focused session. */
  emitToggle(sessionId: string | undefined): void {
    if (sessionId === undefined) return
    for (const listener of [...(listenersBySession.get(sessionId) ?? [])]) listener()
  },
  /** Register one pane-local toggle listener. */
  onToggle(sessionId: string, listener: ToggleListener): () => void {
    const listeners = listenersBySession.get(sessionId) ?? new Set<ToggleListener>()
    listeners.add(listener)
    listenersBySession.set(sessionId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) listenersBySession.delete(sessionId)
    }
  },
}
