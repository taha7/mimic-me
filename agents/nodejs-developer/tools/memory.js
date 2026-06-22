import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Anthropic from '@anthropic-ai/sdk';

const MEMORY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'memory.json');
const MAX_PATTERNS = 50;

const anthropic = new Anthropic();

export async function readMemory() {
  try {
    const raw = await readFile(MEMORY_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { feedback: [], patterns: [], processedPRs: [] };
  }
}

async function writeMemory(memory) {
  await writeFile(MEMORY_PATH, JSON.stringify(memory, null, 2), 'utf8');
}

export async function isAlreadyProcessed(prNumber) {
  const memory = await readMemory();
  return (memory.processedPRs ?? []).includes(prNumber);
}

/**
 * Fetch PR comments, distill into patterns, and persist to memory.json.
 * Returns { newPatterns, prNumber } on success, or null if no comments.
 */
export async function updateMemoryFromPR(prNumber, issueNumber, rawComments) {
  const memory = await readMemory();
  if (!memory.processedPRs) memory.processedPRs = [];

  const commentTexts = rawComments.map((c) => c.body).filter(Boolean);

  // Mark processed regardless — even zero-comment PRs shouldn't be revisited
  memory.processedPRs.push(prNumber);

  if (commentTexts.length === 0) {
    await writeMemory(memory);
    return null;
  }

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    system: 'You distill PR review comments into reusable coding patterns. Return a JSON array of short, actionable pattern strings (max 10 items). Each pattern is a general rule a Node.js developer should follow going forward. Example: ["prefer early returns over nested ifs", "always add JSDoc to exported functions"]. Return only the JSON array, no markdown, no explanation.',
    messages: [{
      role: 'user',
      content: `Distill these PR review comments into reusable patterns for a Node.js developer:\n\n${commentTexts.join('\n\n')}`,
    }],
  });

  let newPatterns = [];
  try {
    const raw = response.content[0].text.replace(/```(?:json)?\n?/g, '').trim();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) newPatterns = parsed.filter((p) => typeof p === 'string');
  } catch {
    // leave newPatterns empty — still record the raw feedback
  }

  memory.feedback.push({
    pr: prNumber,
    issue: issueNumber,
    date: new Date().toISOString().split('T')[0],
    comments: commentTexts,
  });

  memory.patterns.push(...newPatterns);
  if (memory.patterns.length > MAX_PATTERNS) {
    memory.patterns = memory.patterns.slice(-MAX_PATTERNS);
  }

  await writeMemory(memory);
  return { newPatterns, prNumber };
}
