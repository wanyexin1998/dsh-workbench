// T4+T5+T6 — Conversation Input Navigator UI, keyboard flow, a11y, boundaries.
// Registration: conversation.session.header.utilities (session kit injected by
// the framework). All conversation DOM access goes through conversation-dom.ts
// (the adapter seam from ADR-0001); this component stays structure-free.
import * as React from 'react'
import { createPortal } from 'react-dom'
import { deriveNavigatorIndex, type SessionNavigatorItem } from '../core/derive-index.js'
import { RAIL_MARKER_GAP, railMarkers } from '../core/rail-layout.js'
import { findActiveKey } from '../core/active-tracking.js'
import { initialNavigatorState, navigatorReducer } from '../core/navigator-state.js'
import { revealNode, type RevealResult } from '../core/navigation-adapter.js'
import { NS, zh, en } from './locales.js'
import { navigatorBus } from './navigator-bus.js'
import { anchorRectsFromCache, createHumanAnchorCache, ensureHighlightStyles, findAnchor, locateConversationRoot, locateScrollport, normalizeInputNode, railInset, scrollportRect } from './conversation-dom.js'
import { type HarnessContext, type SessionsService } from './harness-adapter.js'
import { warnOnce } from './capabilities.js'

const CLOSE_DELAY_MS = 350
// GA-043 fail-soft: grace before the one-shot "scrollport missing" warn.
// The per-session conversation DOM (and thus the scrollport) mounts after
// apply(); this window lets a normal session settle before we flag the
// anchor as genuinely absent.
const SCROLLPORT_GRACE_MS = 1500
// GA-031: hard deadline for the document.body discovery bootstrap. If the
// Conversation root never mounts within this window the body observer is
// stopped (the missing-scrollport warn above already fired).
const DISCOVERY_TIMEOUT_MS = 10000
// The fixed wrapper positions the overlay; only the visible marker cluster
// accepts pointer input.
const RAIL_WIDTH = 32
const RAIL_INSET = 10
// One equal-length, equal-thickness dash per human input. Active differs only
// by ink depth; long histories scroll without sampling.
const MARKER_WIDTH = 18
const MARKER_HEIGHT = 2
const MARKER_RADIUS = 3
const MARKER_COLOR_ACTIVE = 'var(--dsw-alias-label-primary, #3e4249)'
const MARKER_COLOR_IDLE = 'var(--dsw-alias-label-tertiary, #bec2c8)'
// GA-011 (Roadmap §9A.9): Floating Prompt List glass card, floats to the left
// of the rail, vertically centered (prototype .prompt-popover).
const LIST_WIDTH = 326
const LIST_RADIUS = 14
const LIST_BACKGROUND = 'color-mix(in srgb, var(--dsw-alias-bg-layer-2, #fff) 88%, transparent)'
const LIST_BORDER = '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10))'
const LIST_SHADOW = 'var(--dsw-shadow-lv2, 0 8px 24px rgba(10,17,28,.10))'
const LIST_BACKDROP_BLUR = 'blur(16px) saturate(132%)'

/**
 * Minimal session-snapshot view the navigator selects. The harness snapshot
 * is larger; we type only the fields the component reads. Nodes stay
 * `unknown` at this boundary — `normalizeInputNode` (adapter) is the single
 * narrowing point to the core `InputNodeView` shape.
 */
export interface ChatSnapshot {
  chat?: { order?: readonly string[]; nodes?: { get(key: string): unknown } }
  hasMore?: boolean
  loadingOlder?: boolean
}

export interface NavigatorAnchorProps {
  sessionId: string
  useSession: <T>(selector: (snapshot: ChatSnapshot) => T) => T
  t: (key: string) => string
  sessions?: SessionsService
}

