const fetch = require('node-fetch');
const config = require('../config');
const { hmacSha256Hex } = require('../utils');

async function sendBotEvent(payload) {
  if (!config.botWebhookUrl) {
    return { skipped: true };
  }

  const body = JSON.stringify(payload);
  const signature = config.botSharedSecret
    ? hmacSha256Hex(config.botSharedSecret, body)
    : '';

  const headers = {
    'Content-Type': 'application/json'
  };

  if (signature) {
    headers['X-Bot-Signature'] = signature;
  }

  const response = await fetch(config.botWebhookUrl, {
    method: 'POST',
    headers,
    body
  });

  return {
    status: response.status
  };
}

module.exports = {
  sendBotEvent
};
