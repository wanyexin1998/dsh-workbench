# Harness web browser E2E carriers

Real-browser acceptance tests for the Workbench Ask feature family (selection
actions + fresh-chat shortcut). They are **carriers, not a runnable suite in
this repo**: each file plugs into the Harness web E2E lane (`apps/web/tests/`)
of a pinned Harness checkout, where `scaffold.ts`, `support.ts`, and the seeded
fixtures live.

| Directory | Harness baseline | Verifies |
| --- | --- | --- |
| `stock/` | upstream `a66e4702047846cdaa10c66c9d3df3951f5ea70d` | seeding + roster discovery, selection toolbar (Add only), `Ctrl+Shift+C` in-place downgrade with a one-time notice, zero-tool chat session, blank reuse |
| `edition/` | fork `rc4/presentation-on-0.1.2` @ `c5a387cd2f781d4d9914ea0271ebb507984ca3f4` | beside-open second Pane, pane-scoped Add routing, More Details / Ask fork semantics, source-pane preservation, parent-log purity |

To run one:

1. Create a worktree of the Harness repo at the baseline commit above and
   install its workspace dependencies.
2. Install the Workbench TGZ from this repo's `dist/` into the worktree root
   and `apps/cli` as `@wanyexin1998/dsh-workbench` (a `file:` dependency), then
   `pnpm install`.
3. Copy the `.e2e.ts` + `.overlay.yml` pair into `apps/web/tests/`.
4. From `apps/web`, run `pnpm vitest run tests/<file>.e2e.ts`.

The `.overlay.yml` inserts the Workbench plugin row into the composition the
scaffold boots. Keep the pair together — the test resolves the overlay by a
relative URL.
