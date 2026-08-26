// Local ambient declaration: @types/react-dom could not be installed in
// this offline-ish registry setup; only createPortal is used.
declare module 'react-dom' {
  export function createPortal(children: unknown, container: Element, key?: string): any
}
