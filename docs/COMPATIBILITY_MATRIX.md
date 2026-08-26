# Compatibility matrix

| Component | Required source | Capability | Status |
| --- | --- | --- | --- |
| Workbench `0.2.0-rc.1` | Harness fork `53015a6f` | Session Presentation protocol 2 | Supported source preview |
| Workbench `0.2.0-rc.1` | Stock Harness `0.1.1-rc.2` | protocol 2 absent | Split Pane fails closed |
| Panel Compatibility `0.1.0-rc.1` | Better Sidebar fork `91e772a` | Pane protocol 1 | Supported optional adapter |
| Panel Compatibility absent | Any panel provider | n/a | Core Workbench remains functional |
| Panel Compatibility + stock Better Sidebar 0.16.1 | Pane protocol absent | no attachment | Better Sidebar retains its global behavior |

Exact repository URLs, branches, commits, and versions are machine-readable in [`release-contract.json`](../release-contract.json).

Neither downstream fork is republished under the upstream npm namespace.
