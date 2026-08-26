# DSH Workbench

DSH Workbench is an independent, community-maintained source preview for DeepSeek Harness Web. It combines two visible Session Panes, a per-Pane conversation Navigator, configurable application shortcuts, and an optional compatibility adapter for Pane-local panels.

> This project is not an official DeepSeek project and is not endorsed by DeepSeek or the Better Sidebar maintainers.

## Status

- Workbench: `0.2.0-rc.1` source preview
- Session Presentation: protocol 2, maximum two visible Panes
- npm publication: disabled
- automatic installer: not shipped
- GitHub Actions: disabled; all release checks run locally

The exact supported source revisions live in [`release-contract.json`](release-contract.json). The current preview requires two independently maintained forks:

- [wanyexin1998/deepseek-harness](https://github.com/wanyexin1998/deepseek-harness), branch `codex/presentation-v2`, commit `53015a6f39710dac52ed08f05aca0c6bad7444ac`
- Optional [wanyexin1998/DSH-better-sidebar](https://github.com/wanyexin1998/DSH-better-sidebar), branch `feat/pane-scoped-panel-mounts`, commit `91e772a09e5f66a14c36036f69adb4d866f06ac3`

## Packages

- `packages/dsh-workbench` — Split Pane, Navigator, Same Workspace Warning, and localized shortcuts.
- `packages/dsh-workbench-panel-compat` — optional explicit adapters for Pane-local right and bottom panels.

Installing Panel Compatibility never installs or updates Better Sidebar. Without a compatible provider, it starts no Pane observer and changes no DOM, layout, or styles.

## Local verification

Prerequisites: Node `^22.19` or `>=24`, pnpm 11.

```powershell
pnpm install --frozen-lockfile
pnpm release:check
```

`release:check` runs the local privacy/secret scan, release-contract verification, typechecks, 185 tests, dependency audit, a clean rebuild, generated-runtime scan, TGZ packing, and SHA256 manifest generation. The bundle builder itself always rebuilds and scans generated runtime before packing. It performs no publication.

## Installation

This source preview is intentionally not a one-command install. Build the pinned Harness fork first, then build local Workbench TGZ files. Better Sidebar and Panel Compatibility are optional. See [docs/INSTALL.md](docs/INSTALL.md).

## Security

Report vulnerabilities through GitHub's private vulnerability reporting flow. Do not include credentials, private Session content, or proprietary source in a public issue. See [SECURITY.md](SECURITY.md).

## Documentation

- [Product contract](docs/PRODUCT_CONTRACT.md)
- [Compatibility matrix](docs/COMPATIBILITY_MATRIX.md)
- [Install](docs/INSTALL.md)
- [Uninstall](docs/UNINSTALL.md)
- [Known issues](docs/KNOWN_ISSUES.md)
- [Security statement](docs/SECURITY_STATEMENT.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
