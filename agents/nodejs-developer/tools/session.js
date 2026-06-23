import { spawn } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Each session gets its own temp dir so claude's conversation history is
// isolated from other sessions and from the project's own claude sessions.
export class SessionManager {
  constructor(timeoutMinutes = 30) {
    this._sessionDir = null;
    this._systemPrompt = null;
    this._isFirst = true;
    this._currentProc = null;
    this._pendingReject = null;
    this._inactivityTimer = null;
    this._timeoutMs = timeoutMinutes * 60 * 1000;
  }

  isActive() {
    return this._sessionDir !== null;
  }

  // Creates an isolated temp dir for this session's history. Returns a promise
  // that resolves once the directory is ready (nearly instant).
  async startSession(systemPrompt) {
    this.endSession();
    this._systemPrompt = systemPrompt;
    this._isFirst = true;
    this._sessionDir = await mkdtemp(join(tmpdir(), 'claude-session-'));
    this._resetInactivity();
  }

  sendMessage(text) {
    if (!this._sessionDir) throw new Error('No active Claude session');
    this._resetInactivity();

    // First message: establish system prompt. Subsequent messages: continue (-c).
    const args = ['-p', text, '--output-format', 'text'];
    if (this._isFirst) {
      args.push('--system-prompt', this._systemPrompt);
      this._isFirst = false;
    } else {
      args.push('-c');
    }

    // Strip ANTHROPIC_API_KEY so the claude CLI uses its stored credentials
    // and never shows the "Detected a custom API key" confirmation dialog.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    return new Promise((resolve, reject) => {
      this._pendingReject = reject;

      const proc = spawn('claude', args, { cwd: this._sessionDir, env });
      this._currentProc = proc;

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => { stderr += d; });
      proc.on('close', (code) => {
        this._currentProc = null;
        this._pendingReject = null;
        if (code !== 0) reject(new Error(stderr.trim() || `claude exited with code ${code}`));
        else resolve(stdout.trim());
        this._resetInactivity();
      });
    });
  }

  endSession() {
    clearTimeout(this._inactivityTimer);
    this._inactivityTimer = null;

    if (this._currentProc) {
      try { this._currentProc.kill(); } catch {}
      this._currentProc = null;
    }

    if (this._pendingReject) {
      const rej = this._pendingReject;
      this._pendingReject = null;
      rej(new Error('Session ended by user'));
    }

    if (this._sessionDir) {
      rm(this._sessionDir, { recursive: true, force: true }).catch(() => {});
      this._sessionDir = null;
    }

    this._isFirst = true;
    this._systemPrompt = null;
  }

  _resetInactivity() {
    clearTimeout(this._inactivityTimer);
    this._inactivityTimer = setTimeout(() => this.endSession(), this._timeoutMs);
  }
}
