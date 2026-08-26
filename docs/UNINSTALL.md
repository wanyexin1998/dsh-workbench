# Uninstall

Remove the optional compatibility package first, then Workbench:

```powershell
dsh plugin --profile web remove @wanyexin1998/dsh-workbench-panel-compat
dsh plugin --profile web remove @wanyexin1998/dsh-workbench
```

Workbench never owns an independently installed Better Sidebar fork and does not remove it.

Uninstalling does not delete Harness Sessions, Workspaces, settings files, or other profile dependencies. The browser preference `dsh.ui.sessionPanes.splitRatio` may be removed separately from the Harness site's browser storage.

No carrier removal or legacy installer command applies to this source preview.
