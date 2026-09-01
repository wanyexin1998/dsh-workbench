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
- Workbench adds no Host filesystem, subprocess, credential, or arbitrary network permission, with one exception: the Host entry seeds the bundled `chat` agent preset into `$DSH_HOME/.agent-presets/` (create-only, never overwrite, never re-create after user deletion — see `docs/PRODUCT_CONTRACT.md` "Chat preset seeding").
- Never commit credentials, private Session content, proprietary paths, personal machine paths, or company identity data.
- Code comments are written in Simplified Chinese. This repository has one
  maintainer, who reads Chinese, and comments earn their keep by being read —
  a rule that sends them through a translation nobody asked for makes them
  worse. Load-bearing reasoning (why a gate is shaped this way, which
  contrast ratio a token was chosen for, what a guard is defending against)
  belongs in the comment, in Chinese, next to the code it explains.
- Public documentation is English, with two deliberate exceptions: `README.md`
  is the Simplified Chinese landing page and `README_EN.md` is its English
  counterpart, and localized product dictionaries carry their target language.
  Anything a stranger reads before installing — `docs/`, release notes,
  commit messages — stays English.