export function NavigatorAnchor({ sessionId, useSession, t, sessions }: NavigatorAnchorProps) {
  const order = useSession((snapshot: ChatSnapshot) => snapshot?.chat?.order ?? null)
  const nodes = useSession((snapshot: ChatSnapshot) => snapshot?.chat?.nodes ?? null)
  const hasMore = useSession((snapshot: ChatSnapshot) => snapshot?.hasMore === true)
  const loadingOlder = useSession((snapshot: ChatSnapshot) => snapshot?.loadingOlder === true)
  const items: SessionNavigatorItem[] = React.useMemo(() => {
    if (order === null || nodes === null) return []
    return deriveNavigatorIndex({
      order,
      getNode: (key: string) => normalizeInputNode(nodes.get(key)) ?? undefined,
    })
  }, [order, nodes])

  const [rect, setRect] = React.useState<{ top: number; bottom: number; right: number } | null>(null)
  const [scrollport, setScrollport] = React.useState<HTMLElement | null>(null)
  const [state, dispatch] = React.useReducer(navigatorReducer, initialNavigatorState)
  const railRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const anchorRef = React.useRef<HTMLSpanElement>(null)
  const paneRoot = React.useCallback(
    (): ParentNode => anchorRef.current?.closest<HTMLElement>('[data-session-pane]') ?? document,
    [],
  )

  // Session switch: drop transient state (PRD §8.7 default is collapsed).
  React.useEffect(() => {
    dispatch({ type: 'reset' })
  }, [sessionId])

  // Resolve the scrollport with retry: it may mount after us, and it may
  // be rebuilt (view switches, HMR). GA-031 (Roadmap §9A.10): never watch
  // document.body long-term — body is only the discovery bootstrap until
  // the Conversation root (`.ConversationRoot_root[data-phase]`) shows up;
  // once found, observation narrows to the root's parent so that both
  // scrollport rebuilds and root replacement (view switch / HMR) refresh
  // the reference.
  React.useEffect(() => {
    let disposed = false
    let scope: HTMLElement | null = null
    let observer: MutationObserver | null = null

    const scopeFor = () => {
      const owner = paneRoot()
      const root = locateConversationRoot(owner)
      return root !== null
        ? ((root.parentElement as HTMLElement | null) ?? root)
        : owner instanceof HTMLElement ? owner : document.body
    }

    const rescope = (next: HTMLElement) => {
      if (disposed || scope === next) return
      scope = next
      observer?.disconnect()
      observer = new MutationObserver(() => {
        if (disposed) return
        const found = locateScrollport(paneRoot())
        if (found !== null) setScrollport(found)
        const nextScope = scopeFor()
        if (nextScope !== scope) rescope(nextScope)
      })
      observer.observe(next, { childList: true, subtree: true })
    }

    rescope(scopeFor())
    const initial = locateScrollport(paneRoot())
    if (initial !== null) setScrollport(initial)
    // GA-043 fail-soft (§9A.11): the scrollport may be absent (anchor renamed
    // or the session has no conversation DOM yet). The navigator already
    // renders null (not mounted) and never crashes; if it is still missing
    // after a grace period (the per-session DOM usually mounts within it),
    // surface a one-shot warning so a genuinely-broken anchor is visible.
    const missingTimer = window.setTimeout(() => {
      if (disposed) return
      if (locateScrollport(paneRoot()) === null) {
        warnOnce('navigator-scrollport-missing', 'conversation scrollport [data-conversation-scroll] not found; navigator not mounted')
      }
    }, SCROLLPORT_GRACE_MS)
    // GA-031 (Roadmap §9A.10): the discovery observer must never watch
    // document.body forever. It only bootstraps until the Conversation root
    // shows up (then rescope narrows to the root's parent); if the root never
    // appears — incompatible host or no session — stop the body watch after a
    // bounded window. The scrollport-missing warn above already fired, and the
    // navigator renders null, so this is a no-op on a healthy session.
    const discoveryTimer = window.setTimeout(() => {
      if (disposed) return
      if (scope === document.body) observer?.disconnect()
    }, DISCOVERY_TIMEOUT_MS)
    return () => {
      disposed = true
      observer?.disconnect()
      window.clearTimeout(missingTimer)
      window.clearTimeout(discoveryTimer)
    }
  }, [paneRoot, sessionId])

  // Track the scrollport rect (fixed positioning; follows layout changes
  // such as the Tool Details column without causing reflow).
  React.useEffect(() => {
    if (scrollport === null) return
    const update = () => {
      const r = scrollportRect(scrollport)
      setRect({ top: r.top, bottom: r.bottom, right: r.right })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(scrollport)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [scrollport])

  // Active-node tracking: human input anchors only, rAF-throttled.
  // GA-032 (Roadmap §9A.7): scroll reads the cached anchor elements —
  // structural changes refresh the cache (coalesced via queueMicrotask),
  // so no per-frame full-DOM querySelectorAll.
  React.useEffect(() => {
    if (scrollport === null) return
    const cache = createHumanAnchorCache(scrollport)
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const anchors = anchorRectsFromCache(cache.snapshot())
        const viewport = scrollport.getBoundingClientRect()
        dispatch({ type: 'set-active', key: findActiveKey(anchors, viewport.top, viewport.height) })
      })
    }
    scrollport.addEventListener('scroll', update, { passive: true })
    update()
    return () => {
      scrollport.removeEventListener('scroll', update)
      cancelAnimationFrame(frame)
      cache.dispose()
    }
  }, [scrollport])

  // Escape closes; mousedown outside the rail+list closes (unless pinned).
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dispatch({ type: 'escape' })
    }
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      const inside =
        (railRef.current !== null && railRef.current.contains(target)) ||
        (listRef.current !== null && listRef.current.contains(target))
      if (!inside) dispatch({ type: 'outside-click' })
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [])

  // Delayed close after the pointer leaves, unless pinned.
  React.useEffect(() => {
    if (state.pointerInside || !state.expanded || state.pinned) return
    const timer = window.setTimeout(() => dispatch({ type: 'outside-click' }), CLOSE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [state.pointerInside, state.expanded, state.pinned])

  // Shortcut integration: conversation.navigator.toggle → pin/expand toggle.
  React.useEffect(
    () => navigatorBus.onToggle(sessionId, () => dispatch({ type: 'rail-click' })),
    [sessionId],
  )

  const reveal = async (nodeKey: string) => {
    const prefersReducedMotion =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const result: RevealResult = await revealNode(sessionId, nodeKey, { reducedMotion: prefersReducedMotion }, {
      locateScrollport: () => locateScrollport(paneRoot()),
      findAnchor,
      currentSessionId: () => sessionId,
    })
    if (result === 'not-loaded') {
      // The node's anchor is not rendered yet: surface the boundary hint
      // instead of failing silently (tech design §11).
      dispatch({ type: 'rail-hover-start' })
    }
  }

  const loadOlder = () => {
    const scoped = sessions?.scope(sessionId)
    const face = scoped?.get('conversation')
    if (face?.loadOlder === undefined) return
    // Explicit user action only — never auto-load the full history.
    void Promise.resolve(face.loadOlder()).catch(() => {})
  }

  const anchor = <span ref={anchorRef} data-dsh-nux-pane-anchor hidden />
  if (rect === null || scrollport === null) return anchor
  const inset = railInset(scrollport, rect, RAIL_INSET)
  return (
    <>
      {anchor}
      {createPortal(
        <NavigatorOverlay
          items={items}
          hasMore={hasMore}
          loadingOlder={loadingOlder}
          state={state}
          rect={rect}
          inset={inset}
          dispatch={dispatch}
          railRef={railRef}
          listRef={listRef}
          t={t}
          onReveal={(key) => void reveal(key)}
          onLoadOlder={loadOlder}
        />,
        document.body,
      )}
    </>
  )
}

interface NavigatorOverlayProps {
  items: SessionNavigatorItem[]
  hasMore: boolean
  loadingOlder: boolean
  state: ReturnType<typeof navigatorReducer>
  rect: { top: number; bottom: number; right: number }
  inset: number
  dispatch: React.Dispatch<any>
  railRef: React.RefObject<HTMLDivElement>
  listRef: React.RefObject<HTMLDivElement>
  t: (key: string) => string
  onReveal: (nodeKey: string) => void
  onLoadOlder: () => void
}

function NavigatorOverlay(props: NavigatorOverlayProps) {
  const { items, hasMore, loadingOlder, state, rect, inset, dispatch, railRef, listRef, t, onReveal, onLoadOlder } = props
  const activeIndex = state.activeKey === null ? undefined : items.findIndex((i) => i.key === state.activeKey)
  const markers = railMarkers(items.length, activeIndex === -1 ? undefined : activeIndex)

  const onRailKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (state.expanded && state.focusedIndex >= 0 && items[state.focusedIndex] !== undefined) {
        const item = items[state.focusedIndex]
        onReveal(item.key)
        dispatch({ type: 'item-click' })
      } else {
        dispatch({ type: 'rail-click' })
        dispatch({ type: 'item-focus', index: 0 })
      }
    } else if (event.key === 'ArrowDown' && state.expanded) {
      event.preventDefault()
      const next = Math.min(items.length - 1, state.focusedIndex + 1)
      dispatch({ type: 'item-focus', index: next })
    } else if (event.key === 'ArrowUp' && state.expanded) {
      event.preventDefault()
      const prev = Math.max(0, state.focusedIndex - 1)
      dispatch({ type: 'item-focus', index: prev })
    }
  }

  return (
    <div
      ref={railRef}
      data-dsh-nux="rail"
      style={{
        position: 'fixed',
        top: rect.top,
        height: rect.bottom - rect.top,
        right: inset,
        width: RAIL_WIDTH,
        zIndex: 3,
        pointerEvents: 'none',
      }}
    >
      <div
        data-dsh-nux="marker-cluster"
        role="navigation"
        tabIndex={0}
        aria-label={t('navigator.rail')}
        aria-expanded={state.expanded}
        aria-controls="dsh-nux-prompt-list"
        aria-activedescendant={state.expanded && state.focusedIndex >= 0 && items[state.focusedIndex] !== undefined ? 'dsh-nux-option-' + state.focusedIndex : undefined}
        onKeyDown={onRailKeyDown}
        style={{
          position: 'absolute',
          top: '50%',
          right: 0,
          display: 'flex',
          width: MARKER_WIDTH + 6,
          maxHeight: 'calc(100% - 16px)',
          padding: '4px 0',
          transform: 'translateY(-50%)',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: RAIL_MARKER_GAP - MARKER_HEIGHT,
          overflowY: 'auto',
          scrollbarWidth: 'none',
          pointerEvents: 'auto',
          cursor: 'pointer',
          opacity: state.expanded ? 0 : 1,
          transition: 'opacity 160ms var(--ds-ease-in-out, ease)',
        }}
      >
        {markers.map((marker) => (
          <div
            key={marker.nodeIndex}
            data-dsh-nux-marker={marker.active ? 'active' : 'idle'}
            onMouseEnter={() => dispatch({ type: 'rail-hover-start' })}
            onMouseLeave={() => dispatch({ type: 'rail-hover-end' })}
            style={{
              flex: 'none',
              width: MARKER_WIDTH,
              height: MARKER_HEIGHT,
              borderRadius: MARKER_RADIUS,
              background: marker.active ? MARKER_COLOR_ACTIVE : MARKER_COLOR_IDLE,
            }}
          />
        ))}
      </div>
      <PromptList
        items={items}
        hasMore={hasMore}
        loadingOlder={loadingOlder}
        state={state}
        dispatch={dispatch}
        listRef={listRef}
        t={t}
        onReveal={onReveal}
        onLoadOlder={onLoadOlder}
      />
    </div>
  )
}

