// T4 — navigator UI state machine (pure, seam A).
// Close-timer scheduling stays in the component layer; the reducer only
// owns the canonical state transitions.

export interface NavigatorUiState {
  expanded: boolean
  pinned: boolean
  activeKey: string | null
  focusedIndex: number
  pointerInside: boolean
}

export type NavigatorAction =
  | { type: 'rail-hover-start' }
  | { type: 'rail-hover-end' }
  | { type: 'rail-click' }
  | { type: 'item-click' }
  | { type: 'item-focus'; index: number }
  | { type: 'escape' }
  | { type: 'outside-click' }
  | { type: 'set-active'; key: string | null }
  | { type: 'reset' }

export const initialNavigatorState: NavigatorUiState = {
  expanded: false,
  pinned: false,
  activeKey: null,
  focusedIndex: -1,
  pointerInside: false,
}

export function navigatorReducer(
  state: NavigatorUiState,
  action: NavigatorAction,
): NavigatorUiState {
  switch (action.type) {
    case 'rail-hover-start':
      return { ...state, expanded: true, pointerInside: true }
    case 'rail-hover-end':
      // The component layer runs the delayed-close timer; while pinned the
      // list stays open regardless.
      return { ...state, pointerInside: false }
    case 'rail-click':
      return state.pinned
        ? { ...state, pinned: false, expanded: false }
        : { ...state, pinned: true, expanded: true }
    case 'item-click':
      return state.pinned
        ? { ...state, expanded: true }
        : { ...state, expanded: false }
    case 'item-focus':
      return { ...state, focusedIndex: action.index }
    case 'escape':
      return { ...state, expanded: false, pinned: false, focusedIndex: -1 }
    case 'outside-click':
      if (state.pinned) return state
      // Equality short-circuit: document-level mousedown fires constantly;
      // don't re-render when already collapsed.
      if (!state.expanded && state.focusedIndex === -1) return state
      return { ...state, expanded: false, focusedIndex: -1 }
    case 'set-active':
      return state.activeKey === action.key ? state : { ...state, activeKey: action.key }
    case 'reset':
      // Session switch: drop transient state (PRD §8.7 default: collapsed).
      return initialNavigatorState
    default:
      return state
  }
}
