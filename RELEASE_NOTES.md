# DSH Workbench 0.2.0-rc.2

Status: source preview. Distribution is source plus a downloadable GitHub
Release (two TGZs, two bootstrap scripts, `SHA256SUMS`, `release-manifest.json`),
SHA256-verified, not GPG-signed. No npm package.

## Fixed

- **The installer scripts did not run at all.** Both bootstrap scripts called
  `pnpm exec dsh` in ten places, but that bin does not exist — `apps/cli` is
  not a root dependency, so pnpm never links it — and every run failed with
  `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`. They now call the repository's own
  root script, `pnpm dsh`, with a tripwire test guarding against a regression.
- **A path containing a space broke installation on Windows.** The Harness
  CLI's `dsh plugin` forwarder runs with `shell: true` on Windows without
  quoting its arguments, so `cmd.exe` split a `file:` path at the first
  space. The default install target, `%USERPROFILE%\dsh-workbench\downloads\`,
  hits this whenever the Windows username contains a space, failing with an
  `ENOENT` against a truncated path. Fixed in the pinned Harness fork
  (`fix/plugin-spec-quoting`, commit `1a8cf5ba416246f22d9526a917af5fb233170c58`).
  Stock Harness does not carry this fix; see `docs/INSTALL.md` and this
  README for the warning.
- **Workbench Ask (`Primary+Shift+C`) silently did nothing with no current
  Session** — reliably reproducible right after using the new-Session
  shortcut. It now falls back to the host's most recent Workspace, and shows
  the user a message instead of only logging to the console when no
  Workspace can be resolved at all.
- **`Alt+Q` (switch to previous Session) never fired on macOS.** Option
  synthesizes `key` into `œ`, not `q`, while the binding matched on `q` — so
  Settings showed "bound to ⌥Q" while the chord silently did nothing. Chords
  that include Alt are now derived from `event.code`, which is consistent
  across platforms.
- **An action bound only to its shipped default could never be unbound.**
  The Settings "Clear" control required an existing override, so an action
  still on its default (e.g. sidebar toggle's browser-reserved `Primary+B`)
  had both Clear and Reset greyed out — there was no way to free a reserved
  key without first recording a throwaway chord.
- **`Primary+Shift+C` collides with the DevTools "Inspect element" shortcut**
  in every major browser. Settings now surfaces the same browser-reserved
  warning this action already showed for the new-Session/new-window
  collision. The default chord itself is unchanged.
- **Workbench Ask waited a full second before showing the stock-Harness
  degradation notice**, even though the composer-focus probe it was waiting
  on can never succeed on stock Harness. It now shows immediately.
- **The compatibility guard's verdict was not enforced everywhere.** When the
  host's Presentation face failed the startup guard, side chat and Workbench
  Ask still treated it as protocol-2-capable — a click could fork a child
  Session and replace the source Pane. The guarded-incompatible state is now
  invisible to every downstream module, matching stock behavior exactly.
- **The security statement undersold an actual filesystem write.** It claimed
  no added Host filesystem capability, but the Host entry seeds the bundled
  `chat` agent preset into `$DSH_HOME/.agent-presets/` (create-only, never
  overwrites, never re-creates after user deletion). Wording now matches
  `docs/PRODUCT_CONTRACT.md`.

## Verified

- Package unit tests: 36 files / 515 passing; `tsc --noEmit` passes clean.
- Installer script tests: 31/31. Install-result contract tests: 47/47.
- New: secrets-scanner unit tests, 67/67 — previously that scanner shipped
  with zero test coverage of its own, so a broken rule would have gone
  unnoticed.
- `pnpm release:check` is now 9 steps (adds the scanner unit-test step).
- TGZ packing is reproducible: two builds from the same source produce
  byte-identical hashes.
- Both TGZ SHA256 values are recorded in `dist/SHA256SUMS`; the general
  plugin installer scripts embed the Workbench TGZ hash directly.

## Distribution boundary

The repository is public source, not an official DeepSeek Harness
distribution. Forked Harness and Better Sidebar packages retain their
original names and must not be republished under upstream package
namespaces. The Harness pin (`fix/plugin-spec-quoting`,
`1a8cf5ba416246f22d9526a917af5fb233170c58`) is public and independently
verifiable at https://github.com/wanyexin1998/deepseek-harness. Panel
Compatibility (`0.1.0-rc.1`) is unchanged this release.

---

# DSH Workbench 0.2.0-rc.1

Status: source preview. No npm package or automatic installer is published.

## Included

- Two visible Session Panes over Harness Session Presentation protocol 2.
- Stable `visible` membership and independent `focused` interaction ownership.
- Explicit SessionProvider binding, Pane-local right/bottom panel hosts, and focus-safe lifecycle teardown.
- Conversation Navigator with one precise marker per human input.
- Host-backed shortcuts with Simplified Chinese and English names.
- Optional Better Sidebar 0.16.1 Pane protocol 1 adapter.

## Verified

- Workbench: 180 tests, typecheck, build, and TGZ pack.
- Panel Compatibility: 7 tests, typecheck, build, and TGZ pack.
- Harness fork: 748 focused tests and 5 capacity-2 assembled Web snapshot tests.
- Dependency audit: no known vulnerabilities in the two distributed source packages at verification time.

## Distribution boundary

The repository is public source, not an official DeepSeek Harness distribution. Forked Harness and Better Sidebar packages retain their original names and must not be republished under upstream package namespaces.

End-user source installation requires a user-approved full Workbench commit and detached HEAD verification before repository code executes. Pinned Harness and optional Better Sidebar checkouts receive the same error, HEAD, detached, and clean-worktree verification before their instructions run. The Workbench TGZ includes the complete MIT notice for its bundled Schemastery and Cosmokit code.