interface PromptListProps {
  items: SessionNavigatorItem[]
  hasMore: boolean
  loadingOlder: boolean
  state: { activeKey: string | null; focusedIndex: number; expanded: boolean }
  dispatch: React.Dispatch<any>
  listRef: React.RefObject<HTMLDivElement>
  t: (key: string) => string
  onReveal: (nodeKey: string) => void
  onLoadOlder: () => void
}

function PromptList({ items, hasMore, loadingOlder, state, dispatch, listRef, t, onReveal, onLoadOlder }: PromptListProps) {
  return (
    <div
      ref={listRef}
      id="dsh-nux-prompt-list"
      data-dsh-nux="list"
      role="listbox"
      aria-label={t('navigator.list')}
      aria-hidden={!state.expanded}
      onMouseEnter={() => dispatch({ type: 'rail-hover-start' })}
      onMouseLeave={() => dispatch({ type: 'rail-hover-end' })}
      style={{
        position: 'absolute',
        right: 0,
        top: '50%',
        transform: state.expanded ? 'translateY(-50%)' : 'translate(6px, -50%)',
        width: LIST_WIDTH,
        maxHeight: 'min(58vh, 550px)',
        overflowY: 'auto',
        background: LIST_BACKGROUND,
        color: 'var(--dsw-alias-label-primary)',
        colorScheme: 'light dark',
        border: LIST_BORDER,
        borderRadius: LIST_RADIUS,
        boxShadow: LIST_SHADOW,
        padding: 7,
        backdropFilter: LIST_BACKDROP_BLUR,
        WebkitBackdropFilter: LIST_BACKDROP_BLUR,
        pointerEvents: state.expanded ? 'auto' : 'none',
        opacity: state.expanded ? 1 : 0,
        visibility: state.expanded ? 'visible' : 'hidden',
        transition: 'opacity 160ms var(--ds-ease-in-out, ease), transform 160ms var(--ds-ease-in-out, ease), visibility 0s linear ' + (state.expanded ? '0s' : '160ms'),
      }}
    >
      {hasMore && (
        <div
          data-dsh-nux="load-older"
          style={{
            margin: '0 2px 2px',
            padding: '2px 6px 4px',
            borderBottom: '1px solid var(--dsw-alias-border-l2, #e6e7e9)',
            borderRadius: 0,
            background: 'transparent',
          }}
        >
          <button
            type="button"
            data-dsh-nux-load-older-button
            disabled={loadingOlder}
            onClick={(event) => {
              event.stopPropagation()
              onLoadOlder()
            }}
            style={{
              display: 'inline',
              height: 'auto',
              alignItems: 'center',
              justifyContent: 'center',
              margin: 0,
              padding: '1px 0',
              border: 0,
              borderRadius: 0,
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              boxShadow: 'none',
              fontSize: 11,
              fontWeight: 400,
              opacity: loadingOlder ? 0.55 : 1,
              cursor: loadingOlder ? 'default' : 'pointer',
            }}
          >
            {loadingOlder ? t('navigator.loadingOlder') : t('navigator.loadOlder')}
          </button>
        </div>
      )}
      {items.length === 0 && (
        <div style={{ padding: 8, color: 'var(--dsw-alias-label-tertiary)' }}>{t('navigator.empty')}</div>
      )}
      {items.map((item, index) => (
        <div
          key={item.key}
          id={'dsh-nux-option-' + index}
          role="option"
          aria-current={item.key === state.activeKey ? 'location' : undefined}
          aria-selected={index === state.focusedIndex}
          data-dsh-nux-item={item.kind}
          onMouseEnter={() => dispatch({ type: 'item-focus', index })}
          onClick={(event) => {
            // Stop the click from bubbling to the rail, whose onClick toggles pin.
            event.stopPropagation()
            onReveal(item.key)
            dispatch({ type: 'item-click' })
          }}
          style={{
            padding: '6px 8px',
            borderRadius: 6,
            cursor: 'pointer',
            background: item.key === state.activeKey || index === state.focusedIndex
              ? 'var(--dsw-alias-interactive-bg-hover, #eef1f6)'
              : 'transparent',
            outline: 'none',
          }}
        >
          <div
            style={{
              fontSize: 13,
              color: 'var(--dsw-alias-label-primary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {item.preview}
          </div>
          {item.kind === 'steering' && (
            <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{t('navigator.steering')}</div>
          )}
        </div>
      ))}
    </div>
  )
}

export function applyNavigator(ctx: HarnessContext) {
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    'dsh-native-ux: locale dictionaries',
  )
  const t = ctx.locale.bind(NS)
  const sessions = ctx.get('sessions') as SessionsService | undefined
  // Reveal-highlight styles are adapter-owned (no CSS seam in harness).
  ctx.effect(() => {
    ensureHighlightStyles()
  }, 'dsh-native-ux: reveal highlight styles')
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.utilities',
        id: 'dsh-native-ux-navigator',
        order: 900,
        inject: () => ({ t, sessions }),
      },
      NavigatorAnchor,
    ),
  )
}
