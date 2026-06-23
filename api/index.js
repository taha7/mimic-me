import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'config.yaml');

const app = express();
app.use(cors());
app.use(express.json());

// --- Auth ---

function requireAuth(req, res, next) {
  const secret = process.env.API_SECRET;
  if (!secret) return res.status(500).json({ error: 'API_SECRET not configured' });
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// --- Helpers ---

async function readConfig() {
  const raw = await readFile(CONFIG_PATH, 'utf8');
  return yamlLoad(raw);
}

async function writeConfig(config) {
  await writeFile(CONFIG_PATH, yamlDump(config), 'utf8');
}

function agentDir(name) {
  return join(ROOT, 'agents', name);
}

function workflowPath(name) {
  return join(agentDir(name), 'workflow.md');
}

function memoryPath(name) {
  return join(agentDir(name), 'memory.json');
}

// --- Routes ---

app.get('/agents', requireAuth, async (req, res) => {
  try {
    const config = await readConfig();
    const agents = config.agents ?? {};
    const result = {};
    for (const [name, conf] of Object.entries(agents)) {
      result[name] = { enabled: conf.enabled ?? true };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/agents/:name/enabled', requireAuth, async (req, res) => {
  const { name } = req.params;
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: '"enabled" must be a boolean' });

  try {
    const config = await readConfig();
    if (!config.agents?.[name]) return res.status(404).json({ error: `Agent "${name}" not found` });
    config.agents[name].enabled = enabled;
    await writeConfig(config);
    res.json({ name, enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/agents/:name/workflow', requireAuth, async (req, res) => {
  try {
    const content = await readFile(workflowPath(req.params.name), 'utf8');
    res.json({ content });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'workflow.md not found' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/agents/:name/workflow', requireAuth, async (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: '"content" must be a string' });
  try {
    await writeFile(workflowPath(req.params.name), content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Agent directory not found' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/agents/:name/patterns', requireAuth, async (req, res) => {
  try {
    const raw = await readFile(memoryPath(req.params.name), 'utf8');
    const { patterns = [] } = JSON.parse(raw);
    res.json({ patterns });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'memory.json not found' });
    res.status(500).json({ error: err.message });
  }
});

// --- Start ---

const PORT = process.env.API_PORT ?? 3001;
await app.listen(PORT);
console.log(`Management API listening on port ${PORT}`);
