# Security statement

This statement covers the `0.2.0-rc.2` source preview.

## Runtime boundary

- Workbench adds no Host filesystem, subprocess, credential, or arbitrary network capability.
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
