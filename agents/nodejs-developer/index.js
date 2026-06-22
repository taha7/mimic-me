import 'dotenv/config';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { initSlack, onCEOMessage, sendMessage } from './tools/slack.js';
import { getAssignedIssues, getIssue, getIssueType, createBranch, commitFile, openPR, getAgentClosedPRs, getPRReviewComments, issueNumberFromBranch } from './tools/github.js';
import { isAlreadyProcessed, updateMemoryFromPR } from './tools/memory.js';
import { buildSystemPrompt, buildUserMessage } from './prompts/task.js';

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));

const anthropic = new Anthropic();

// In-memory task state — one task at a time
let currentTask = null; // { issueNumber, issueTitle, type, status }

const INTENT_SYSTEM_PROMPT = `You are an intent router for a coding agent. Given a message from the CEO, return a JSON object identifying the intent.

Valid intents and their required fields:
- { "intent": "start_issue", "issueNumber": <number> }
- { "intent": "list_issues" }
- { "intent": "current_task" }
- { "intent": "stop" }
- { "intent": "call_claude", "prompt": "<everything after the trigger>" }
- { "intent": "unknown", "text": "<original message>" }

Rules:
- Only return raw JSON — no markdown, no explanation.
- Use "start_issue" when the message asks to begin, run, or work on a specific GitHub issue number.
- Use "list_issues" when asking to see, list, or show open/assigned issues.
- Use "current_task" when asking what the agent is doing, its status, or current work.
- Use "stop" when asking to stop, cancel, or abandon the current task.
- Use "call_claude" when the message starts with "call_claude:" or "claude:" or asks to run Claude Code on a prompt. Extract the prompt text after the trigger.
- Use "unknown" for everything else.`;

async function parseIntent(text) {
  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    system: INTENT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: text }],
  });

  try {
    const raw = message.content[0].text.replace(/```(?:json)?\n?/g, '').trim();
    return JSON.parse(raw);
  } catch {
    return { intent: 'unknown', text };
  }
}

function parseCodeOutput(output, issueNumber, issueTitle) {
  const fileRegex = /^---\s+(.+?)\s+---\n([\s\S]*?)^---\s+end\s+---$/gm;
  const files = [];
  let match;
  while ((match = fileRegex.exec(output)) !== null) {
    files.push({ path: match[1].trim(), content: match[2] });
  }
  if (files.length === 0) {
    const slug = issueTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    files.push({ path: `src/${slug}.js`, content: output });
  }
  return files;
}

async function handleStartIssue(issueNumber, say) {
  if (currentTask) {
    await say(`I'm already working on issue #${currentTask.issueNumber}: _${currentTask.issueTitle}_. Say "stop" first if you want to switch.`);
    return;
  }

  let issue;
  try {
    issue = await getIssue(issueNumber);
  } catch (err) {
    await say(`Could not fetch issue #${issueNumber}: ${err.message}`);
    return;
  }

  const type = getIssueType(issue);
  if (!type) {
    await say(`Issue #${issueNumber} has no \`type:code\` or \`type:spike\` label. Please add one and try again.`);
    return;
  }

  currentTask = { issueNumber, issueTitle: issue.title, type, status: 'in_progress' };

  if (type === 'code') {
    await handleCodeTask(issue, say);
  } else {
    await handleSpikeTask(issue, say);
  }
}

async function handleCodeTask(issue, say) {
  const { number, title } = issue;
  await say(`Starting issue #${number}: _${title}_. Creating branch...`);

  let branch;
  try {
    branch = await createBranch(number, title, 'feat');
  } catch (err) {
    currentTask = null;
    await say(`:x: Failed to create branch: ${err.message}`);
    return;
  }

  await say(`Branch \`${branch}\` created. Calling Claude...`);

  let output;
  try {
    output = await callClaude(issue, 'code');
  } catch (err) {
    currentTask = null;
    await say(`:x: Claude call failed: ${err.message}`);
    return;
  }

  const files = parseCodeOutput(output, number, title);
  await say(`Got ${files.length} file(s) from Claude. Committing to branch...`);

  try {
    for (const { path, content } of files) {
      await commitFile(branch, path, content, `feat: implement issue #${number} — ${path}`);
    }
  } catch (err) {
    currentTask = null;
    await say(`:x: Failed to commit files: ${err.message}`);
    return;
  }

  let pr;
  try {
    pr = await openPR(branch, title, `Closes #${number}\n\nImplemented by the nodejs-developer agent.`);
  } catch (err) {
    currentTask = null;
    await say(`:x: Failed to open PR: ${err.message}`);
    return;
  }

  currentTask = null;
  await say(`:white_check_mark: Done. PR #${pr.number} is open for your review: ${pr.html_url}`);
}

async function handleSpikeTask(issue, say) {
  const { number, title } = issue;
  await say(`Starting spike for issue #${number}: _${title}_. Writing design doc...`);

  let branch;
  try {
    branch = await createBranch(number, title, 'spike');
  } catch (err) {
    currentTask = null;
    await say(`:x: Failed to create branch: ${err.message}`);
    return;
  }

  await say(`Branch \`${branch}\` created. Calling Claude...`);

  let output;
  try {
    output = await callClaude(issue, 'spike');
  } catch (err) {
    currentTask = null;
    await say(`:x: Claude call failed: ${err.message}`);
    return;
  }

  try {
    await commitFile(branch, 'SPIKE.md', output, `spike: design doc for issue #${number}`);
  } catch (err) {
    currentTask = null;
    await say(`:x: Failed to commit SPIKE.md: ${err.message}`);
    return;
  }

  let pr;
  try {
    pr = await openPR(branch, `Spike: ${title}`, output);
  } catch (err) {
    currentTask = null;
    await say(`:x: Failed to open PR: ${err.message}`);
    return;
  }

  currentTask = null;
  await say(`:white_check_mark: Spike done. PR #${pr.number}: ${pr.html_url}`);

  const summary = output.length > 800 ? output.slice(0, 800) + '\n…(truncated)' : output;
  await say(`*Design doc:*\n${summary}`);
}

