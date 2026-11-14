// -----------------------------------------------------------------------------
// Entry point: SDK wiring only. AzureSpeechApp (src/app.js) registers its
// handlers BEFORE connect(); /data holds the monthly count, the pause and the
// refused key (src/store.js); Azure Speech is reached through src/azure.js.
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { AzureSpeechApp } from './src/app.js';
import { createSpeech } from './src/azure.js';
import { FileStore } from './src/store.js';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const gladys = new GladysIntegration();
const app = new AzureSpeechApp({
  gladys,
  logger,
  store: new FileStore(),
  createSpeech,
  userAgent: `gladys-azure-speech/${version} (+https://github.com/LM1LC3N7/gladys-azure-speech)`,
});

gladys.handleShutdown(() => app.stop());

logger.info('Starting the Azure Speech integration...');
app.start().catch((err) => {
  logger.error(`Initial connection failed (${err?.name ?? 'Error'})`);
  process.exit(1);
});
