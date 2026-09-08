# DSH Workbench domain language

**Session** — a durable DeepSeek Harness conversation entity. Do not use this term for a Pane or rendered component tree.

**Conversation** — the stock Harness React tree rendering one Session, *and* the per-Session data assembly behind it. Workbench reuses both and never copies either.

**Conversation target** — one named observable face on a Conversation binding, reached as `uiConversation.binding(sessionId).target('<name>')`. The chat node table lives on the `chat` target, published by `@deepseek-ai/dsh-client-ui-chat`. Absent this term the team read the node table as a field of the Session, which is what shipped a broken `0.2.0-rc.5`.

**Session snapshot** — the Session's own lifecycle state: fifteen fields, `sessionId` through `awaitingFirstTurn`. It **excludes Conversation target data** by contract. If you are looking for transcript nodes here, you are in the wrong place — see Conversation target.

**Pane** — one visible presentation position bound to a Session. Workbench 0.2 supports at most two.

**Session Presentation** — Harness protocol 2 state and actions: stable `visible` membership, `focused` interaction ownership, and `open`, `focus`, `close`, and `requestCapacity` operations.

**visible** — Session identifiers in stable left-to-right Pane order. Focusing never reorders them.

**focused** — the visible Session receiving shortcuts, navigation highlighting, and panel-command routing. Focus is not membership.

**Workbench** — `@wanyexin1998/dsh-workbench`, containing Split Pane, shortcuts, selection quoting, and Same Workspace Warning.

**Panel Compatibility** — the optional `@wanyexin1998/dsh-workbench-panel-compat` package. It connects only explicit versioned adapters.

**Same Workspace Warning** — a non-blocking warning shown when two visible Pane Sessions share a Workspace identity.
