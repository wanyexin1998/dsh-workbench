// Seam A pure-logic sample (the real business rules land in T2).
// This predicate is already the product's canonical filter.
export type HumanInputKind = 'user' | 'steering'

export function isHumanInputKind(kind: unknown): kind is HumanInputKind {
  return kind === 'user' || kind === 'steering'
}
