'use strict';

require('./services/Server');

const TelegramBot = require('./services/TelegramBot');
const WireGuard = require('./services/WireGuard');

WireGuard.getConfig()
  .then(async () => {
    await TelegramBot.start();
  })
  .catch((err) => {
  // eslint-disable-next-line no-console
    console.error(err);

    // eslint-disable-next-line no-process-exit
    process.exit(1);
  });

// Handle terminate signal
process.on('SIGTERM', async () => {
  // eslint-disable-next-line no-console
  console.log('SIGTERM signal received.');
  await TelegramBot.stop();
  await WireGuard.stopTrafficHistorySampler();
  await WireGuard.Shutdown();
  // eslint-disable-next-line no-process-exit
  process.exit(0);
});

// Handle interrupt signal
process.on('SIGINT', () => {
  // eslint-disable-next-line no-console
  console.log('SIGINT signal received.');
});
