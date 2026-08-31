# Security statement

This statement covers the `0.2.0-rc.2` source preview.

## Runtime boundary

- Workbench adds no Host filesystem, subprocess, credential, or arbitrary network capability, except the single chat-preset seeding write below (product contract invariant 7).
- Chat-preset seeding is that one exception, and nothing else in Workbench writes to the Host filesystem:
  - The Host entry attempts it once per Host composition. Everything it can write lives under the resolved Harness home's user preset root, `$DSH_HOME/.agent-presets/` (`~/.dsh/.agent-presets/` when `DSH_HOME` is unset): the directory `chat/` holding `preset.yml` and `agent.cordis.yml`, and a sibling marker file `.workbench-chat-seeded`. No other path is ever written.
  - The seeded preset is the bundled zero-tool, conversation-only `chat` composition. Seeding it adds no subprocess, credential, or network capability.
  - Create-only. Only the existence of an existing `chat/` directory is probed; its contents are never opened, modified, or overwritten, and only the marker is added beside it when missing.
  - The marker makes seeding a one-time act. Once it exists and `chat/` does not, Workbench reads the absence as user intent and never re-creates the preset.
  - Seeding is fail-soft: any filesystem error degrades to a console warning and never blocks Host composition.
- It does not create telemetry or persist prompt, tool, or Session content outside Harness-owned storage.
- Panel Compatibility starts no observer until an explicit compatible provider registers.
- The Better Sidebar adapter uses a versioned Pane capability and public Pane host markers; it does not patch private stores or infer unknown DOM.

## Distribution boundary

- Both local package manifests are `private: true` to prevent accidental npm publication.
- The project publishes no upstream-named Harness or Better Sidebar npm package.
- The release bundle contains only the two Workbench TGZ files, SHA256 checksums, and a manifest pointing to pinned source commits.
- End-user source installation requires a user-approved full Workbench commit, detached checkout, and exact HEAD comparison before any repository code executes.
- Every executable pinned dependency checkout, including the Harness fork and optional Better Sidebar fork, must pass per-command error checks, exact HEAD comparison, detached-HEAD proof, and clean-worktree verification before its repository instructions run.
- Every supported bundle invocation requires a committed clean worktree, rebuilds both packages, and scans generated runtime before packing.
- The Workbench TGZ carries complete MIT notices for bundled Schemastery and Cosmokit code.
- No automatic or silent download or modification of a third-party package, ever. A user-consented, hash/commit-verified installation offered through a documented flow (`docs/INSTALL.md` §4's Better Sidebar consent ask) is the one narrow exception, and only on an explicit yes — it is neither automatic nor silent, and it never runs unprompted.
- GitHub Actions are disabled; local gates are authoritative.

## Disclosure

Use GitHub private vulnerability reporting. Public issues must not include credentials, proprietary source, private Session transcripts, or exploitable details before remediation is available.
