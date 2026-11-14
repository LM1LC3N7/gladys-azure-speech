// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted Azure (no network) and
// the virtual clock: nothing fires by itself, `clock.advance(ms)` moves the
// time and runs the timers due on the way.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AzureSpeechApp } from '../../src/app.js';
import { SpeechError } from '../../src/azure.js';
import { createMemoryStore } from '../../src/store.js';
import { settle, testClock } from './clock.js';

export const SELECTOR = 'azure-speech';
// Made-up keys in the shape of Azure resource keys: never real ones.
export const KEY = '0123456789abcdef0123456789abcdef';
export const KEY_2 =
  'Zx9TESTKEYnotRealAbcdefGhijklmnopQrstuvWxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
export const CONFIG = { speech_key: KEY };
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
// 2026-11-11 10:00 UTC.
export const START = Date.UTC(2026, 10, 11, 10, 0, 0);

export const MP3 = Buffer.from('ID3fake-mp3-bytes');

export function memoryLogger() {
  const lines = [];
  const log = (level) => (msg) => lines.push(`${level} ${msg}`);
  return { lines, info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') };
}

const unescape = (text) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** The voice, the rate and the text of the SSML the app built (for the assertions). */
export function parseSsml(ssml) {
  const voice = /<voice name="([^"]+)">/.exec(ssml)?.[1];
  const lang = /xml:lang="([^"]+)"/.exec(ssml)?.[1];
  let inner = /<voice name="[^"]+">([\s\S]*)<\/voice>/.exec(ssml)?.[1] ?? '';
  const rate = /^<prosody rate="([^"]+)">/.exec(inner)?.[1] ?? 'medium';
  if (rate !== 'medium')
    inner = inner.replace(/^<prosody rate="[^"]+">/, '').replace(/<\/prosody>$/, '');
  return { voice, lang, rate, text: unescape(inner) };
}

/**
 * A scripted Azure factory: `answer(call)` -> `{ audio, characters }` or a
 * promise of it, or throws (a SpeechError). `calls` records every request,
 * with the voice, rate and text read back from its SSML.
 */
export function fakeSpeech(answer = () => ({ audio: MP3, characters: null })) {
  const azure = { answer, calls: [], clients: [], destroyed: 0 };
  azure.create = (options) => {
    const client = {
      options,
      synthesize: async (request) => {
        const call = { ...request, ...parseSsml(request.ssml), options };
        azure.calls.push(call);
        return azure.answer(call);
      },
      destroy: () => {
        azure.destroyed += 1;
      },
    };
    azure.clients.push(client);
    return client;
  };
  return azure;
}

/** A promise that never settles unless the signal aborts it. */
export function hangUntilAbort(call) {
  return new Promise((_, reject) => {
    call.signal.addEventListener('abort', () =>
      reject(new SpeechError('timeout', { code: 'timeout' })),
    );
  });
}

export async function makeApp({
  config = CONFIG,
  store = createMemoryStore(),
  azure = fakeSpeech(),
  clock = testClock({ start: START }),
  gladys = createFakeGladys({ selector: SELECTOR, config }),
  connect = true,
} = {}) {
  const logger = memoryLogger();
  const app = new AzureSpeechApp({
    gladys,
    store,
    createSpeech: azure.create,
    logger,
    now: clock.monotonic,
    wallNow: clock.now,
    timers: clock.timers,
    userAgent: 'gladys-azure-speech/test',
  });
  if (connect) {
    await app.start();
    await settle();
  }
  return { app, gladys, store, azure, clock, logger };
}

/** The last connection status: [connected, english message]. */
export function lastStatus(gladys) {
  const s = gladys.fake.connectionStatus;
  return s ? [s.connected, s.message?.en ?? ''] : undefined;
}

export { settle };
