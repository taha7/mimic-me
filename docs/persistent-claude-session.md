# Persistent Claude Session — Implementation Log

How the nodejs-developer agent got a persistent, conversational Claude session that the CEO can chat with over Slack.

---

## Goal

Replace one-shot `claude -p` calls with a session that remembers context. The CEO should be able to send follow-up messages and have Claude recall what was said earlier in the conversation.

---

## What We Built

A `SessionManager` class (`agents/nodejs-developer/tools/session.js`) that:

- Starts a Claude session on the first chat message
- Routes every subsequent message into the same conversation thread
- Kills the session automatically after 30 minutes of inactivity
- Can be explicitly ended with "stop session"

Any Slack DM that isn't a structured agent command (`start issue #N`, `list issues`, etc.) now goes through the session.

---

## Attempt 1 — PTY with interactive mode

### Plan

Spawn `claude` as a persistent OS process using `node-pty` (a pseudo-terminal), keep it alive, and pipe CEO messages into its stdin. A sentinel marker (`<<<END>>>`) in the system prompt would tell Claude to end every response with `<<<END>>>`, letting us detect when a response was complete.

```js
import pty from 'node-pty';

this._proc = pty.spawn('claude', [
  '--system-prompt', systemPrompt,
  '--ax-screen-reader',
], {
  name: 'xterm',
  cols: 220,
  rows: 50,
  cwd: AGENT_DIR,
  env: process.env,
});

this._proc.onData((data) => {
  this._buf += stripAnsi(data);
  if (this._buf.includes('<<<END>>>')) {
    this._flush(); // resolve with content before the sentinel
  } else if (this._pendingResolve) {
    this._resetIdle(); // reset 5s fallback timer
  }
});
```

### Challenge 1 — API key confirmation dialog

Every time the process spawned, Claude detected `ANTHROPIC_API_KEY` in the environment and showed an interactive confirmation dialog:

```
Detected a custom API key in your environment
ANTHROPIC_API_KEY: sk-ant-...
Do you want to use this API key?
  1. Yes
❯ 2. No (recommended)

Enter to confirm · Esc to cancel
```

The process was stuck at this dialog. Our message went into the void, the 5-second idle timer fired, and the buffer was empty → Slack got `say('')` → `no_text` error.

**What we tried:** `--bare` flag (forces API key use, skips keychain) — the dialog still appeared. Auto-responding with `\x1b[A\r` (up-arrow + Enter to select "Yes") — also didn't work reliably.

**Fix:** Strip `ANTHROPIC_API_KEY` from the child process environment entirely. Claude then silently uses its own stored credentials (OAuth/keychain) without any prompt:

```js
const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;

this._proc = pty.spawn('claude', ['--system-prompt', systemPrompt], {
  env,
  // ...
});
```

### Challenge 2 — Empty response (race condition)

Even after fixing the auth dialog, the first message always returned an empty string.

**Root cause:** Claude's interactive startup includes an acknowledgment of the system prompt that ends with `<<<END>>>`. This acknowledgment output was split across two timing windows:

1. Before `sendMessage` was called → accumulated in `_buf`, but since `_pendingResolve` was null, `_flush()` returned early without resolving
2. A small tail of it (`<<<END>>>\n`) arrived *after* `sendMessage` set `_pendingResolve`

At that point `_buf.indexOf('<<<END>>>')` was `0`, so `_buf.slice(0, 0).trim()` → `""`. The promise resolved with an empty string.

**Fix 1:** Make `startSession` return a promise that waits 3 seconds and clears the buffer before allowing any messages:

```js
return new Promise((resolve) => setTimeout(() => {
  this._buf = '';
  resolve();
}, 3000));
```

**Fix 2:** Skip empty sentinel fires — keep waiting instead of resolving:

```js
_flush() {
  if (!this._pendingResolve) return;
  const idx = this._buf.indexOf(SENTINEL);
  const response = this._buf.slice(0, idx).trim();
  this._buf = this._buf.slice(idx + SENTINEL.length);

  if (!response) {
    this._resetIdle(); // ignore, wait for the real response
    return;
  }
  // ... resolve
}
```

### Challenge 3 — Idle timer fires mid-response

After fixing auth and the race condition, a response finally arrived — but it contained raw UI chrome instead of Claude's answer:

```
────────────────────────────────────────
❯ hi
   ◐ medium · /effort
```

**Root cause:** The 5-second idle timer fired while Claude was *still generating*. The `◐ medium · /effort` is Claude's "thinking" spinner. In interactive mode, the spinner keeps updating the same terminal line using carriage returns (`\r`), which get interpreted as newlines after ANSI stripping. This meant data chunks arrived continuously — resetting the idle timer — but the actual response text never appeared because Claude was still thinking when the timer eventually fired.

The interactive TUI is designed for humans to watch in a terminal. It uses cursor positioning, alternate screen buffers, and spinners that are extremely difficult to parse programmatically. The `<<<END>>>` sentinel never appeared in the output cleanly.

**This was the fundamental blocker with the PTY approach.**

---

## Attempt 2 — `-p` with `-c` (what actually works)

### Insight

Claude's `-p` (print/non-interactive) flag produces clean text output with no TUI, no spinners, no escape codes. Claude's `-c` (continue) flag resumes the most recent conversation in the current working directory.

