# Contributing

Contributions are welcome in this independent downstream project.

## Before opening a change

1. Read `AGENTS.md`, `docs/PRODUCT_CONTRACT.md`, and `release-contract.json`.
2. Keep the two-Pane limit and `visible + focused` state model.
3. Do not copy Harness Conversation code or patch private third-party DOM/store state.
4. Do not add npm publication, automatic third-party installation, or GitHub Actions without a maintainer decision.

## Verify locally

```powershell
pnpm install --frozen-lockfile
pnpm release:check
```

GitHub Actions are disabled. Include the command, exit code, Node/pnpm versions, and relevant test totals in the pull request description.

## Security and privacy

Never commit credentials, private Session transcripts, proprietary code, personal machine paths, company email addresses, or internal infrastructure details. Report vulnerabilities privately through `SECURITY.md`.

## Commit scope

Keep changes focused and preserve unrelated work. Update the owning documentation and tests when behavior or compatibility changes.
