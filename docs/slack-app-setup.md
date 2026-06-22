# Slack App Setup (per agent)

Do this once for each agent. Each agent needs its own Slack app.

---

## 1. Create the app

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Name it after the agent (e.g. `nodejs-developer`) and select your workspace

---

## 2. Enable Socket Mode

1. Left sidebar → **Settings** → **Socket Mode** → toggle on
2. Generate an App-Level Token with scope `connections:write`
3. Copy the token → save as `SLACK_APP_TOKEN` in `.env`

---

## 3. Add bot scopes

1. Left sidebar → **Features** → **OAuth & Permissions**
2. Scroll to **Bot Token Scopes** → add:
   - `chat:write`
   - `im:read`
   - `im:history`
   - `im:write`

---

## 4. Subscribe to events

1. Left sidebar → **Features** → **Event Subscriptions** → toggle on
2. Under **Subscribe to bot events** → add `message.im`
3. Save changes

---

## 5. Enable DMs in App Home

1. Left sidebar → **Features** → **App Home**
2. Scroll to **Show Tabs**
3. Check **"Allow users to send Slash commands and messages from the messages tab"**
4. Save changes

---

## 6. Install to workspace

1. Left sidebar → **Features** → **OAuth & Permissions**
2. Click **Install to Workspace** → Allow
3. Copy the **Bot User OAuth Token** → save as `SLACK_BOT_TOKEN` in `.env`

---

## 7. Get your Slack user ID

1. In Slack, click your profile picture → **Profile**
2. Click **⋯** (More) → **Copy member ID**
3. Save as `SLACK_CEO_USER_ID` in `.env`