By giving each session its own isolated temp directory, we get:
- Clean output (process exits when done, stdout is the full response)
- Conversation continuity (`-c` loads history scoped to that directory)
- No PTY, no ANSI stripping, no sentinel, no timers

### Implementation

```js
import { spawn } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

export class SessionManager {
  async startSession(systemPrompt) {
    this.endSession();
    this._systemPrompt = systemPrompt;
    this._isFirst = true;
    // Unique temp dir = isolated conversation history
    this._sessionDir = await mkdtemp(join(tmpdir(), 'claude-session-'));
    this._resetInactivity();
  }

  sendMessage(text) {
    if (!this._sessionDir) throw new Error('No active Claude session');
    this._resetInactivity();

    const args = ['-p', text, '--output-format', 'text'];
    if (this._isFirst) {
      // First message establishes the system prompt
      args.push('--system-prompt', this._systemPrompt);
      this._isFirst = false;
    } else {
      // Subsequent messages continue the same conversation thread
      args.push('-c');
    }

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // avoid the API key confirmation dialog

    return new Promise((resolve, reject) => {
      const proc = spawn('claude', args, { cwd: this._sessionDir, env });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => { stderr += d; });
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr.trim() || `claude exited with code ${code}`));
        else resolve(stdout.trim());
        this._resetInactivity();
      });
    });
  }

  endSession() {
    clearTimeout(this._inactivityTimer);
    if (this._currentProc) { try { this._currentProc.kill(); } catch {} }
    if (this._sessionDir) {
      rm(this._sessionDir, { recursive: true, force: true }).catch(() => {});
      this._sessionDir = null;
    }
    // ...
  }
}
```

### How conversation history works

Each `-p` call is one-shot, but Claude automatically saves every conversation to disk under `~/.claude/projects/<hash-of-cwd>/`. The `-c` flag tells Claude "load the most recent conversation saved for this working directory and continue it."

So the flow across two messages looks like this:

```
Message 1:
  spawn claude -p "hi" --system-prompt "..." --cwd /tmp/claude-session-abc123
  → Claude runs, responds, saves history to ~/.claude/projects/<hash-of-/tmp/claude-session-abc123>/
  → process exits, stdout = full response

Message 2:
  spawn claude -c -p "what did I just say?" --cwd /tmp/claude-session-abc123
  → -c loads history from ~/.claude/projects/<hash-of-/tmp/claude-session-abc123>/
  → Claude sees: system prompt + "hi" + its previous answer + "what did I just say?"
  → responds with full context, saves updated history
  → process exits, stdout = full response
```

The key is that both spawns use **the same `cwd`** (`this._sessionDir`). Claude uses the cwd as the key to find the right history. If the cwd changes, `-c` loads a different conversation.

That's why we create a unique temp dir (`mkdtemp`) for each session — it acts as an isolated "project" from Claude's perspective. Without it, two concurrent sessions in the same directory would share history and corrupt each other.

When `endSession()` deletes the temp dir, the matching entry in `~/.claude/projects/` becomes unreachable. Claude will never find it again.

### Wiring into the agent

`index.js` routes all non-structured messages to the session:

```js
const STOP_SESSION_RE = /^(stop session|end session|kill session)\s*$/i;

async function handleMessage(text, say) {
  // Pre-filter: CEO can end the session explicitly
  if (STOP_SESSION_RE.test(text.trim())) {
    if (session.isActive()) {
      session.endSession();
      await say('Claude session ended.');
    } else {
      await say('No active Claude session.');
    }
    return;
  }

  const parsed = await parseIntent(text);
  switch (parsed.intent) {
    case 'start_issue': ...
    case 'list_issues': ...
    case 'current_task': ...
    case 'stop':        ...       // stops current GitHub task
    default:
      await handleChatMessage(parsed.text ?? text, say); // → session
  }
}

async function handleChatMessage(text, say) {
  if (!session.isActive()) {
    const ready = session.startSession(buildSessionSystemPrompt());
    await say('_Starting Claude session…_');
    await ready; // waits for mkdtemp (instant)
  }

  const response = await session.sendMessage(text);

  const MAX = 3000;
  const truncated = response.length > MAX
    ? response.slice(0, MAX) + '\n…(truncated)'
    : response;
  await say(truncated);
}
```

---

## Summary of Challenges

| Challenge | Root Cause | Fix |
|-----------|-----------|-----|
| API key dialog on spawn | `ANTHROPIC_API_KEY` in env triggers interactive confirmation | Delete it from the child env |
| Empty first response | Startup sentinel `<<<END>>>` tail arrived after `sendMessage` was called | Skip empty sentinel fires; 3s startup buffer |
| Idle timer fires mid-response | Interactive TUI keeps emitting data (spinner) but never outputs a clean response | Abandon PTY entirely |
| UI chrome in response | Claude interactive mode uses cursor-positioned rendering that survives ANSI stripping | Use `-p` (non-interactive) for clean text output |

## Final File Structure

```
agents/nodejs-developer/
├── index.js                  ← session pre-filter + handleChatMessage
├── tools/
│   └── session.js            ← SessionManager (-p / -c approach)
└── prompts/
    └── session.js            ← buildSessionSystemPrompt()
```
