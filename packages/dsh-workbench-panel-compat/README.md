# @wanyexin1998/dsh-workbench-panel-compat

Optional explicit adapters connecting compatible panel providers to the right and bottom hosts of each visible Workbench Session Pane.

The package does not install, update, remove, or download a panel provider. Without a compatible provider it starts no Pane observer and changes no DOM, layout, or styles.

## Better Sidebar

The included adapter requires the pinned downstream Better Sidebar 0.16.1 source revision recorded in the repository root `release-contract.json`, exposing Pane capability protocol 1.

Stock Better Sidebar 0.16.1 has no multi-instance Pane capability. In that configuration this package leaves its global behavior unchanged.

## Lifecycle

- One attachment and store per Session Pane.
- Focus changes route unscoped commands without mounting or closing panels.
- Both Panes may show independent right and bottom panels simultaneously.
- Provider attach failures are contained per Pane.

The package is marked private to prevent accidental npm publication; the repository root `pnpm bundle` command rebuilds and scans generated runtime before creating a local TGZ.
