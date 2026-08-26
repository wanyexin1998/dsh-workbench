// T2 — rail marker compression (PRD §8.1 / tech design §9.3).
// Pure UI mapping: never mutates the node index.

export interface RailMarker {
  /** Index into the navigator items array. */
  readonly nodeIndex: number
  /** Pixel offset from the rail midpoint. */
  readonly offset: number
  readonly active: boolean
}

export const RAIL_MARKER_GAP = 10

/**
 * Map item count to rail markers.
 * Every human input keeps one fixed-gap marker. Long histories may scroll
 * inside the marker cluster; this projection never samples or merges inputs.
 */
export function railMarkers(
  count: number,
  activeIndex?: number,
): RailMarker[] {
  if (count <= 0) return []
  if (count === 1) {
    return [{ nodeIndex: 0, offset: 0, active: activeIndex === 0 }]
  }
  return Array.from({ length: count }, (_, nodeIndex) => ({
    nodeIndex,
    offset: (nodeIndex - (count - 1) / 2) * RAIL_MARKER_GAP,
    active: activeIndex === nodeIndex,
  }))
}
