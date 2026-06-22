import { App } from '@slack/bolt';

const CEO_USER_ID = process.env.SLACK_CEO_USER_ID;

let app;

export function initSlack() {
  app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  return app;
}

/**
 * Register a handler for DMs from the CEO.
 * @param {(text: string, say: Function) => Promise<void>} handler
 */
export function onCEOMessage(handler) {
  app.message(async ({ message, say }) => {
    if (message.channel_type !== 'im') return;
    if (message.user !== CEO_USER_ID) return;
    if (!message.text) return;

    await handler(message.text.trim(), say);
  });
}

/**
 * Send a DM to the CEO.
 * @param {string} text
 */
export async function sendMessage(text) {
  await app.client.chat.postMessage({
    channel: CEO_USER_ID,
    text,
  });
}

export function getApp() {
  return app;
}
