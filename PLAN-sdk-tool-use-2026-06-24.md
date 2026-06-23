# Plan: Replace Claude CLI Sessions with Anthropic SDK Tool Use

> Discussion date: 2026-06-24

## Problem / Goal

The current `handleChatMessage` path uses `SessionManager` to spawn `claude -p` / `claude -c`
subprocesses for conversational replies. This works but has several drawbacks:

- Every call carries Claude Code's full system prompt and tool schemas as overhead tokens
- The session is limited to generic conversation — Claude cannot autonomously act on GitHub
- Subprocess management (temp dirs, inactivity timers, process kill) adds fragility
- The CLI and API cost the same per token, so there's no cost reason to keep it

The goal is to replace the CLI session with a **direct Anthropic SDK agentic loop** where Claude
can call our existing GitHub tool functions autonomously during natural conversation — no static
intent router needed.

## Options We Considered

### Option 1: MCP (Model Context Protocol)
Pass `--mcp-config` to `claude` CLI with a GitHub MCP server.
**Rejected** — requires a separate MCP server process, harder to control which tools are exposed,
and still carries the CLI subprocess overhead.

### Option 2: Anthropic SDK agentic loop (chosen)
Replace `SessionManager` with a direct `anthropic.messages.create` loop. Define the existing
`tools/github.js` functions as tool schemas. Keep a `messages[]` array in memory for conversation
persistence (replaces the temp-dir-based CLI session history).

**Why this wins:**
- GitHub functions already exist — just need JSON schemas for them
- `GITHUB_TOKEN` never leaves the Node.js process (more secure than passing to a subprocess)
- Leaner token usage — no Claude Code scaffolding, only what we define
- Full control: we decide which tools Claude can call, can add approval gates later
- Same token cost as CLI, with less overhead per call

## Agreed Approach

Single `ConversationManager` class (or plain module-level state) that holds a `messages[]` array.
`handleChatMessage` calls `anthropic.messages.create` with GitHub tool schemas, then runs the
tool loop: if `stop_reason === 'tool_use'`, execute the requested tool, append a `tool_result`
message, and call the API again. Repeat until `stop_reason === 'end_turn'`.

The intent router (`parseIntent` / `handleStartIssue` etc.) can be removed or kept as a fast path
for explicit commands — TBD during implementation.

## Next Steps

- [ ] Define tool schemas for the GitHub functions we want Claude to call:
  - `list_issues` — calls `getAssignedIssues()`
  - `get_issue` — calls `getIssue(number)`
  - `start_issue` — calls `handleCodeTask` or `handleSpikeTask` based on issue type
- [ ] Replace `handleChatMessage` with an SDK agentic loop:
  - Keep `messages[]` array in module scope (replaces CLI session temp dir)
  - Use `claude-sonnet-4-6` (same model used for spikes)
  - Tool loop: call → check `stop_reason` → execute tool → append result → repeat
- [ ] Wire "stop session" / "reset chat" to clear the `messages[]` array
- [ ] (Optional) Remove `parseIntent` / static intent router — let Claude decide from context
- [ ] (Optional) Add inactivity timeout: clear `messages[]` after N minutes of silence

## Open Questions

- Keep the static intent router as a fast path, or let the agentic Claude handle everything?
- Should `start_issue` be a tool Claude calls, or keep it as an explicit command?
- What model for the agentic loop? Sonnet 4.6 is a reasonable default; Haiku 4.5 for cost.
