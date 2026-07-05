const express = require('express');
const crypto = require('crypto');
const config = require('./config');

function verifySignature(rawBody, signature) {
  if (!config.botSharedSecret) {
    return true;
  }
  if (!signature) {
    return false;
  }
  const expected = crypto.createHmac('sha256', config.botSharedSecret).update(rawBody).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function startWebhookServer(handleBotEvent) {
  const app = express();
  app.use(express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));

  app.post('/bot/events', async (req, res) => {
    const signature = req.headers['x-bot-signature'];
    if (!verifySignature(req.rawBody || Buffer.from(''), signature)) {
      return res.status(403).json({ error: 'invalid_signature' });
    }

    const result = await handleBotEvent(req.body || {});
    return res.json(result);
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.listen(config.botPort, () => {
    // eslint-disable-next-line no-console
    console.log(`Bot webhook listening on ${config.botPort}`);
  });
}

module.exports = {
  startWebhookServer
};
