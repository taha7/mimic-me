# Mimic Me — Build Plan

> Created: 2026-06-22
> Stack: Node.js, Slack Socket Mode, GitHub API, Claude API, Railway

---

## Architecture Summary

- One Slack bot user per agent (DM-based, feels like messaging a team member)
- One Railway service per agent (auto-deploys from GitHub on push)
- Each agent has its own `workflow.md` (CEO-written standards) and `memory.json` (learned from PR feedback)
- Agent input: Slack DM from CEO → Agent output: GitHub branch/PR or Slack message
- Task type determined by GitHub issue label (`type:code` or `type:spike`)
- Task assignment determined by GitHub issue label (`agent-assigned`)

---

## Project Structure

```
mimic-me/
  agents/
    nodejs-developer/
      index.js          # agent entry point (started by Railway)
      workflow.md       # code standards, branch naming, PR conventions (CEO-written)
      memory.json       # learned feedback from GitHub PR review comments
      tools/
        github.js       # create branch, open PR, read issues, read review comments
        slack.js        # post messages, listen for DMs
      prompts/
        task.js         # prompt builder: workflow + memory + issue → Claude input
  orchestrator/         # (future) shared utilities across agents
  config.yaml           # active agents, Slack bot IDs, GitHub settings
  package.json
  .env                  # secrets (never committed)
```

---

## Phase 1 — Foundation

> Goal: Repo exists, structure is in place, secrets are wired up.

- [ ] Create GitHub repo `mimic-me` (public or private)
- [ ] Initialize Node.js project (`npm init`, set `"type": "module"`)
- [ ] Create folder structure as above
- [ ] Create `.env.example` with all required keys:
  - `SLACK_BOT_TOKEN` — bot OAuth token
  - `SLACK_APP_TOKEN` — socket mode app-level token
  - `SLACK_CEO_USER_ID` — your Slack user ID (only respond to you)
  - `GITHUB_TOKEN` — personal access token with repo scope
  - `GITHUB_OWNER` — your GitHub username or org
  - `ANTHROPIC_API_KEY`
- [ ] Create `.gitignore` (node_modules, .env, memory.json backups)
- [ ] Create `config.yaml` with nodejs-developer agent entry
- [ ] Write initial `agents/nodejs-developer/workflow.md` with your code standards

---

## Phase 2 — Slack Bot Skeleton

> Goal: The nodejs-developer bot connects to Slack, receives your DMs, and replies.

- [ ] Create a Slack app at api.slack.com
  - Enable Socket Mode
  - Add bot scopes: `chat:write`, `im:read`, `im:history`, `im:write`
  - Enable Events API: subscribe to `message.im`
  - Install app to workspace, get bot token + app token
- [ ] Install Slack SDK: `npm install @slack/bolt`
- [ ] Build `agents/nodejs-developer/tools/slack.js`:
  - Initialize Bolt app with Socket Mode
  - Listen for DMs from CEO only (filter by `SLACK_CEO_USER_ID`)
  - Parse incoming message text
  - Export `sendMessage(text)` helper
- [ ] Build `agents/nodejs-developer/index.js`:
  - Start Slack listener
  - Route message to handler: `handleMessage(text)`
  - Reply "I received: {text}" as a smoke test
- [ ] Test: DM the bot, confirm it replies

---

## Phase 3 — GitHub Integration

> Goal: Agent can read assigned issues, create branches, and open PRs.

- [ ] Install GitHub SDK: `npm install @octokit/rest`
- [ ] Build `agents/nodejs-developer/tools/github.js`:
  - `getAssignedIssues()` — fetch open issues with label `agent-assigned`
  - `getIssue(issueNumber)` — fetch single issue by number
  - `getIssueType(issue)` — return `'code'` or `'spike'` based on labels
  - `createBranch(issueNumber, issueTitle)` — `feat/issue-{id}-{slug}` or `spike/issue-{id}-{slug}`
  - `openPR(branch, title, body)` — open PR against main
  - `getPRReviewComments(prNumber)` — fetch all inline review comments
- [ ] Test each function independently with a real GitHub issue

---

## Phase 4 — Agent Logic (nodejs-developer)

> Goal: Agent reads a message, understands intent, and takes the right action.

### 4a — Intent Router
- [x] Install Anthropic SDK: `npm install @anthropic-ai/sdk`
- [x] Build Claude-based intent router in `index.js`:
  - Single Haiku call with structured JSON output — no regex
  - Routes: `start_issue`, `list_issues`, `current_task`, `stop`, `call_claude`, `unknown`
  - Handles natural language variations automatically
  - In-memory `currentTask` state (one task at a time)
- [x] `call_claude` intent: spawns `claude -p "<prompt>"` as a child process via IPC in the agent directory, streams output back to Slack (truncated at 3000 chars). Triggered by "call_claude: ..." or "claude: ..." in DM.

