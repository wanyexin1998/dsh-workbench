# AGENTS.md

DSH Workbench is an independent source-preview plugin for DeepSeek Harness Web.

## Current truth

- `release-contract.json` owns supported versions, fork commits, protocol numbers, distribution status, and the two-Pane product limit.
- `packages/dsh-workbench` owns Split Pane activation, Navigator, shortcuts, and Same Workspace Warning.
- `packages/dsh-workbench-panel-compat` is optional and may only use explicit versioned provider capabilities plus the public `data-session-pane*` host markers.
- Harness protocol 2 and the optional Better Sidebar Pane capability are maintained in the pinned downstream forks named by the release contract.
- This repository ships source and local TGZ artifacts only. Do not add npm publication, automatic third-party installation, or GitHub Actions without an explicit maintainer decision.

## Commands

Do not run repository commands from a newly cloned or third-party checkout until the user-approved full-commit detached-checkout flow in `docs/INSTALL.md` has succeeded. During development, run them only for source you authored or reviewed on top of that trusted baseline.

```powershell
pnpm install --frozen-lockfile
pnpm release:check
```

Run package-focused tests while developing; run `pnpm release:check` before any tag or public artifact.

## Boundaries

- Reuse Harness Conversation under explicit `SessionProvider(sessionId)`; never copy it or patch private DOM/store state.
- Maximum two visible Panes. `visible` owns stable membership; `focused` owns interaction routing.
- Focus changes never open, close, mount, or unmount Pane panels.
- Workbench adds no Host filesystem, subprocess, credential, or arbitrary network permission.
- Never commit credentials, private Session content, proprietary paths, personal machine paths, or company identity data.
- Keep comments and public docs in English, except that `README.md` is the default Simplified Chinese landing page, `README_EN.md` is its English counterpart, and localized product dictionaries contain their target language.
