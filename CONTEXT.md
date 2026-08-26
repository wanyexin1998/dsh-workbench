# DSH Workbench domain language

**Session** — a durable DeepSeek Harness conversation entity. Do not use this term for a Pane or rendered component tree.

**Conversation** — the stock Harness React tree rendering one Session. Workbench reuses it and never copies it.

**Pane** — one visible presentation position bound to a Session. Workbench 0.2 supports at most two.

**Session Presentation** — Harness protocol 2 state and actions: stable `visible` membership, `focused` interaction ownership, and `open`, `focus`, `close`, and `requestCapacity` operations.

**visible** — Session identifiers in stable left-to-right Pane order. Focusing never reorders them.

**focused** — the visible Session receiving shortcuts, navigation highlighting, and panel-command routing. Focus is not membership.

**Workbench** — `@wanyexin1998/dsh-workbench`, containing Split Pane, Navigator, shortcuts, and Same Workspace Warning.

**Panel Compatibility** — the optional `@wanyexin1998/dsh-workbench-panel-compat` package. It connects only explicit versioned adapters.

**Same Workspace Warning** — a non-blocking warning shown when two visible Pane Sessions share a Workspace identity.