async function handleListIssues(say) {
  let issues;
  try {
    issues = await getAssignedIssues();
  } catch (err) {
    await say(`Failed to fetch issues: ${err.message}`);
    return;
  }

  if (issues.length === 0) {
    await say('No open issues assigned to me right now.');
    return;
  }

  const lines = issues.map((i) => {
    const type = getIssueType(i);
    const typeTag = type ? ` [${type}]` : '';
    return `• #${i.number}${typeTag}: ${i.title}`;
  });

  await say(`My open assigned issues:\n${lines.join('\n')}`);
}

async function handleCurrentTask(say) {
  if (!currentTask) {
    await say('I\'m not working on anything right now. Give me an issue with "start issue #N".');
    return;
  }
  await say(`Currently working on issue #${currentTask.issueNumber}: _${currentTask.issueTitle}_ (type: ${currentTask.type}, status: ${currentTask.status}).`);
}

async function handleStop(say) {
  if (!currentTask) {
    await say("There's nothing running to stop.");
    return;
  }
  const stopped = currentTask;
  currentTask = null;
  await say(`Stopped. Abandoned issue #${stopped.issueNumber}: _${stopped.issueTitle}_.`);
}

/**
 * Call Claude for a task issue. Returns the raw text response.
 * @param {object} issue
 * @param {'code' | 'spike'} taskType
 * @returns {Promise<string>}
 */
export async function callClaude(issue, taskType) {
  const model = taskType === 'spike' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
  const [systemPrompt, userMessage] = await Promise.all([
    buildSystemPrompt(taskType),
    buildUserMessage(issue, taskType),
  ]);

  const response = await anthropic.messages.create({
    model,
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  return response.content[0].text;
}

function runClaudeCode(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', prompt, '--output-format', 'text'], {
      cwd: AGENT_DIR,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      else resolve(stdout.trim());
    });
  });
}

async function handleCallClaude(prompt, say) {
  await say(`Running Claude Code on: _${prompt}_`);
  let output;
  try {
    output = await runClaudeCode(prompt);
  } catch (err) {
    await say(`:x: Claude Code failed: \`${err.message}\``);
    return;
  }

  const MAX = 3000;
  const truncated = output.length > MAX ? output.slice(0, MAX) + '\n…(truncated)' : output;
  await say(`*Claude Code output:*\n\`\`\`\n${truncated}\n\`\`\``);
}

async function handleUnknown(text, say) {
  await say(`I didn't understand: "${text}". Try: "start issue #N", "list issues", "current task", "stop", or "call_claude: <prompt>".`);
}

async function handleMessage(text, say) {
  try {
    const parsed = await parseIntent(text);

    switch (parsed.intent) {
      case 'start_issue':
        await handleStartIssue(parsed.issueNumber, say);
        break;
      case 'list_issues':
        await handleListIssues(say);
        break;
      case 'current_task':
        await handleCurrentTask(say);
        break;
      case 'stop':
        await handleStop(say);
        break;
      case 'call_claude':
        await handleCallClaude(parsed.prompt, say);
        break;
      default:
        await handleUnknown(parsed.text ?? text, say);
    }
  } catch (err) {
    const isAnthropicBilling = err.message?.includes('credit balance is too low');
    const userMessage = isAnthropicBilling
      ? `:warning: *Anthropic billing issue* — your API credit balance is empty.\nTop up at: *console.anthropic.com → Plans & Billing*`
      : `:x: *Unexpected error*\n\`\`\`${err.message}\`\`\``;
    await say(userMessage);
  }
}

const MEMORY_POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

async function runMemoryUpdate() {
  let closedPRs;
  try {
    closedPRs = await getAgentClosedPRs();
  } catch (err) {
    console.error('Memory poller: failed to fetch closed PRs:', err.message);
    return;
  }

  for (const pr of closedPRs) {
    const prNumber = pr.number;
    if (await isAlreadyProcessed(prNumber)) continue;

    const issueNumber = issueNumberFromBranch(pr.head.ref);

    let comments;
    try {
      comments = await getPRReviewComments(prNumber);
    } catch (err) {
      console.error(`Memory poller: failed to fetch comments for PR #${prNumber}:`, err.message);
      continue;
    }

    let result;
    try {
      result = await updateMemoryFromPR(prNumber, issueNumber, comments);
    } catch (err) {
      console.error(`Memory poller: failed to update memory for PR #${prNumber}:`, err.message);
      continue;
    }

    if (result && result.newPatterns.length > 0) {
      const patternLines = result.newPatterns.map((p) => `• ${p}`).join('\n');
      try {
        await sendMessage(`:brain: Learned ${result.newPatterns.length} new pattern(s) from PR #${prNumber}:\n${patternLines}`);
      } catch (err) {
        console.error('Memory poller: failed to send Slack notification:', err.message);
      }
    }
  }
}

async function start() {
  const app = initSlack();

  onCEOMessage(handleMessage);

  await app.start();
  console.log('nodejs-developer agent is running');

  // Run once on boot, then on interval
  runMemoryUpdate().catch((err) => console.error('Memory poller error:', err.message));
  setInterval(
    () => runMemoryUpdate().catch((err) => console.error('Memory poller error:', err.message)),
    MEMORY_POLL_INTERVAL_MS,
  );
}

start().catch((err) => {
  console.error('Failed to start agent:', err);
  process.exit(1);
});
