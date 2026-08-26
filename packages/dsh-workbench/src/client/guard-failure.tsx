import type { GuardVerdict } from './guard.ts'

/**
 * The visible Startup-Guard failure surface (ARCH-02 / #25): rendered inside
 * the shell.overlay slot with `role="alert"` when the carrier's presentation
 * descriptor fails the compatibility verdict. It replaces the split-only
 * capacity and workspace-warning registrations; Navigator and compatible
 * non-presentation shortcuts remain available. It carries no DOM fallback.
 * The verdict's detected/supported
 * detail is shown verbatim (diagnostic); copy is localized through the
 * dsh-workbench namespace.
 *
 * The component closes over the verdict (stable for the app lifetime) and
 * receives `t` from the slot's standard kit (the registration declares
 * `locale: NS`).
 * @param verdict - the failed guard verdict to display.
 * @returns the overlay component (a factory so the verdict closes over the
 *   specific verdict instance rather than a prop).
 */
export function makeGuardFailureBanner(verdict: Extract<GuardVerdict, { disabled: true }>) {
  return function GuardFailureBanner({ t }: { t: (key: string) => string }) {
    const detail = (labelKey: string, value: string) => (
      <div>
        <span style={{ opacity: 0.7 }}>{t(labelKey)}</span>{' '}
        <code
          style={{
            fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
            fontSize: 12,
            padding: '1px 5px',
            borderRadius: 4,
            background: 'var(--dsw-alias-surface-l3, rgba(255,255,255,0.06))',
          }}
        >
          {value}
        </code>
      </div>
    )
    // The shell.overlay layer floats ABOVE the pane headers: the alert is
    // informational only (there is no Workbench feature to interact with on
    // failure), so it stays click-through (pointer-events: none).
    return (
      <div
        role="alert"
        className="dsw-workbench-guard-failure"
        data-guard-failure
        style={{
          pointerEvents: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
          margin: '12px auto 0',
          width: 'fit-content',
          maxWidth: 'min(720px, calc(100% - 32px))',
          padding: '10px 16px',
          borderRadius: 10,
          border: '1px solid var(--dsw-alias-border-l2, rgba(255,120,120,0.4))',
          background: 'var(--dsw-alias-surface-l2, #2a1e20)',
          color: 'var(--dsw-alias-text, inherit)',
          fontSize: 13,
        }}
      >
        <div style={{ fontWeight: 600 }}>{t('guard.title')}</div>
        {detail('guard.detected', verdict.detected)}
        {detail('guard.supported', verdict.supported)}
      </div>
    )
  }
}
