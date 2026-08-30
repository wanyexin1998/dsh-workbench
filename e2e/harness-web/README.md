# Harness web browser E2E carriers

Real-browser acceptance tests for the Workbench Ask feature family (selection
actions + fresh-chat shortcut). They are **carriers, not a runnable suite in
this repo**: each file plugs into the Harness web E2E lane (`apps/web/tests/`)
of a pinned Harness checkout, where `scaffold.ts`, `support.ts`, and the seeded
fixtures live.

| Directory | Harness baseline | Verifies |
| --- | --- | --- |
| `stock/` | upstream `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | seeding + roster discovery, selection toolbar (Add only), `Ctrl+Shift+C` in-place downgrade with a one-time notice, zero-tool chat session, blank reuse |
| `edition/` | fork `codex/presentation-v2` @ `53015a6f39710dac52ed08f05aca0c6bad7444ac` | beside-open second Pane, pane-scoped Add routing, More Details / Ask fork semantics, source-pane preservation, parent-log purity |

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