### 4b — Prompt Builder
- [x] Build `agents/nodejs-developer/prompts/task.js`:
  - Reads `workflow.md` (code standards)
  - Reads `memory.json` (past feedback patterns)
  - Reads issue title + body
  - Constructs Claude prompt: system = workflow + memory, user = issue content + task type
- [x] Wire Claude call: `claude-haiku-4-5-20251001` for `type:code`, `claude-sonnet-4-6` for `type:spike`
- [x] `handleStartIssue` calls Claude and echoes output to Slack (GitHub commit/PR wired in 4c/4d)

### 4c — Code Task Flow
- [x] When `type:code`:
  1. Post to Slack: "Starting issue #{n}: {title}. Creating branch..."
  2. Create branch `feat/issue-{n}-{slug}`
  3. Call Claude with prompt → get code output
  4. Parse multi-file output (`--- path ---` / `--- end ---`), fall back to single file
  5. Commit each file to branch via GitHub API
  6. Open PR, post PR link to Slack

### 4d — Spike Task Flow
- [x] When `type:spike`:
  1. Post to Slack: "Starting spike for issue #{n}. Writing design doc..."
  2. Create branch `spike/issue-{n}-{slug}`
  3. Call Claude → get markdown design document
  4. Commit `SPIKE.md` to branch via GitHub API
  5. Open PR with the design doc as PR body
  6. Post PR link to Slack + paste doc summary in Slack thread

---

## Phase 5 — Memory System

> Goal: Agent learns from your GitHub PR review comments and improves over time.

- [ ] Build memory updater (runs after a PR is closed/merged):
  - `getPRReviewComments(prNumber)` → fetch all your inline comments
  - Pass raw comments to Claude: "Distill these into reusable patterns for a nodejs developer"
  - Append new patterns to `memory.json` under `patterns[]`
  - Also store raw comments under `feedback[]` with PR reference
- [ ] Wire trigger: agent polls for closed PRs it opened, runs updater when found
- [ ] Cap `memory.json` patterns at 50 entries (remove oldest when limit hit)
- [ ] Test: leave a comment on a test PR, confirm it appears in memory on next run

### memory.json shape
```json
{
  "feedback": [
    {
      "pr": 12,
      "issue": 7,
      "date": "2026-06-20",
      "comments": ["use async/await not .then()", "extract this into a helper"]
    }
  ],
  "patterns": [
    "CEO prefers early returns over nested ifs",
    "always add JSDoc to exported functions"
  ]
}
```

---

## Phase 6 — Management UI (future)

> Goal: Add/disable agents without touching code.

- [ ] Build simple web UI on `taha7.com` (Hostinger shared hosting)
  - List active agents (read from `config.yaml`)
  - Toggle agents on/off
  - Edit agent workflow doc in-browser
  - View memory patterns per agent
- [ ] UI calls a lightweight API hosted on Railway that reads/writes `config.yaml`
- [ ] Auth: password-protected or Magic Link to your email
- [ ] Define and implement what "disabled" means for a running agent — options: (a) startup check: agent reads `config.yaml` on boot and exits if `enabled: false`; (b) runtime poll: agent checks every N minutes and stops handling messages; (c) process supervisor kills/starts the process based on the flag

---

## Phase 7 — Second Agent (future)

> Goal: Prove the pattern works for a second agent type.

- [ ] Copy `agents/nodejs-developer/` → `agents/learning/`
- [ ] Update `config.yaml` with new Slack bot credentials
- [ ] Add new Railway service pointing to `agents/learning/index.js`
- [ ] Add second Slack app for the learning agent bot user

---

## Phase 8 — Railway Deployment

> Goal: Agent runs 24/7 on Railway, auto-deploys on every GitHub push.

- [ ] Create Railway account and new project `mimic-me`
- [ ] Add service: `nodejs-developer`
  - Connect to GitHub repo
  - Set start command: `node agents/nodejs-developer/index.js`
  - Add all `.env` variables in Railway dashboard
- [ ] Add `Procfile` or `railway.json` pointing to correct entry per service
- [ ] Push to GitHub, confirm Railway deploys and bot comes online in Slack
- [ ] Test full flow end-to-end:
  1. Label a GitHub issue `agent-assigned` + `type:code`
  2. DM bot: "start issue #{n}"
  3. Confirm branch created, PR opened, Slack message received

---

## Open Questions (to resolve before building)

- [ ] Which GitHub repos should the nodejs-developer agent have access to?
- [ ] Should the agent commit code directly or only create empty branches + open PRs for you to fill?
- [ ] Should memory.json be committed to the repo or stored externally (Railway volume, S3)?
- [ ] Does the agent work on one task at a time only, or can it queue multiple?

---

## Cost Estimate

| Item | Cost |
|---|---|
| Railway (1 service) | Free ($5 credit/month) |
| Claude Haiku (routine tasks) | ~$0.001/call |
| Claude Sonnet (spikes) | ~$0.01/call |
| GitHub API | Free |
| Slack API | Free |
| **Total target** | **< $5/month** |
