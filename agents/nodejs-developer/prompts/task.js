import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const AGENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

async function loadWorkflow() {
  return readFile(join(AGENT_DIR, 'workflow.md'), 'utf8');
}

async function loadMemory() {
  try {
    const raw = await readFile(join(AGENT_DIR, 'memory.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { feedback: [], patterns: [] };
  }
}

/**
 * Build the system prompt for a code or spike task.
 * @param {'code' | 'spike'} taskType
 * @returns {Promise<string>}
 */
export async function buildSystemPrompt(taskType) {
  const [workflow, memory] = await Promise.all([loadWorkflow(), loadMemory()]);

  const patternBlock = memory.patterns.length > 0
    ? `## Learned Patterns\nThe CEO has reviewed your past work and distilled these preferences:\n${memory.patterns.map((p) => `- ${p}`).join('\n')}`
    : '';

  const taskInstructions = taskType === 'spike'
    ? `## Your Task Type: Spike
You are writing a design document (SPIKE.md), not code.
Structure it as:
1. Problem statement
2. Options considered (at least two)
3. Recommended approach with rationale
4. Open questions
Use markdown. Be concise and opinionated.`
    : `## Your Task Type: Code
You are writing production Node.js code.
Return ONLY the file contents — no explanation, no markdown fences.
If the task requires multiple files, output each as:
--- path/to/file.js ---
<file contents>
--- end ---`;

  return [workflow, patternBlock, taskInstructions].filter(Boolean).join('\n\n---\n\n');
}

/**
 * Build the user message for a specific issue.
 * @param {{ number: number, title: string, body: string | null }} issue
 * @param {'code' | 'spike'} taskType
 * @returns {string}
 */
export function buildUserMessage(issue, taskType) {
  const body = issue.body?.trim() || 'No description provided.';
  const verb = taskType === 'spike' ? 'Write a design document for' : 'Implement';
  return `${verb} the following GitHub issue.\n\nIssue #${issue.number}: ${issue.title}\n\n${body}`;
}
