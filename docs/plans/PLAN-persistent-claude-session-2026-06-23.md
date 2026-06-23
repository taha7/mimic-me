# Plan: Persistent Claude CLI Session

> Discussion date: 2026-06-23

## Problem / Goal

Before moving to Phase 7 (second agent), change the agent's Claude interaction model from one-shot `-p` calls to a persistent OS process. The CEO should be able to have a continuous conversation with the agent — messages are piped into a running `claude` process, and the session stays alive until explicitly stopped or the CEO goes inactive.

## Options We Considered

### Option 1: Plain `child_process.spawn` pipe
Spawn `claude` without `-p`, keep stdin/stdout piped, write each CEO message to stdin, read stdout back. Simple, no extra dependencies.
**Accepted** as the first approach — cheap to validate. Fall back to `node-pty` if Claude CLI requires a real TTY.

### Option 2: `node-pty` pseudo-terminal
Give the `claude` process a fake terminal so it behaves as if running interactively. More reliable but adds a dependency and requires stripping terminal escape codes from output.
**Deferred** — only use if plain pipe fails.

### Option 3: Maintain conversation history in memory, use API directly
Not a persistent OS process — keep message history in an array and pass it to each API call. Achieves the same UX but was ruled out because the goal is a literal persistent process.
**Rejected.**

### Option 4: Idle timeout to detect end of response
Buffer stdout and treat a ~1.5s gap in output as "response done."
**Rejected as primary** — fragile, can cut responses early or wait too long on slow generations.

### Option 5: Sentinel marker to detect end of response
Instruct Claude via system prompt to end every response with `<<<END>>>`. Buffer stdout and flush to Slack when the sentinel is seen.
**Accepted as primary** signal. 5-second idle timeout kept as fallback safety net.

## Agreed Approach

- Spawn `claude` as a persistent child process using plain `child_process.spawn` (try first; escalate to `node-pty` if TTY is required)
- Any DM from the CEO starts or continues the session — if no active process exists, spawn one; if one exists, pipe the message to its stdin
- System prompt instructs Claude to end every response with `<<<END>>>` — agent buffers stdout and relays to Slack on sentinel detection, with a 5-second idle timeout as fallback
- Before piping a message to Claude, a thin pre-filter intercepts session control commands (`stop`, `stop session`) and handles them directly — everything else goes to Claude
- Session ends on: (a) CEO says "stop" / "stop session", or (b) inactivity timeout (configurable in `config.yaml`, default 30 minutes)

## Next Steps

- [ ] Add `sessionTimeoutMinutes: 30` to `config.yaml` under the `nodejs-developer` agent entry
- [ ] Implement `SessionManager` in `agents/nodejs-developer/tools/session.js`:
  - `startSession()` — spawns `claude` process, sets up stdout buffer, starts inactivity timer
  - `sendMessage(text)` — writes to stdin, resets inactivity timer, returns promise that resolves on `<<<END>>>` or idle timeout
  - `endSession()` — kills process, clears timer
  - `isActive()` — returns whether a process is currently running
- [ ] Update system prompt (in `prompts/task.js` or a new `prompts/session.js`) to include the sentinel instruction
- [ ] Update `agents/nodejs-developer/index.js`:
  - Add pre-filter for `stop` / `stop session` → call `endSession()`, reply "Session ended."
  - All other messages → if no active session, `startSession()` first; then `sendMessage(text)` and relay response to Slack
- [ ] Test with plain pipe first; if Claude CLI requires TTY, install `node-pty` and update `SessionManager`
- [ ] Test inactivity timeout: go quiet for 30 min, confirm process is killed

## Open Questions

- Does `claude` CLI accept piped stdin without a TTY? (First thing to validate experimentally)
- Should the session persist `currentTask` state (issue being worked on), or is that managed separately from the Claude process?
