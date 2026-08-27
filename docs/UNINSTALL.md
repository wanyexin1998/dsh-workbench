# Uninstall

Two install paths exist (see [`docs/INSTALL.md`](INSTALL.md)); each has its own uninstall.

## General plugin (stock Harness)

Remove the optional compatibility package first, then Workbench:

```powershell
dsh plugin --profile web remove @wanyexin1998/dsh-workbench-panel-compat
dsh plugin --profile web remove @wanyexin1998/dsh-workbench
```

Workbench never owns an independently installed Better Sidebar fork and does not remove it.

Uninstalling does not delete Harness Sessions, Workspaces, settings files, or other profile dependencies. The browser preference `dsh.ui.sessionPanes.splitRatio` may be removed separately from the Harness site's browser storage.

No carrier removal or legacy installer command applies to this source preview.

## Split pane (bootstrap)

Uninstall is a single step: delete the `<target>` directory the bootstrap installer was given (default: Windows `%USERPROFILE%\dsh-workbench`, macOS `$HOME/dsh-workbench`). By construction every file the installer ever wrote — the launcher, the patched Harness fork checkout, and the isolated `DSH_HOME` (profiles, Sessions, settings) — lives under that one root, so deleting it removes the bootstrap install completely.

The official Harness install is never touched by the bootstrap installer or by this uninstall step — it keeps running exactly as it did before, on its own `~/.dsh` (or `%USERPROFILE%\.dsh`) and its own `dsh` launcher. The only thing the bootstrap installer writes outside `<target>` is its own use of your package manager's global store/cache (`pnpm`'s), which `pnpm` owns and manages independently of any single install; this uninstall step does not attempt to touch that shared store.
