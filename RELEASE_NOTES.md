# DSH Workbench 0.2.0-rc.4

Status: source preview. Distribution is source plus a downloadable GitHub
Release (two TGZs, two bootstrap scripts, `SHA256SUMS`, `release-manifest.json`),
SHA256-verified, not GPG-signed. No npm package.

> **A first cut of this tag was published and withdrawn on 2026-09-07.** It
> installed cleanly and then did nothing: the client entry declared the
> `remote` service without the `remote.session` namespace it dereferences, so
> cordis refused the lookup, the plugin's only apply entry threw, and the
> fail-soft catch swallowed it — no shortcuts, no Ask, no settings section, no
> Split Pane, and no error beyond one console warning. The isolated
> end-to-end run below is what found it. If you installed the withdrawn build
> (TGZ digest `5bdaf6b2…`), reinstall: this release carries the fix, and its
> digest differs.

**Upgrading from `0.2.0-rc.3` re-pins the Harness fork onto a newer upstream.**
The bootstrap installer now checks out
`c5a387cd2f781d4d9914ea0271ebb507984ca3f4` on `rc4/presentation-on-0.1.2`,
whose base is upstream `0.1.2-rc.1`
(`a66e4702047846cdaa10c66c9d3df3951f5ea70d`) rather than `0.1.1-rc.2`. The
presentation work was rebuilt on the new baseline rather than rebased onto
it: upstream moved the packages it touched. Installing over an existing
bootstrap target is still not supported, and because deleting the target
would take its Sessions with it, the upgrade steps are written out in
[`docs/INSTALL.md` § Upgrading from `v0.2.0-rc.3`](docs/INSTALL.md#upgrading-from-v020-rc3).
That pin advance performs no irreversible change to your data: the Session
log format is v0 on both sides and the projection cache is rebuilt from the
records, so old cache files are ignored rather than migrated. Format v2
exists only in upstream `0.1.3-alpha.1`, which this release does not pin.

## Added

- **The plugin now targets upstream Harness `0.1.2-rc.1`.** Every host peer
  moves to that baseline, and the client types follow upstream to their new
  homes: the `client/runtime` package is gone (its declarations now live in
  Cordis and `dsh-session/types`), and the chat half of `ui-conversation`
  moved into a new `ui-chat` package. The Workbench guard's
  `SUPPORTED_HARNESS` names the new version, and the contract check now
  compares that literal against the release contract rather than only
  checking the protocol number.
- **Fresh chat reaches the host through `ctx.remote`.** `connection.api.*`
  no longer exists in the `0.1.2-rc.1` client, so the Session-create call
  moved to `ctx.remote.session.create()` and `remote` replaced `connection`
  in the inject list — the gate now refuses to start without the service the
  action actually uses. The call shape follows the generated descriptor: one
  request object, and a `RemoteResult` returned directly instead of the old
  `{ result }` envelope. The error path is unchanged.
- **The Settings verb travels with the pin.** On the newly pinned fork the
  action still reads "Toggle settings" and the same chord dismisses the
  panel. A host on the `v0.2.0-rc.2` pin keeps the open-only verb and its
  "Open settings" label; stock Harness registers no Settings action at all.

## Changed

- **The Navigator rail is retired.** Upstream `0.1.2-rc.1` ships its own
  `TurnNavigator`, and it is better than ours in three ways that matter: it
  is mounted inside each `ChatView`'s scroll container, so there is one rail
  per Pane rather than one for the window; it carries a hover and focus
  preview of the turn it points at; and it covers turns the Pane has not
  loaded yet. That last one ours could never do — it only ever indexed DOM
  the host had already rendered, so scrolling back through history reached a
  rail that silently ended where virtualization did. With both rails drawn
  into the same gutter, keeping ours would only have stacked a weaker set of
  markers on a stronger one. The whole module goes, along with the core
  projections that existed only to feed it, and the `Primary+Shift+O` chord
  it used is released. The seams the selection layer shares with it are
  unchanged.
- **Quote badges and note cards now keep clear of the host's rail.** That
  `TurnNavigator` is sticky against the right edge of the same scroll
  container the badge placement measures against, so a badge for a quote
  whose text runs to the band edge used to land underneath it, and the much
  wider note card reached into it from several column positions. Workbench
  now holds a fixed reserve at that edge. It is a constant, not a
  measurement: upstream's rail carries no `data-*` attribute or role to
  detect, and sniffing for it by class name would break on the next
  refactor.

## Fixed

- **Empty client module graph on Node `24.0`–`24.11.1`.** On those versions
  every plugin's client half silently failed to mount, behind swallowed or
  warn-level errors. The cause was upstream: those Node builds report major
  24 while still carrying the v1 internal module-loader API, and the shim
  classified by major version, so `resolveSync` was called with reversed
  parameters and every call threw. Upstream fixed it in `0.1.2-rc.1` by
  classifying the loader by which module-job API it owns; this release picks
  that up through the pin advance. Not reproduced locally — the fix is taken
  on the upstream fork's own record of it.
- **`Primary+Shift+C` created a new Session on every press instead of
  continuing today's blank one.** The rc.4 migration had recorded same-day
  blank-chat reuse as permanently dead, on the reading that the host had
  deleted `SessionSummary.agentPreset`. Re-reading the `0.1.2-rc.1` source
  shows the signal was not deleted but moved: the preset is now a session
  projection value, read as `projectionValues.agentPreset`, which is how
  upstream reads it itself. The filter left in place as a fail-closed
  degradation was therefore not fail-closed at all — the field was always
  `undefined`, so the condition was always true.
- **`Primary+Shift+C` from the home state always ended at the "no workspace"
  notice.** The zero-Pane fallback tier had been recorded as dead for the
  same reason, because `0.1.2-rc.1` stopped projecting
  `WorkspaceListState.recentWorkspaceId`. That signal moved too: the host
  projects each Workspace's own `updatedAt` and trusts it as a timestamp,
  and upstream's own sidebar ranks by recency the same way. **One behaviour
  is deliberately widened here**: when the source Workspace is not in the
  list, the chain used to stop, and now falls through to this third tier.
  The judgement also differs slightly from the retired field's —
  `recentWorkspaceId` meant most recently *active*, `updatedAt` means most
  recently *mutated*, and renaming a Workspace counts as a mutation — so the
  two disagree if you are chatting in one Workspace having just renamed
  another. For the question this tier asks, only when there is no focused
  Session to ask instead, answering is worth more than the tier being inert.
  A row whose `updatedAt` does not parse is skipped rather than sorted as
  zero, and the chain stays fail-closed on a narrower condition: no
  Workspaces at all, or no parseable timestamp among them, still resolves
  nothing.

- **The published TGZ digest was not reproducible.** Packing the same commit
  in two checkouts of this repository produced two different digests. The
  only difference was line endings: `THIRD_PARTY_NOTICES.md` was LF in one
  and CRLF in the other, and `cordis.patch.yml` differed by a single CR.
  `core.autocrlf=true` leaves the working-tree bytes to each checkout, npm
  pack reads the working tree, and `.gitattributes` pinned only the bootstrap
  scripts. That broke two promises at once: the installers embed a digest of
  the TGZ, so which checkout packed the release decided whether any rebuild
  matched it, and `docs/INSTALL.md` § Advanced tells auditors to build from
  source and compare against the published hash, which could not succeed
  while the bytes depended on the machine. Every git-tracked file that enters
  a published TGZ is now pinned to LF, and the fix is verified the way the
  bug was found: two checkouts at the same commit now pack byte-identical
  artifacts.

## Release gates

Three gates grew this release, each kill-tested against the mistake it is
meant to catch before being kept:

- The bootstrap suite stopped hardcoding the pinned commit and reads it from
  `release-contract.json`, so advancing the pin cannot leave its "appears
  exactly once" sweep counting a previous release's hash. It also asserts
  both installers embed `harness.upstreamCommit` — the install-chain audit
  found that was the one contract field no check read.
- The contract check compares the client guard's `SUPPORTED_HARNESS.version`
  against `harness.upstreamVersion`, and its pinned-commit scan now covers
  `e2e/harness-web/README.md`.
- A peer loop written to mirror the Workbench one turned out to iterate zero
  times, because the compatibility package has no `@deepseek-ai/dsh` peers.
  It stays for the day it does, but the field that actually moved this
  release is guarded instead: both packages must declare the same
  `@deepseek-ai/cordis` range.
- The client entry's inject list is now derived from the code rather than
  asserted against a hand-written one. The withdrawn build had a green test
  asserting the list contained `remote`, which was true and useless; the new
  one scans the package's sources for every `ctx.remote.<namespace>` actually
  dereferenced and requires the matching `remote.<namespace>`. The ctx test
  double was also more permissive than a real host — it returned `undefined`
  for every service — so it went green on a build that dies on boot. It now
  models cordis's rule and throws the same way.

## Verified

`pnpm release:check`, all nine steps, on the release commit:

| Step | Result |
| --- | --- |
| `scan-secrets.mjs` | high-confidence secret/privacy scan passed |
| `release-contract-check.mjs` | 53 checks, all passed |
| `scan-secrets.test.mjs` | 67 / 67 |
| `install/result.test.mjs` | 47 / 47 |
| `bootstrap/bootstrap.test.mjs` | 33 / 33 |
| `pnpm typecheck` | passed |
| `pnpm test` | 663 / 663 across 36 files |
| `pnpm audit --audit-level=low` | no known vulnerabilities |
| `build-release-bundle.mjs` | four artifacts packed, `SHA256SUMS` written |

The package suite is 663 where rc.3 was 714: the Navigator retirement took
its own tests with it, and the inject contract added three back.

`SHA256SUMS` describes the stamped installers, and the digest they embed
(`DIGEST_PLACEHOLDER`) is the digest of the TGZ packed beside them.
`release-manifest.json` records the release commit. That digest was also
reproduced from a second checkout at the same commit, byte for byte, for
both packages.

**Isolated end-to-end, Windows.** The published
`dsh-workbench-bootstrap.ps1` was downloaded from this release, verified
against the published `SHA256SUMS`, and run against a clean target whose
path contains a space, with no `-TgzSha256` argument. It reported
`state: installed` / exit 0. Independently confirmed afterwards: the Harness
checkout sits detached at the pinned commit with a clean worktree, the
downloaded TGZ digest equals the published one, the generated launcher is
self-relative, and the real `~/.dsh` was untouched. Launched from that
launcher, the client boot graph carries `@wanyexin1998/dsh-workbench`, the
console is clean, and Settings shows the Workbench's own shortcut section
with its chords and Chinese strings — including "open or close settings",
which is the pin's toggle verb being detected.

Unlike the `v0.2.0-rc.2` run, this one cloned from GitHub directly rather
than from a local mirror, so GitHub reachability is evidenced here. One
attempt failed first on a transport reset; the installer failed closed with
a valid result JSON and exit 1, and the retry succeeded.

**Still not verified.** Split Pane itself (Ctrl/Command-click for a second
pane), quote-badge placement against the host's turn rail, and whether the
Settings chord actually toggles when pressed — the first two need a
configured model to create sessions, which the isolated home has none of,
and the third could not be driven through the automation surface, so only
its registration is evidenced. macOS, read-only `$DSH_HOME`, and the
stock-Harness general-plugin path remain unrun on every platform. See
[`docs/COMPATIBILITY_MATRIX.md`](docs/COMPATIBILITY_MATRIX.md) § Platform
support.

## Distribution boundary

The Harness pin (`rc4/presentation-on-0.1.2`,
`c5a387cd2f781d4d9914ea0271ebb507984ca3f4`) is public and independently
auditable; the tag `dsh-workbench-v0.2.0-rc.4-pin` marks it so a published
installer keeps resolving. The `v0.2.0-rc.2` and `v0.2.0-rc.3` pin tags and
their branches stay in place — those installers are still out there. Panel
Compatibility moves to `0.1.0-rc.2`: its TGZ bytes changed with the peer
list and the cordis floor, and `0.1.0-rc.1` already names a published
digest. The Better Sidebar fork is unchanged.

## Upgrading

See [`docs/INSTALL.md` § Upgrading from `v0.2.0-rc.3`](docs/INSTALL.md#upgrading-from-v020-rc3).
The installer refuses a target that already exists, and deleting the target
would take its isolated Harness home — every Session, Workspace and model
setting created inside it — along with it, so move that home aside first.

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

## Verified

Measured on the `0.2.0-rc.3` release run, not carried over:

- Package unit tests: 42 files / 714 passing (`dsh-workbench` 40/707,
  `dsh-workbench-panel-compat` 2/7). `tsc --noEmit` clean. The rc.2 note said
  36 files / 515; that figure was stale by roughly two releases of work.
- Installer script tests: 32/32 (was 31 — the deferred installer-version
  assertion is now one of them). Install-result contract tests: 47/47.
  Secrets-scanner unit tests: 67/67.
- `node scripts/release-contract-check.mjs`: 52 checks, all passing (was 50 —
  the document version and pinned-commit sweeps are the two new ones).
- `pnpm release:check` is 9 steps and exits 0.
- The packed Workbench TGZ hashed identically across the release's two bundle
  passes. Those passes ran from different commits, differing only in the
  installer scripts, which are outside the package's `files` list — which is
  precisely what makes the stamp-then-rebuild loop terminate rather than chase
  its own tail.
- Both installers' embedded TGZ digest, version, and release URL are asserted
  against the packed artifact by the bundler itself. The unflagged build failed
  on the stale rc.2 digest before it was stamped, which is the check doing its
  job on its first real release.

Not verified, and unchanged from rc.2: no isolated end-to-end run has been
performed for this release on any platform. The only such run that has ever
happened exercised the rc.2 installer, which pinned a different Harness commit.
See `docs/COMPATIBILITY_MATRIX.md` § Outstanding verification.

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
