# Workbench actions API (`workbench.actions`, protocol 1)

Any client plugin can register shortcut-bindable actions into DSH Workbench's Settings → Shortcuts page without touching Workbench internals. This is design.md's "L2" discovery layer (`plans/260827-shortcuts-open-actions/design.md` §3, §6 W3 rows) — the long-term, correct way for a third-party plugin to appear in the open action catalog, alongside Workbench's own built-ins (`workbench.*`) and the host slash-command bridge (`host.*`).

## The service

Workbench provides a Cordis service named `workbenchActions` on `ctx`:

```ts
interface WorkbenchActionsService {
  readonly protocol: 1
  register(def: WorkbenchActionDef): () => void
}
```

Inject it like any other Cordis service (`ctx.inject(['workbenchActions'], ...)`, or read it off `ctx.workbenchActions` inside a function that already has it injected). The service is only present while Workbench itself is loaded; a plugin that wants to work with or without Workbench should treat it as optional (see [Absent service](#absent-service) below).

`protocol` is `1` today. A future breaking change to the contract would ship under a new protocol number, never by silently changing what version `1` means.

## `register(def)`

```ts
interface WorkbenchActionDef {
  id: string
  label: () => string
  run: () => void
  isEnabled?: () => boolean
  provider?: string
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable, namespaced action id — see [Id and namespace rules](#id-and-namespace-rules). |
| `label` | yes | Returns the display text shown in Settings. Called when the action is (re)built into the registry — see [When `label()` is called](#when-label-is-called). |
| `run` | yes | Invoked when the user's bound chord fires. |
| `isEnabled` | no | Runtime gate — see [`isEnabled` semantics](#isenabled-semantics). |
| `provider` | no | Defaults to `id`'s own first dot-segment. If given, it must equal that segment. |

`register` throws synchronously (never a silent no-op) when:

- `id` is not namespaced as `<provider>.<something>` (at least one dot; no leading, trailing, or duplicate dots anywhere in `id`; the provider segment matches the charset in [Id and namespace rules](#id-and-namespace-rules));
- `id`'s provider segment case-insensitively equals the reserved `workbench` or `host` namespace (Workbench's own built-ins and the L1 host-command bridge) — `Workbench.foo` and `HOST.foo` are rejected exactly like `workbench.foo` and `host.foo`, not just an exact-case match;
- `label` or `run` is not a function;
- `isEnabled` is present but not a function;
- `provider` is given but does not equal `id`'s own first segment;
- `id` already has a live registration (from your plugin or any other — ids are global within Workbench's one action registry).

`register` returns a disposer. Calling it unregisters the action: it is removed from the live registry (freeing whatever chord it held) and from Workbench's own bookkeeping, so a later `register()` call with the same `id` succeeds. The disposer is idempotent — calling it more than once is a no-op.

No default chord is ever assigned. A newly registered action starts unbound; only an explicit user binding (or a previously persisted one, keyed by `id`) ever occupies a chord. This matches design.md's anti-goal of never auto-assigning keys for a newly discovered action.

`def` is read once per field, at the moment you call `register()`, into Workbench's own storage — it is a snapshot. Mutating the object you passed to `register()` afterwards has no effect on the live registration; register a fresh one (after disposing the old one, since ids must be unique) if something genuinely needs to change.

`run()` is invoked synchronously from the keydown dispatcher, and by the time it runs the triggering keystroke's default browser behavior has already been prevented. Workbench does not wrap this call in its own error handling: a throwing `run()` still consumes the keystroke (no other action fires for that chord) and the exception propagates to the page's normal uncaught-error handling (visible in devtools, not surfaced as Workbench product UI). Handle your own errors inside `run()`.

## Id and namespace rules

- Must contain at least one dot; no leading, trailing, or duplicate/adjacent dots anywhere in `id` (`myplugin.doThing` is valid; `myplugin.`, `.doThing`, `doThing`, and `my..plugin.doThing` are all rejected).
- The provider segment (everything before the first dot) must match `/^[a-z0-9][a-z0-9-]*$/i` — start with a letter or digit, then only letters, digits, or hyphens. This is a deliberately narrow charset: the provider segment becomes both part of a persisted binding key and a Settings group heading, so whitespace, punctuation, and non-ASCII text are rejected rather than silently accepted and rendered as a confusable-looking group.
- The provider segment must not case-insensitively equal `workbench` or `host` — those namespaces are reserved for Workbench's own built-ins and the host slash-command bridge, regardless of casing.
- `provider` defaults to the id's own first segment (`myplugin.doThing` → `myplugin`) and, if you pass it explicitly, must equal that segment exactly (same case). This keeps Settings grouping honest: one provider label per plugin id-prefix, so a plugin cannot make its actions appear to come from a different plugin's namespace.
- **Keep ids stable across your plugin's versions.** A user's chord binding is persisted keyed by `id`, independent of your plugin's own lifetime (design principle 3 in design.md §2: "绑定属于用户，不属于插件的生命周期" — a binding belongs to the user, not to a plugin's lifetime). Renaming an id is indistinguishable, from Workbench's point of view, from removing one action and adding an unrelated one: the user's existing binding becomes an orphaned entry in Settings (still visible, deletable, but no longer attached to any live action) and the "new" id starts unbound.

## Lifecycle

- **Register early.** The natural place is your plugin's `apply()`. If `ctx.workbenchActions` is not yet available when your plugin loads (see [Absent service](#absent-service)), inject it and register once it resolves.
- **Dispose on your plugin's own dispose.** Call the disposer `register()` returned when your plugin unloads (`ctx.on('dispose', ...)`, or an equivalent teardown hook). This is not optional cleanup: Workbench itself never disposes your action for you — an action stays live in the registry (and stays bindable) for as long as it is registered, even if your plugin's context goes inactive without an explicit dispose.
- **Registrations survive Workbench's own settings reloads.** The Settings page rebuilds its action registry wholesale on every binding/enable/disable change and on hydration from persisted state. Your registration is not lost across that rebuild — Workbench keeps its own store of live third-party registrations and re-applies every one of them into each freshly built registry. You never need to re-register in response to a Workbench-side settings change.
- **The service itself is torn down when Workbench unloads.** After that, calling a disposer you already hold is harmless (idempotent), but calling `register()` again throws a clear error rather than crashing or silently doing nothing.

## Binding and persistence

- The user binds a chord to your action from Settings → Shortcuts, exactly like a Workbench built-in or a host command. Your action is grouped under its own `provider` (label falls back to the raw provider string — Workbench does not currently offer a translated group header for third-party providers; see [No `providerLabel` in v1](#no-providerlabel-in-v1)).
- Bindings are persisted keyed by `id` in Workbench's own shortcut-persistence store (host settings when durable, `localStorage` fallback otherwise). Your plugin never reads or writes this storage directly.
- If your action is not currently registered (your plugin is not loaded, or has not called `register()` yet this session) but the user previously bound a chord to its id, Settings shows that binding as an orphaned entry — grayed out, with only a "remove" control — rather than dropping it silently. It reappears fully functional the moment you register that same id again.

## `isEnabled` semantics

`isEnabled` is a runtime gate consulted every time the bound chord is looked up, not at registration time:

- Return `true` (or omit `isEnabled` entirely): the chord resolves to your action and `run()` fires.
- Return `false`, or throw: the chord resolves to nothing — Workbench does not fall back to any other action, and no error surfaces to the user. The key behaves as if it were unbound while your action reports itself unavailable.

Use this for "no-op instead of a confusing action" cases — for example, an action that only makes sense with something currently selected.

## When `label()` is called

`label()` is called once when the action is first built into a live registry, and again every time Workbench rebuilds the registry (a settings change, hydration, or another provider's action catalog changing) — **not** on every render or keystroke. If your label text just changed and you need Settings to reflect it immediately, dispose and re-register the action.

If `label()` throws, or returns something other than a string, Workbench never lets that take down the registry build (which would otherwise strand every action, from every provider) — it falls back to rendering the action under its own `id` instead. Treat that fallback as a sign your `label()` has a bug to fix, not a supported way to label an action.

## No `providerLabel` in v1

The base contract intentionally does not include a `providerLabel` field. An unrecognized provider id already renders as a readable (if untranslated) group header — Workbench's Settings page has handled this fallback since the W1 open-catalog work landed. Adding a separate, optionally-supplied group label would require deciding which of possibly several plugins registering under the same provider prefix "owns" that label, for a benefit (a nicer group header) that the existing fallback already covers reasonably. This is a deliberate v1 scope decision, not an oversight; it may be revisited if real third-party usage shows the raw id is not good enough.

## Absent service

Workbench is one plugin among many; do not assume it is always loaded. If your plugin should work standalone, do not list `workbenchActions` in your plugin's top-level `inject` (that would make your whole plugin wait for — and fail to load without — Workbench). Instead, request it through a nested `ctx.inject(['workbenchActions'], (workbenchCtx) => { ... })` call inside `apply()`, exactly as shown in [Minimal example](#minimal-example): that inner scope simply does not run while the service is absent, the same way Workbench's own host-command bridge treats an absent host service as "zero actions, fail closed" rather than an error.

## Minimal example

```ts
import type { Context } from '@deepseek-ai/cordis'

// This plugin works with or without Workbench. Top-level `inject` lists only
// services this plugin actually REQUIRES to load at all (none here) —
// `workbenchActions` is optional, so it is requested through a nested
// `ctx.inject(...)` call instead: that inner scope activates when the
// service becomes available and tears itself down automatically if it ever
// goes away (Workbench unloading), without taking this whole plugin down
// with it. This is the same pattern the sibling `dsh-workbench-panel-compat`
// package uses for its own optional `betterSidebar` dependency.
export const inject: readonly string[] = []

export function apply(ctx: Context): void {
  let widgetOpen = false

  ctx.inject(['workbenchActions'], (workbenchCtx) => {
    const dispose = workbenchCtx.workbenchActions.register({
      id: 'myplugin.toggleWidget',
      label: () => (widgetOpen ? 'Close My Widget' : 'Open My Widget'),
      run: () => {
        widgetOpen = !widgetOpen
        // ... actually open/close the widget here ...
      },
      // Optional: hide the action from dispatch while it genuinely cannot
      // run right now (Workbench resolves the chord to "nothing" instead).
      isEnabled: () => true,
    })
    return dispose // torn down automatically when this inject scope unloads
  })
}
```

A plugin author who prefers explicit lifecycle control over `ctx.inject`'s automatic teardown can instead store the disposer and call it from their own `ctx.on('dispose', ...)` handler — see [Lifecycle](#lifecycle).

## First known consumer

`release-contract.json`'s `panelCompatibility.actionsProtocol` records the `workbenchActions` protocol version this Workbench↔Better-Sidebar pairing **targets** — not that the currently pinned build implements it. The consumer implementation (`better-sidebar.toggle-panel` / `better-sidebar.toggle-bottom-panel`, registered through exactly this doc's optional-injection pattern) lives on the Better Sidebar fork's `feat/workbench-actions-consumer` branch, which is **not yet published**: `panelCompatibility.branch` / `.implementationCommit` still point at the published pane-protocol build (`feat/pane-scoped-panel-mounts` @ the pinned commit), which predates that branch and does not contain the actions consumer. When `feat/workbench-actions-consumer` is published, the pin and `actionsProtocol` advance together — restoring the same "pinned build implements protocol N" semantics `paneProtocol` already has — and this note should be updated accordingly.
