# Keep Host and Agent runtime semantics unchanged

Split Pane is a Client presentation capability. Workbench does not change core Session event schemas, the agent loop, tool execution, LLM adapters, persistence formats, or the connection wire protocol.

The required Harness fork changes only the Client Session Presentation face, renderer binding, layout, and navigation consumers.
