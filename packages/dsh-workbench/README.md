# @wanyexin1998/dsh-workbench

Source-preview DeepSeek Harness Web plugin providing two visible Session Panes, a per-Pane conversation Navigator, Same Workspace Warning, and configurable localized shortcuts.

## Compatibility

Requires the exact Harness fork and Presentation protocol 2 revision recorded in the repository root `release-contract.json`. Stock Harness `0.1.1-rc.2` does not expose this interface, so Split Pane fails closed there.

For end-user source installation, establish a user-approved detached Workbench commit through the root [`docs/INSTALL.md`](../../docs/INSTALL.md) flow before running any command below. Contributors may run source they authored or reviewed on top of that trusted baseline.

## Build

```powershell
pnpm install --frozen-lockfile
pnpm --filter @wanyexin1998/dsh-workbench typecheck
pnpm --filter @wanyexin1998/dsh-workbench test
pnpm --filter @wanyexin1998/dsh-workbench build
```

Use the repository root `pnpm bundle` command to rebuild from a committed clean worktree, scan generated runtime, and create an installable local TGZ with SHA256 metadata. The package is marked private to prevent accidental npm publication.

The Host bundle embeds Schemastery and Cosmokit. Their complete MIT notice ships in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Behavior

- Ctrl/Command-click opens a listed Session beside the focused Pane.
- Ordinary click replaces the focused Pane.
- Focus changes preserve Pane order and component identity.
- Navigator markers correspond exactly to human input events.
- Shortcut names follow the Harness global Simplified Chinese or English locale.
- Pane-local panels are optional and supplied by `@wanyexin1998/dsh-workbench-panel-compat`.

## Limitations

- Maximum two visible Panes.
- Multi-Pane membership is process-local.
- Addressed subagent children retain replace behavior.
