/**
 * The `codex` binary version `CodexStageAgent` was built against, from what `codex app-server
 * generate-ts --experimental` printed for it. The worker image installs this one (`CODEX_VERSION` in
 * the Dockerfile; move them together), since the adapter relies on an experimental part of that
 * protocol. Unlike `CLAUDE_BINARY_VERSION`, no live engine probe has passed against it.
 */
export const CODEX_BINARY_VERSION = '0.166.0';
