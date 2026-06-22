import 'dotenv/config';
import { initSlack, onCEOMessage } from './tools/slack.js';

async function handleMessage(text, say) {
  await say(`I received: ${text}`);
}

async function start() {
  const app = initSlack();

  onCEOMessage(handleMessage);

  await app.start();
  console.log('nodejs-developer agent is running');
}

start().catch((err) => {
  console.error('Failed to start agent:', err);
  process.exit(1);
});
