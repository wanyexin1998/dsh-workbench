# DSH Workbench 0.2.0-rc.3

Status: source preview. Distribution is source plus a downloadable GitHub
Release (two TGZs, two bootstrap scripts, `SHA256SUMS`, `release-manifest.json`),
SHA256-verified, not GPG-signed. No npm package.

**Upgrading from `0.2.0-rc.2` re-pins the Harness fork.** The bootstrap
installer now checks out `82de604afc683cd8c7692d0736f26f9ebc0f1823` on
`feat/toggle-settings-verb` instead of `1a8cf5ba…` on
`fix/plugin-spec-quoting`. The new commit is a direct child of the old one, so
it carries the `rc.2` Windows spaces-in-path fix forward; what it adds is
`ctx.layout.toggleSettings()`. Installing over an existing bootstrap target is
not supported — remove the target and run the installer again.

## Added

- **Quoted passages are now marked where they live.** "Add to conversation"
  used to repeat every quoted passage in a dock above the composer, putting the
  same text on screen twice and growing the dock with each addition. The
  passage is now marked in the conversation itself — a tinted band with an
  underline, and a numbered badge in the margin beside it — and the composer
  keeps only a numbered chip. The marking is painted through the browser's CSS
  Custom Highlight API: Workbench hands the browser a `Range` and inserts
  nothing into the Harness DOM. Works on stock Harness.
- **Every quote can carry a note, typed where the quote is.** Adding a quote
  opens a comment card beside the passage with the caret already in it, so the
  gesture is select, add, type. Leaving the card saves what you wrote; so do
  the close button and `Esc`. Delete removes the quote in one click. After the
  card closes nothing is parked beside the paragraph covering the text
  underneath — hover the numbered badge to peek at the note, click it to edit,
  or open the quote list from the composer chip.
- **The Settings shortcut can now close Settings, not just open it.** On the
  newly pinned Harness fork the action reads "Toggle settings" and the same
  chord dismisses the panel it opened. A host still on the previous pin keeps
  the open-only verb and its "Open settings" label; stock Harness registers no
  Settings action at all. The plugin prefers the new verb and falls back, so no
  host breaks.

## Fixed

- **Open Settings shipped with a default chord that could not be pressed.**
  `Primary+Space` is the language-toggle hotkey of most Chinese IMEs on Windows
  and Spotlight's chord on macOS, so the keystroke was taken before the page
  ever saw it: the action registered, the handler was correct, and pressing the
  keys did nothing at all. The default is now `Primary+,`. Anyone who had
  rebound the action keeps their own chord — only untouched defaults move.
  `Primary+Space` now carries a warning in Settings explaining why a chord
  bound to it may never arrive.
- **Selections put internal protocol markup in front of the reader.** Side chat
  opened with a `<selected_context>` tag carrying session ids, node keys,
  sequence numbers and character offsets, and Add to conversation reached the
  same shape at submit time. Nothing downstream read those identifiers, so they
  were noise to the model and a leak to the user. A quote is now plain text: a
  prose heading, the quoted text with a `│ ` gutter on every line, and the note
  on a `↳ ` line. The HTML escaping went with the tags, so a quote of
  `Tom & Jerry` no longer arrives as `Tom &amp; Jerry`.
- **The selection toolbar and reference dock did not follow the theme.** They
  set geometry but no colour and fell through to the browser's default buttons,
  staying light in dark mode. Both now use the host's own design tokens, taking
  their separation from shadow in light mode and from a border in dark.
- **A reply streaming in the other Pane re-resolved every quote anchor on every
  frame**, because the mutation observer watched character data across the whole
  conversation. It now filters to mutations that can affect an anchored row.
  Scrolling separately rebuilt the highlight registry every frame despite a
  comment claiming otherwise; it now publishes only when the ranges really
  change.
- **A saved note stayed parked beside the passage, covering the next
  paragraph.** Its landing point is computed directly under the passage's last
  line, which is normally the following text. The collapsed state now parks
  nothing at all. Removing the pinned state alone was not enough: the hover
  preview is a latch that only a later pointer event clears, and it was armed
  even while a card was open, hidden behind the render gate — so a save opened
  the gate and the note appeared with no pointer having moved. Arming now
  requires that nothing is open.
- **The default install path never stated that it needs `dsh` on `PATH`.** A
  reader with no Harness got through the download and the checksum and met a
  raw `CommandNotFoundException` on the third command, with nothing in the
  repository explaining how to get one. `docs/INSTALL.md` now states the
  prerequisite before the commands and points anyone without Harness at the
  bootstrap path.

## Documentation

The doc set was audited against the code rather than against itself, which
turned up a class of error no release gate was watching for:

- The compatibility table in both READMEs paired the fork branch
  `feat/toggle-settings-verb` with `1a8cf5b…`, that branch's *parent* — so a
  reader who pinned what the table said got a Harness without
  `toggleSettings()`. The pin advance had updated the branch name and left the
  hash. Nothing compared either against `release-contract.json`; that check now
  exists (see below).
- Neither README described the quote surface a user now literally sees in their
  conversation. Both now do, including the guarantee that the host DOM is never
  mutated — previously written down only in a source comment.
- `docs/PRODUCT_CONTRACT.md` said More Details sends "escaped selected
  context". It has not for several commits.
- The Windows end-to-end evidence in `docs/COMPATIBILITY_MATRIX.md` and
  `docs/KNOWN_ISSUES.md` was gathered against the `rc.2` installer, which
  pinned a different Harness commit. Both now say so, and say plainly that the
  `rc.3` installer has not been re-run. Three checks that have never run on any
  platform were listed as "targeted for `v0.2.0-rc.2`"; they are now listed as
  outstanding work rather than as a plan attached to a release that shipped.

## Release gates

Two releases in a row shipped a stale version string or commit hash with all
nine gates green, because no gate compared a document against the release
contract. Three checks now close that class:

- `scripts/release-contract-check.mjs` sweeps every user-facing document for
  version strings and pinned commit hashes and fails on any that disagrees with
  `release-contract.json`. Deliberate historical references are declared in a
  visible allowlist that names the file and the reason, so an exemption cannot
  be granted silently.
- `scripts/build-release-bundle.mjs` fails if either bootstrap installer's
  embedded Workbench TGZ digest, version, or release URL disagrees with the
  artifact it just packed.
- `scripts/bootstrap/bootstrap.test.mjs` asserts both installers' embedded
  `WORKBENCH_VERSION` and release URL against the contract. That assertion had
  been written as a deferred TODO because the contract used to lag the scripts.

## Distribution boundary

The repository is public source, not an official DeepSeek Harness
distribution. Forked Harness and Better Sidebar packages retain their original
names and must not be republished under upstream package namespaces. The
Harness pin (`feat/toggle-settings-verb`,
`82de604afc683cd8c7692d0736f26f9ebc0f1823`) is public and independently
verifiable at https://github.com/wanyexin1998/deepseek-harness, and is tagged
`dsh-workbench-v0.2.0-rc.3-pin` so it stays reachable if the branch moves.
Panel Compatibility (`0.1.0-rc.1`) is unchanged this release.

---

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
