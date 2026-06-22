import { Octokit } from '@octokit/rest';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const owner = process.env.GITHUB_OWNER;
const repo = process.env.GITHUB_REPO;

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

export async function getAssignedIssues() {
  const { data } = await octokit.issues.listForRepo({
    owner,
    repo,
    state: 'open',
    labels: 'agent-assigned',
  });
  return data;
}

export async function getIssue(issueNumber) {
  const { data } = await octokit.issues.get({ owner, repo, issue_number: issueNumber });
  return data;
}

export function getIssueType(issue) {
  const labels = issue.labels.map((l) => l.name);
  if (labels.includes('type:spike')) return 'spike';
  if (labels.includes('type:code')) return 'code';
  return null;
}

export async function createBranch(issueNumber, issueTitle, type = 'feat') {
  const prefix = type === 'spike' ? 'spike' : 'feat';
  const branchName = `${prefix}/issue-${issueNumber}-${slugify(issueTitle)}`;

  const { data: ref } = await octokit.git.getRef({ owner, repo, ref: 'heads/main' });
  const sha = ref.object.sha;

  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha,
  });

  return branchName;
}

export async function commitFile(branch, filePath, content, message) {
  let currentSha;
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: filePath, ref: branch });
    currentSha = data.sha;
  } catch {
    // file doesn't exist yet — create it
  }

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message,
    content: Buffer.from(content).toString('base64'),
    branch,
    ...(currentSha ? { sha: currentSha } : {}),
  });
}

export async function openPR(branch, title, body) {
  const { data } = await octokit.pulls.create({
    owner,
    repo,
    title,
    body,
    head: branch,
    base: 'main',
  });
  return data;
}

export async function getPRReviewComments(prNumber) {
  const { data } = await octokit.pulls.listReviewComments({
    owner,
    repo,
    pull_number: prNumber,
  });
  return data;
}

export async function getAgentClosedPRs() {
  const { data } = await octokit.pulls.list({
    owner,
    repo,
    state: 'closed',
    per_page: 20,
    sort: 'updated',
    direction: 'desc',
  });
  return data.filter(
    (pr) =>
      pr.head.ref.startsWith('feat/issue-') ||
      pr.head.ref.startsWith('spike/issue-'),
  );
}

export function issueNumberFromBranch(branchName) {
  const match = branchName.match(/issue-(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}
