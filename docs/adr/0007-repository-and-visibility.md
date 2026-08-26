# Independent public repository with clean history

## Status

Accepted for the 0.2 source preview.

## Decision

The public project lives in `wanyexin1998/dsh-workbench` with a new, curated Git history. It contains only Workbench, Panel Compatibility, current documentation, local release tooling, and required licenses.

Legacy rc.5 carrier source, the protocol-1 installer, internal planning reports, private development history, and GitHub Actions are excluded. The original private repository remains a private development archive.

Harness protocol 2 and the optional Better Sidebar Pane capability are maintained in separately pinned downstream forks. This repository records their commits but does not republish upstream package namespaces.

## Consequences

- Public history contains no legacy corporate commit identity or unrelated vendored source.
- Every release check is reproducible locally through `pnpm release:check`.
- Updates to either fork require a release-contract change and a fresh compatibility/security audit.
