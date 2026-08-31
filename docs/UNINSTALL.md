# Uninstall

Two install paths exist (see [`docs/INSTALL.md`](INSTALL.md)); each has its own uninstall.

## General plugin (stock Harness)

**Only if you installed the optional compatibility package**, remove it first. It is **not** installed by default — it exists only if you worked through the consent-gated optional-panels section of [`docs/INSTALL.md`](INSTALL.md):

```powershell
dsh plugin --profile web remove @wanyexin1998/dsh-workbench-panel-compat
```

Skip that command otherwise. Running it when the package was never installed does no damage, but it fails loudly rather than doing nothing: `dsh plugin` is a thin forwarder to `pnpm`, and pnpm 11 answers a missing dependency with `[ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS] Cannot remove '...': project has no dependencies of any kind` and exit code 1.

Then remove Workbench itself:

```powershell
dsh plugin --profile web remove @wanyexin1998/dsh-workbench
```

Workbench never owns an independently installed Better Sidebar fork and does not remove it.

Uninstalling does not delete Harness Sessions, Workspaces, settings files, or other profile dependencies. The browser preference `dsh.ui.sessionPanes.splitRatio` may be removed separately from the Harness site's browser storage.

It also does not delete the seeded chat preset — Workbench's only write outside its own package, and the single sanctioned exception to product-contract invariant 7 (see [`docs/PRODUCT_CONTRACT.md`](PRODUCT_CONTRACT.md) "Chat preset seeding"). Two paths remain after removal:

- `$DSH_HOME/.agent-presets/chat/` — the bundled zero-tool **聊天模式 / Chat mode** preset (`preset.yml`, `agent.cordis.yml`).
- `$DSH_HOME/.agent-presets/.workbench-chat-seeded` — the sibling marker recording that seeding already happened.

`$DSH_HOME` is `~/.dsh` only when the variable is unset; on the bootstrap path below it is `<target>/home`. To clear the residue, delete the `chat/` directory and **leave the marker in place**: Workbench reads "marker present, directory absent" as your deletion and never re-seeds (`packages/dsh-workbench/src/preset-seed.ts`). Deleting the marker as well is also fine once Workbench is uninstalled — nothing is left to run the seeder — but if Workbench is still installed, a missing marker makes the next Host start seed the preset again.

No carrier removal or legacy installer command applies to this source preview.

## Split pane (bootstrap)

Uninstall is a single step: delete the `<target>` directory the bootstrap installer was given (default: Windows `%USERPROFILE%\dsh-workbench`, macOS `$HOME/dsh-workbench`). By construction every file the installer ever wrote — the launcher, the patched Harness fork checkout, and the isolated `DSH_HOME` (profiles, Sessions, settings, and the seeded `chat` preset described above) — lives under that one root, so deleting it removes the bootstrap install completely.

The official Harness install is never touched by the bootstrap installer or by this uninstall step — it keeps running exactly as it did before, on its own `~/.dsh` (or `%USERPROFILE%\.dsh`) and its own `dsh` launcher. The only thing the bootstrap installer writes outside `<target>` is its own use of your package manager's global store/cache (`pnpm`'s), which `pnpm` owns and manages independently of any single install; this uninstall step does not attempt to touch that shared store.
