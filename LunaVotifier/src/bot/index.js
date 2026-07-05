const { startDiscordBot } = require('./discordBot');
const { startWebhookServer } = require('./webhookServer');

async function main() {
  const { handleBotEvent } = await startDiscordBot();
  startWebhookServer(handleBotEvent);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Bot failed to start:', err.message);
  process.exit(1);
});
