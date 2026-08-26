# Reuse stock Conversation

Each Pane binds one Session through an explicit SessionProvider and renders the stock Conversation slot.

```text
Pane A -> SessionProvider(A) -> stock Conversation
Pane B -> SessionProvider(B) -> stock Conversation
```

Workbench does not copy or replace the Conversation implementation.
