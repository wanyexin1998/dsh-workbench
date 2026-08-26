# Security statement

This statement covers the `0.2.0-rc.1` source preview.

## Runtime boundary

- Workbench adds no Host filesystem, subprocess, credential, or arbitrary network capability.
- It does not create telemetry or persist prompt, tool, or Session content outside Harness-owned storage.
- Panel Compatibility starts no observer until an explicit compatible provider registers.
- The Better Sidebar adapter uses a versioned Pane capability and public Pane host markers; it does not patch private stores or infer unknown DOM.

## Distribution boundary

- Both local package manifests are `private: true` to prevent accidental npm publication.
- The project publishes no upstream-named Harness or Better Sidebar npm package.
- The release bundle contains only the two Workbench TGZ files, SHA256 checksums, and a manifest pointing to pinned source commits.
- No automatic installer downloads or modifies third-party packages.
- GitHub Actions are disabled; local gates are authoritative.

## Disclosure

Use GitHub private vulnerability reporting. Public issues must not include credentials, proprietary source, private Session transcripts, or exploitable details before remediation is available.
