# DSH Workbench 0.2.0-rc.1

Status: source preview. No npm package or automatic installer is published.

## Included

- Two visible Session Panes over Harness Session Presentation protocol 2.
- Stable `visible` membership and independent `focused` interaction ownership.
- Explicit SessionProvider binding, Pane-local right/bottom panel hosts, and focus-safe lifecycle teardown.
- Conversation Navigator with one precise marker per human input.
- Host-backed shortcuts with Simplified Chinese and English names.
- Optional Better Sidebar 0.16.1 Pane protocol 1 adapter.

## Verified

- Workbench: 178 tests, typecheck, build, and TGZ pack.
- Panel Compatibility: 7 tests, typecheck, build, and TGZ pack.
- Harness fork: 748 focused tests and 5 capacity-2 assembled Web snapshot tests.
- Dependency audit: no known vulnerabilities in the two distributed source packages at verification time.

## Distribution boundary

The repository is public source, not an official DeepSeek Harness distribution. Forked Harness and Better Sidebar packages retain their original names and must not be republished under upstream package namespaces.
