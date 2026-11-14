// -----------------------------------------------------------------------------
// The provider end to end through the SDK's fake Gladys, with a scripted Azure
// and the virtual clock: voices, cache, limit, pauses, refusals, queue,
// configuration and /data failures, status, secrets.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { billableChars, buildSsml, cleanText, fp8 } from '../src/app.js';
import { SpeechError } from '../src/azure.js';
import { createMemoryStore } from '../src/store.js';
import { testClock } from './helpers/clock.js';
import {
  CONFIG,
  HOUR,
  KEY,
  KEY_2,
  MINUTE,
  MP3,
  SECOND,
  SELECTOR,
  START,
  fakeSpeech,
  hangUntilAbort,
  lastStatus,
  makeApp,
  settle,
} from './helpers/app.js';

const AUDIO = `audio/mpeg;base64,${MP3.toString('base64')}`;
const refused = () => {
  throw new SpeechError('refused', { status: 401, code: 'HTTP 401' });
};
const throttled = (retryAfterMs) => () => {
  throw new SpeechError('throttled', { status: 429, code: 'HTTP 429', retryAfterMs });
};

test('a text becomes an MP3 clip in the voice of the language', async () => {
  const { gladys, azure } = await makeApp({ config: { ...CONFIG, voice_en: 'en-GB-SoniaNeural' } });
  const fr = await gladys.fake.ttsSynthesize('Bonjour', 'fr');
  assert.deepEqual(fr, { success: true, data: { audio: AUDIO } });
  await gladys.fake.ttsSynthesize('Hello', 'en-GB');
  await gladys.fake.ttsSynthesize('Hallo', 'DE');
  await gladys.fake.ttsSynthesize('Hola', 'es');
  await gladys.fake.ttsSynthesize('Unknown', null);
  assert.deepEqual(
    azure.calls.map((c) => [c.voice, c.lang, c.rate, c.text]),
    [
      ['fr-FR-DeniseNeural', 'fr-FR', 'medium', 'Bonjour'],
      ['en-GB-SoniaNeural', 'en-GB', 'medium', 'Hello'],
      ['de-DE-KatjaNeural', 'de-DE', 'medium', 'Hallo'],
      ['en-GB-SoniaNeural', 'en-GB', 'medium', 'Hola'],
      ['en-GB-SoniaNeural', 'en-GB', 'medium', 'Unknown'],
    ],
  );
  // One client for the same keys and region, with the user agent of the module.
  assert.equal(azure.clients.length, 1);
  assert.deepEqual(azure.clients[0].options, {
    region: 'westeurope',
    key: KEY,
    userAgent: 'gladys-azure-speech/test',
  });
  assert.deepEqual(lastStatus(gladys), [
    true,
    'Azure Speech answered (voices fr-FR-DeniseNeural, en-GB-SoniaNeural, de-DE-KatjaNeural).',
  ]);
});

test('the default language and the rate come from the configuration; the text is escaped', async () => {
  const { gladys, azure } = await makeApp({
    config: { ...CONFIG, default_language: 'fr', speaking_rate: 'slow' },
  });
  await gladys.fake.ttsSynthesize(`Tom & "Jerry" <b>'s</voice><voice name="x">`, null);
  assert.equal(azure.calls[0].voice, 'fr-FR-DeniseNeural');
  assert.equal(
    azure.calls[0].ssml,
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="fr-FR">' +
      '<voice name="fr-FR-DeniseNeural"><prosody rate="slow">Tom &amp; "Jerry" ' +
      '&lt;b&gt;\'s&lt;/voice&gt;&lt;voice name="x"&gt;</prosody></voice></speak>',
  );
  // Without a rate, no prosody element.
  const plain = await makeApp();
  await plain.gladys.fake.ttsSynthesize('Hi', 'en');
  assert.equal(
    plain.azure.calls[0].ssml,
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">' +
      '<voice name="en-US-JennyNeural">Hi</voice></speak>',
  );
});

test('control characters become spaces, 2,000 characters at most; empty text sends nothing', async () => {
  const { gladys, azure } = await makeApp();
  await gladys.fake.ttsSynthesize(`a\u0000b\u001bc\nd${'x'.repeat(3000)}`, 'en');
  assert.equal(azure.calls[0].text.slice(0, 7), 'a b c\nd');
  assert.equal(azure.calls[0].text.length, 2000);
  const empty = await gladys.fake.ttsSynthesize(' \u0000 ', 'fr');
  assert.deepEqual(empty, { success: false, error: 'Rien à dire : le texte est vide.' });
  assert.equal(azure.calls.length, 1);
});

test('the same text in the same voice is served from memory, not billed twice', async () => {
  const { gladys, azure, app, clock } = await makeApp();
  await gladys.fake.ttsSynthesize('Door open', 'en');
  const again = await gladys.fake.ttsSynthesize('Door open', 'en');
  assert.deepEqual(again.data, { audio: AUDIO });
  assert.equal(azure.calls.length, 1);
  assert.equal(app.usage.used, 9);
  await gladys.fake.ttsSynthesize('Door open', 'fr'); // another voice
  assert.equal(azure.calls.length, 2);
  // 21 other texts: the first one is evicted (20 clips at most).
  for (let i = 0; i < 21; i += 1) await gladys.fake.ttsSynthesize(`Text ${i}`, 'en');
  await gladys.fake.ttsSynthesize('Door open', 'en');
  assert.equal(azure.calls.length, 24);
  // A day later the clip is asked again.
  await gladys.fake.ttsSynthesize('Text 20', 'en');
  assert.equal(azure.calls.length, 24);
  await clock.advance(24 * HOUR + SECOND);
  await gladys.fake.ttsSynthesize('Text 20', 'en');
  assert.equal(azure.calls.length, 25);
});

test('invalid configuration: nothing sent, the reason in the status, the value never shown', async () => {
  const cases = [
    [{ speech_key: 'short0123' }, 'not valid'],
    [{ speech_key: `${KEY}\r\nX-Evil: 1` }, 'not valid'],
    [{ speech_key: `${KEY.slice(0, 16)} ${KEY.slice(16)}x` }, 'not valid'],
    [{ speech_key: 'é'.repeat(32) }, 'not valid'],
    [{ ...CONFIG, region: 'westeurope.evil.example' }, 'Unknown Azure region.'],
    [{ ...CONFIG, region: 'mars' }, 'Unknown Azure region.'],
    [{ ...CONFIG, region: ['westeurope'] }, 'Unknown Azure region.'],
    [{ ...CONFIG, region: 1 }, 'Unknown Azure region.'],
    [{ ...CONFIG, voice_fr: 'en-US-JennyNeural' }, 'Unknown voice.'],
    [{ ...CONFIG, monthly_character_limit: '12.5' }, 'whole number'],
    [{ ...CONFIG, monthly_character_limit: 999 }, 'whole number'],
    [{}, 'Enter the key of your Azure Speech resource'],
  ];
  for (const [config, reason] of cases) {
    const { gladys, azure } = await makeApp({ config });
    const ack = await gladys.fake.ttsSynthesize('Hello', 'en');
    assert.equal(ack.success, false);
    assert.equal(azure.calls.length, 0);
    const [connected, message] = lastStatus(gladys);
    assert.equal(connected, false);
    assert.ok(message.includes(reason), message);
    for (const value of Object.values(config)) {
      if (value === KEY) continue;
      assert.ok(!message.includes(String(value)) && !ack.error.includes(String(value)));
    }
  }
});

test('a key refused by Azure (401): kept refused across a restart, a new key is tried, Test lifts it', async () => {
  const store = createMemoryStore();
  const azure = fakeSpeech(refused);
  const first = await makeApp({ store, azure });
  const ack = await first.gladys.fake.ttsSynthesize('Hello', 'en');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Azure refused this key/);
  await first.gladys.fake.ttsSynthesize('Hello again', 'en');
  assert.equal(azure.calls.length, 1, 'never sent again by itself');
  assert.equal(lastStatus(first.gladys)[0], false);
  // /data keeps 8 bits of a salted hash, never a key.
  const saved = JSON.stringify(store.data);
  assert.ok(!saved.includes(KEY));
  assert.match(store.data.refused.salt, /^[0-9a-f]{32}$/);
  assert.ok(Number.isInteger(store.data.refused.fp) && store.data.refused.fp <= 255);
  // Saving the same keys again changes nothing.
  await first.gladys.fake.configUpdated({ ...CONFIG });
  await first.gladys.fake.ttsSynthesize('Hello 3', 'en');
  assert.equal(azure.calls.length, 1);
  await first.app.stop();

  // Restart with the same keys: still refused, nothing sent.
  const second = await makeApp({ store, azure });
  assert.match(lastStatus(second.gladys)[1], /Azure refused this key/);
  await second.gladys.fake.ttsSynthesize('Hello', 'en');
  assert.equal(azure.calls.length, 1);
  // The Test button sends anyway; its success lifts the refusal.
  azure.answer = () => ({ audio: MP3, characters: 48 });
  const tested = await second.gladys.fake.action('test_voice', {});
  assert.equal(tested.success, true);
  assert.match(tested.data.message.en, /voice en-US-JennyNeural, 1 KB/);
  assert.equal(azure.calls.length, 2);
  assert.equal(store.data.refused, null);
  await second.gladys.fake.ttsSynthesize('Hello', 'en');
  assert.equal(azure.calls.length, 3);
  await second.app.stop();
});

test('new keys after a refusal are always tried', async () => {
  const azure = fakeSpeech(refused);
  const { gladys } = await makeApp({ azure });
  await gladys.fake.ttsSynthesize('Hello', 'en');
  azure.answer = () => ({ audio: MP3 });
  await gladys.fake.configUpdated({ speech_key: KEY_2 });
  const ack = await gladys.fake.ttsSynthesize('Hello', 'en');
  assert.equal(ack.success, true);
  assert.equal(azure.calls.length, 2);
  assert.equal(azure.destroyed, 1, 'the client of the old keys is closed');
  assert.equal(azure.calls[1].options.key, KEY_2);
});

test('a 403 (quota of the free tier, network rules) is not a refusal of the key', async () => {
  const azure = fakeSpeech(() => {
    throw new SpeechError('denied', { status: 403, code: 'HTTP 403' });
  });
  const { gladys } = await makeApp({ azure });
  const ack = await gladys.fake.ttsSynthesize('Hello', 'en');
  assert.match(ack.error, /Azure denied the synthesis \(HTTP 403\)/);
  assert.match(lastStatus(gladys)[1], /not taken as refused/);
  const again = await gladys.fake.ttsSynthesize('Hello 2', 'en');
  assert.match(again.error, /HTTP 403/);
  azure.answer = () => ({ audio: MP3 });
  assert.equal((await gladys.fake.ttsSynthesize('Hello', 'en')).success, true);
  assert.equal(azure.calls.length, 3);
  assert.equal(lastStatus(gladys)[0], true);
});

test('throttled: a pause of 60 s doubled up to 1 h on every path, Retry-After up to 6 h', async () => {
  const store = createMemoryStore();
  const azure = fakeSpeech(throttled());
  const { gladys, clock, app } = await makeApp({ store, azure });
  let ack = await gladys.fake.ttsSynthesize('Hello', 'en');
  assert.match(ack.error, /no request before 10:01 \(UTC\)/);
  assert.equal(lastStatus(gladys)[0], false);
  // During the pause: nothing sent, the Test button included.
  await clock.advance(59 * SECOND);
  await gladys.fake.ttsSynthesize('Hello', 'en');
  assert.equal((await gladys.fake.action('test_voice', {})).success, false);
  assert.equal(azure.calls.length, 1);
  await clock.advance(2 * SECOND);
  await gladys.fake.ttsSynthesize('Hello', 'en');
  assert.equal(azure.calls.length, 2);
  assert.equal(app.pauseStep, 2 * MINUTE);
  // Doubling stops at 1 h.
  for (let i = 0; i < 8; i += 1) {
    await clock.advance(HOUR + SECOND);
    await gladys.fake.ttsSynthesize('Hello', 'en');
  }
  assert.equal(app.pauseStep, HOUR);
  // A Retry-After longer than the step is honored, never beyond 6 h.
  azure.answer = throttled(30 * HOUR);
  await clock.advance(HOUR + SECOND);
  await gladys.fake.ttsSynthesize('Hello', 'en');
  const calls = azure.calls.length;
  await clock.advance(6 * HOUR - MINUTE);
  await gladys.fake.ttsSynthesize('Hello', 'en');
  assert.equal(azure.calls.length, calls);
  // Kept in /data (wall time and step).
  assert.ok(store.data.pause.until > clock.now());
  assert.equal(store.data.pause.step, HOUR);
  await clock.advance(2 * MINUTE);
  azure.answer = () => ({ audio: MP3 });
  ack = await gladys.fake.ttsSynthesize('Hello', 'en');
  assert.equal(ack.success, true);
  assert.equal(app.pauseStep, 0, 'a success resets the step');
  assert.equal(store.data.pause, null);
});

test('a server error pauses too; the pause survives a restart; a far future date is invalid', async () => {
  const store = createMemoryStore();
  const azure = fakeSpeech(() => {
    throw new SpeechError('unavailable', { status: 503, code: 'HTTP 503' });
  });
  const clock = testClock({ start: START });
  const first = await makeApp({ store, azure, clock });
  await first.gladys.fake.ttsSynthesize('Hello', 'en');
  await first.app.stop();
  await clock.advance(30 * SECOND);
  const second = await makeApp({ store, azure, clock });
  await second.gladys.fake.ttsSynthesize('Hello', 'en');
  assert.equal(azure.calls.length, 1, 'still paused after the restart');
  await clock.advance(31 * SECOND);
  await second.gladys.fake.ttsSynthesize('Hello', 'en');
  assert.equal(azure.calls.length, 2);
  await second.app.stop();

  const far = createMemoryStore({ pause: { until: clock.now() + 7 * HOUR, step: 60_000 } });
  const third = await makeApp({ store: far, azure: fakeSpeech(), clock });
  assert.equal((await third.gladys.fake.ttsSynthesize('Hello', 'en')).success, true);
});

test('the monthly limit: counted before sending, refunded on an answered error, kept on a timeout', async () => {
  const store = createMemoryStore();
  const azure = fakeSpeech();
  const config = { ...CONFIG, monthly_character_limit: 1000 };
  const { gladys, clock, app } = await makeApp({ store, azure, config });
  let seenBefore;
  azure.answer = () => {
    seenBefore = store.data.usage?.used;
    return { audio: MP3, characters: null };
  };
  await gladys.fake.ttsSynthesize('x'.repeat(400), 'en');
  assert.equal(seenBefore, 400, 'saved before the request left');
  azure.answer = () => ({ audio: MP3 });
  await gladys.fake.ttsSynthesize('y'.repeat(300), 'en');
  assert.equal(app.usage.used, 700);
  // A 400 answer is not billed: refunded.
  azure.answer = () => {
    throw new SpeechError('invalid', { status: 400, code: 'HTTP 400', detail: 'HTTP 400' });
  };
  const invalid = await gladys.fake.ttsSynthesize('z'.repeat(100), 'en');
  assert.match(invalid.error, /Azure Speech refused the request \(HTTP 400\)/);
  assert.equal(app.usage.used, 700);
  // A timeout may have been billed: kept.
  azure.answer = hangUntilAbort;
  const pending = gladys.fake.ttsSynthesize('w'.repeat(200), 'en');
  await settle();
  assert.equal(azure.calls.length, 4);
  await clock.advance(26 * SECOND);
  assert.match((await pending).error, /did not answer in time/);
  assert.equal(app.usage.used, 900);
  // Over the limit: refused before sending.
  azure.answer = () => ({ audio: MP3 });
  const calls = azure.calls.length;
  const over = await gladys.fake.ttsSynthesize('v'.repeat(101), 'fr');
  assert.match(over.error, /limite mensuelle de 1000 caractères est atteinte \(900 envoyés/);
  assert.equal(azure.calls.length, calls);
  assert.equal((await gladys.fake.ttsSynthesize('v'.repeat(100), 'en')).success, true);
  assert.match(lastStatus(gladys)[1], /monthly limit/);
  assert.equal(store.data.usage.month, '2026-11');
  // A new month (UTC) starts from zero.
  await clock.advance(20 * 24 * HOUR);
  assert.equal((await gladys.fake.ttsSynthesize('v'.repeat(500), 'en')).success, true);
  assert.deepEqual(store.data.usage, { month: '2026-12', used: 500 });
});

test('the count survives a restart; a connection never made is refunded', async () => {
  const store = createMemoryStore({ usage: { month: '2026-11', used: 950 } });
  const azure = fakeSpeech(() => {
    throw new SpeechError('network', { code: 'ECONNREFUSED', sent: false });
  });
  const { gladys, app } = await makeApp({
    store,
    azure,
    config: { ...CONFIG, monthly_character_limit: '1000' },
  });
  assert.equal(app.usage.used, 950);
  const ack = await gladys.fake.ttsSynthesize('x'.repeat(40), 'en');
  assert.match(ack.error, /could not be reached/);
  assert.equal(app.usage.used, 950);
  assert.equal((await gladys.fake.ttsSynthesize('x'.repeat(60), 'en')).success, false);
  assert.equal(azure.calls.length, 1);
});

test('2 requests in flight, 8 waiting, the next refused; a waiter gives up at the deadline', async () => {
  const releases = [];
  const azure = fakeSpeech((call) => {
    const aborted = hangUntilAbort(call);
    return Promise.race([
      aborted,
      new Promise((resolve) => releases.push(() => resolve({ audio: MP3 }))),
    ]);
  });
  const { gladys, clock } = await makeApp({ azure });
  const acks = [];
  for (let i = 0; i < 11; i += 1) acks.push(gladys.fake.ttsSynthesize(`Text ${i}`, 'en'));
  await settle();
  assert.equal(azure.calls.length, 2);
  const busy = await acks[10];
  assert.match(busy.error, /Too many announcements at once/);
  releases[0]();
  await settle();
  assert.equal(azure.calls.length, 3);
  // The others wait; at the deadline they give up, never sent.
  await clock.advance(25 * SECOND);
  const results = await Promise.all(acks.slice(0, 10));
  assert.equal(results.filter((r) => r.success).length, 1);
  assert.ok(results.slice(3).every((r) => /did not answer in time/.test(r.error)));
  assert.equal(azure.calls.length, 3);
});

test('a request that hangs is aborted at 25 s, inside the 30 s of Gladys', async () => {
  const azure = fakeSpeech(hangUntilAbort);
  const { gladys, clock } = await makeApp({ azure });
  const pending = gladys.fake.ttsSynthesize('Hello', 'en');
  await clock.advance(24 * SECOND);
  assert.equal(azure.calls[0].signal.aborted, false);
  await clock.advance(1 * SECOND + 1);
  assert.equal(azure.calls[0].signal.aborted, true);
  assert.equal((await pending).success, false);
});

test('getConfig failing in connected: retried 5 s, 10 s, 20 s... without end, then ready', async () => {
  const gladys = createFakeGladys({ selector: SELECTOR, config: CONFIG });
  const real = gladys.getConfig.bind(gladys);
  // The SDK reads the configuration itself while connecting (call 1); the
  // app's reads in its 'connected' listener (calls 2, 3, 4) fail.
  let calls = 0;
  const tries = [];
  const clock = testClock({ start: START });
  gladys.getConfig = async () => {
    calls += 1;
    if (calls === 1) return real();
    tries.push(clock.monotonic());
    if (calls <= 4) throw new Error('503');
    return real();
  };
  const { azure } = await makeApp({ gladys, clock, connect: true });
  assert.equal(tries.length, 1);
  assert.match(lastStatus(gladys)[1], /could not be read from Gladys yet/);
  // A synthesis meanwhile waits 3 s at most, then says why.
  const early = gladys.fake.ttsSynthesize('Hello', 'en');
  await clock.advance(3 * SECOND + 1);
  assert.match((await early).error, /configuration could not be read/);
  await clock.advance(2 * SECOND);
  assert.equal(tries.length, 2);
  await clock.advance(10 * SECOND);
  assert.equal(tries.length, 3);
  await clock.advance(20 * SECOND);
  assert.equal(tries.length, 4);
  assert.deepEqual(
    tries.slice(1).map((at, i) => Math.round((at - tries[i]) / 1000)),
    [5, 10, 20],
  );
  assert.deepEqual(lastStatus(gladys), [
    true,
    'Ready. The key is checked by Azure at the first announcement or with the Test button.',
  ]);
  assert.equal((await gladys.fake.ttsSynthesize('Hello', 'en')).success, true);
  assert.equal(azure.calls.length, 1);
});

test('a reconnection reads the configuration again and republishes the status', async () => {
  const { gladys, azure } = await makeApp();
  await gladys.fake.ttsSynthesize('Hello', 'en');
  const statuses = gladys.fake.connectionStatuses.length;
  gladys.fake.config = { ...CONFIG, voice_en: 'en-US-BrianNeural' };
  await gladys.disconnect();
  await gladys.connect();
  await settle();
  assert.ok(gladys.fake.connectionStatuses.length > statuses);
  await gladys.fake.ttsSynthesize('Hello', 'en');
  assert.equal(azure.calls.at(-1).voice, 'en-US-BrianNeural');
});

test('/data unreadable: never overwritten, read again every 10 s, one read at a time, merged', async () => {
  const store = createMemoryStore({ usage: { month: '2026-11', used: 100 } });
  store.unreadable = true;
  const { gladys, clock, app } = await makeApp({ store });
  assert.equal(store.loads, 1);
  // Synthesis still works; nothing written over the unreadable file.
  assert.equal((await gladys.fake.ttsSynthesize('Hello', 'en')).success, true);
  assert.equal(store.saves, 0);
  await clock.advance(10 * SECOND);
  assert.equal(store.loads, 2);
  // A slow read: no second read while it hangs.
  store.unreadable = false;
  store.hang = true;
  await clock.advance(10 * SECOND);
  assert.equal(store.loads, 3);
  await clock.advance(30 * SECOND);
  assert.equal(store.loads, 3);
  assert.equal(app.storeReady, false);
  app.loadStore(); // asked again meanwhile: still one read
  assert.equal(store.loads, 3);
  // Readable at last: the count of before and since is merged, then saved.
  store.hang = false;
  app.loading = null; // the hung read is abandoned (test only)
  await app.loadStore();
  assert.equal(app.usage.used, 105);
  assert.deepEqual(store.data.usage, { month: '2026-11', used: 105 });
});

test('a slow /data delays the first synthesis 2 s at most; a failing save blocks nothing', async () => {
  const store = createMemoryStore();
  store.hang = true;
  const { gladys, clock } = await makeApp({ store });
  const pending = gladys.fake.ttsSynthesize('Hello', 'en');
  await clock.advance(2 * SECOND + 1);
  assert.equal((await pending).success, true);

  const failing = createMemoryStore();
  failing.failSave = true;
  const second = await makeApp({ store: failing });
  assert.equal((await second.gladys.fake.ttsSynthesize('Hello', 'en')).success, true);
  assert.ok(second.logger.lines.some((l) => l.includes('/data not saved')));
});

test('one status per change; secrets never in logs, statuses, /data or errors', async () => {
  const store = createMemoryStore();
  const azure = fakeSpeech(() => {
    throw new SpeechError('invalid', { status: 400, code: 'HTTP 400', detail: 'HTTP 400' });
  });
  const { gladys, logger } = await makeApp({ store, azure });
  const started = gladys.fake.connectionStatuses.length;
  const ack = await gladys.fake.ttsSynthesize('Hello', 'en');
  assert.match(ack.error, /refused the request \(HTTP 400\): check the voice/);
  await gladys.fake.ttsSynthesize('Hello 2', 'en');
  azure.answer = refused;
  await gladys.fake.ttsSynthesize('Hello 3', 'en');
  // After the start (a connection republishes the status on purpose).
  const statuses = gladys.fake.connectionStatuses.slice(started).map((s) => JSON.stringify(s));
  for (let i = 1; i < statuses.length; i += 1) assert.notEqual(statuses[i], statuses[i - 1]);
  const everything = [...logger.lines, ...statuses, JSON.stringify(store.data), ack.error].join(
    '\n',
  );
  for (const secret of [KEY, 'Hello']) {
    assert.ok(!everything.includes(secret), `${secret} leaked`);
  }
});

test('the Test button: a short sentence in the chosen voice, the outcome under the button', async () => {
  const { gladys, azure, clock } = await makeApp();
  const ack = await gladys.fake.action('test_voice', { language: 'de' });
  assert.equal(ack.success, true);
  assert.equal(azure.calls[0].voice, 'de-DE-KatjaNeural');
  assert.equal(azure.calls[0].text, 'Hallo, hier spricht Azure Speech für Gladys.');
  assert.match(ack.data.message.fr, /voix de-DE-KatjaNeural, 1 Ko de MP3/);
  await gladys.fake.action('test_voice', { language: 'fr' });
  assert.equal(azure.calls[1].voice, 'fr-FR-DeniseNeural');
  // Never cached: the button always asks Azure.
  await gladys.fake.action('test_voice', { language: 'fr' });
  assert.equal(azure.calls.length, 3);
  void clock;
});

test('stop: waiters rejected, requests aborted, no timer left', async () => {
  const azure = fakeSpeech(hangUntilAbort);
  const store = createMemoryStore();
  store.unreadable = true;
  const { gladys, app, clock } = await makeApp({ azure, store });
  const acks = [0, 1, 2].map((i) => gladys.fake.ttsSynthesize(`T${i}`, 'en'));
  await settle();
  await app.stop();
  const results = await Promise.all(acks);
  assert.ok(results.every((r) => r.success === false));
  assert.ok(azure.calls.every((c) => c.signal.aborted));
  assert.equal(clock.pending, 0);
  const loads = store.loads;
  await clock.advance(HOUR);
  assert.equal(store.loads, loads);
});

test('a pause in a slow /data still holds the first synthesis (read awaited 2 s at most)', async () => {
  const clock = testClock({ start: START });
  const store = createMemoryStore({ pause: { until: START + 5 * MINUTE, step: MINUTE } });
  const load = store.load;
  store.load = () =>
    new Promise((resolve) => clock.timers.setTimeout(() => resolve(load()), SECOND));
  const { gladys, azure } = await makeApp({ store, clock });
  const pending = gladys.fake.ttsSynthesize('Hello', 'en');
  await settle();
  await clock.advance(SECOND + 1);
  const ack = await pending;
  assert.match(ack.error, /no request before 10:05/);
  assert.equal(azure.calls.length, 0);
});

test('one client per region and key: a change of key or region makes a new one', async () => {
  const { app, azure } = await makeApp();
  const base = { ok: true, region: 'westeurope', key: KEY };
  const a = app.clientFor(base);
  assert.equal(app.clientFor({ ...base }), a);
  const b = app.clientFor({ ...base, key: KEY_2 });
  assert.notEqual(b, a);
  assert.equal(b.options.key, KEY_2);
  const c = app.clientFor({ ...base, region: 'eastus' });
  assert.equal(c.options.region, 'eastus');
  assert.equal(azure.destroyed, 2);
});

test('identical requests at the same time share one Azure request (a scene on 5 speakers)', async () => {
  const releases = [];
  const azure = fakeSpeech(
    () => new Promise((resolve) => releases.push(() => resolve({ audio: MP3, characters: null }))),
  );
  const { gladys, app } = await makeApp({ azure });
  const text = 'The door is open now';
  const acks = [0, 1, 2, 3, 4].map(() => gladys.fake.ttsSynthesize(text, 'en'));
  await settle();
  assert.equal(azure.calls.length, 1);
  releases[0]();
  const results = await Promise.all(acks);
  assert.ok(results.every((r) => r.success && r.data.audio === AUDIO));
  assert.equal(app.usage.used, 20);
  assert.equal(app.shared.size, 0);
  // A shared failure: one request, every caller told, never sent again by itself.
  azure.answer = () => {
    throw new SpeechError('invalid', { status: 400, code: 'HTTP 400', detail: 'HTTP 400' });
  };
  const failed = await Promise.all([1, 2, 3].map(() => gladys.fake.ttsSynthesize('Other', 'en')));
  assert.ok(failed.every((r) => r.success === false && /refused the request/.test(r.error)));
  assert.equal(azure.calls.length, 2);
  assert.equal(app.shared.size, 0);
});

for (const variant of ['throttled', 'refused', 'limit']) {
  test(`the guard is checked again after the queue: ${variant}`, async () => {
    const releases = [];
    const azure = fakeSpeech(
      () =>
        new Promise((resolve, reject) =>
          releases.push((err) => (err ? reject(err) : resolve({ audio: MP3 }))),
        ),
    );
    const config = { ...CONFIG, monthly_character_limit: 10_000 };
    const { gladys } = await makeApp({ azure, config });
    const running = [0, 1].map((i) => gladys.fake.ttsSynthesize(`${i}`.repeat(400), 'en'));
    const waiting = [2, 3, 4].map((i) => gladys.fake.ttsSynthesize(`${i}`.repeat(300), 'en'));
    await settle();
    assert.equal(azure.calls.length, 2);
    if (variant === 'throttled') {
      releases[0](new SpeechError('throttled', { status: 429, code: 'HTTP 429' }));
    } else if (variant === 'refused') {
      releases[0](new SpeechError('refused', { status: 401, code: 'HTTP 401' }));
    } else {
      await gladys.fake.configUpdated({ ...CONFIG, monthly_character_limit: 1000 });
      releases[0]();
    }
    await settle();
    releases[1]?.();
    await Promise.all(running);
    const results = await Promise.all(waiting);
    const expected = {
      throttled: /no request before/,
      refused: /Azure refused this key/,
      limit: /monthly limit of 1000 characters is reached/,
    }[variant];
    for (const r of results) assert.match(r.error, expected);
    assert.equal(azure.calls.length, 2, 'none of the waiting requests left');
  });
}

test('each refusal draws a new salt; another month in /data is not counted', async () => {
  const store = createMemoryStore({ usage: { month: '2026-10', used: 999_000 } });
  const azure = fakeSpeech(refused);
  const { gladys, app } = await makeApp({ store, azure });
  assert.equal(app.usage.used, 0, 'October does not count in November');
  assert.deepEqual(store.data.usage, { month: '2026-11', used: 0 }, 'never saved as October');
  await gladys.fake.ttsSynthesize('Hello', 'en');
  const first = store.data.refused.salt;
  await gladys.fake.action('test_voice', {});
  assert.equal(azure.calls.length, 2);
  assert.notEqual(store.data.refused.salt, first);
});

/** Keys that differ from KEY only in their last 3 characters. */
function* candidates() {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const a of abc)
    for (const b of abc) for (const c of abc) yield `${KEY.slice(0, 29)}${a}${b}${c}`;
}

test('a new key sharing the 8-bit fingerprint of a refused one is still tried (same process)', async () => {
  const store = createMemoryStore();
  const azure = fakeSpeech(refused);
  const { gladys } = await makeApp({ store, azure });
  await gladys.fake.ttsSynthesize('Hello', 'en');
  const { salt, fp } = store.data.refused;
  const base = { region: 'westeurope' };
  let twin;
  for (const key of candidates()) {
    if (key !== KEY && fp8(salt, { ...base, key }) === fp) {
      twin = key;
      break;
    }
  }
  assert.ok(twin, 'a collision exists among 17,576 candidates');
  azure.answer = () => ({ audio: MP3 });
  await gladys.fake.configUpdated({ ...CONFIG, speech_key: twin });
  assert.equal((await gladys.fake.ttsSynthesize('Hello', 'en')).success, true);
  assert.equal(azure.calls.length, 2);
});

test('brute force: the 8-bit fingerprint points at about 1 key in 256, never at one key', () => {
  const salt = '0123456789abcdef0123456789abcdef';
  const base = { region: 'westeurope' };
  const target = fp8(salt, { ...base, key: KEY });
  let n = 0;
  let matches = 0;
  for (const key of candidates()) {
    n += 1;
    if (fp8(salt, { ...base, key }) === target) matches += 1;
  }
  // About n / 256 = 69 keys fit the fingerprint: it tells nothing of the key.
  assert.ok(matches > n / 256 / 2 && matches < (n / 256) * 2, `${matches} of ${n}`);
});

test('a refusal is tied to the region; a cut connection stays counted; /data unread is said', async () => {
  const store = createMemoryStore();
  store.unreadable = true;
  const azure = fakeSpeech(refused);
  const { gladys, app } = await makeApp({
    store,
    azure,
    config: { ...CONFIG, region: 'francecentral' },
  });
  assert.match(lastStatus(gladys)[1], /monthly counter is not saved/);
  await gladys.fake.ttsSynthesize('Hello', 'en');
  await gladys.fake.configUpdated({ ...CONFIG, region: 'westeurope' });
  azure.answer = () => {
    throw new SpeechError('network', { code: 'ECONNRESET', sent: true });
  };
  const cut = await gladys.fake.ttsSynthesize('Hello', 'en');
  assert.equal(azure.calls.length, 2, 'tried again in another region');
  assert.match(cut.error, /connection was cut/);
  assert.equal(app.usage.used, 5, 'maybe billed: kept');
});

test('the count reaches /data before the request leaves (1 s at most for a stuck volume)', async () => {
  const clock = testClock({ start: START });
  const store = createMemoryStore();
  const save = store.save;
  let delay = 500;
  store.save = (next) =>
    new Promise((resolve) => clock.timers.setTimeout(() => resolve(save(next)), delay));
  const { gladys, azure } = await makeApp({ store, clock });
  const first = gladys.fake.ttsSynthesize('Hello', 'en');
  await settle();
  assert.equal(azure.calls.length, 0, 'waits for the write');
  await clock.advance(500);
  assert.equal(azure.calls.length, 1);
  assert.equal(store.data.usage.used, 5);
  assert.equal((await first).success, true);
  // A volume that never answers holds the request 1 s, not more.
  delay = 3_600_000;
  const second = gladys.fake.ttsSynthesize('Hello again', 'en');
  await settle();
  await clock.advance(999);
  assert.equal(azure.calls.length, 1);
  await clock.advance(2);
  assert.equal(azure.calls.length, 2);
  assert.equal((await second).success, true);
});

test('/data failing or slow never blocks a synthesis; the limit holds in memory; the status says it', async () => {
  const clock = testClock({ start: START });
  const store = createMemoryStore();
  store.failSave = true;
  const config = { ...CONFIG, monthly_character_limit: 1000 };
  const { gladys, azure, app } = await makeApp({ store, clock, config });
  assert.equal((await gladys.fake.ttsSynthesize('x'.repeat(600), 'en')).success, true);
  assert.equal(azure.calls.length, 1);
  assert.match(
    lastStatus(gladys)[1],
    /monthly counter is not saved.*only guaranteed until the next restart/,
  );
  // The limit still holds, counted in memory.
  const over = await gladys.fake.ttsSynthesize('y'.repeat(600), 'en');
  assert.match(over.error, /monthly limit/);
  assert.equal(azure.calls.length, 1);
  assert.equal(app.usage.used, 600);
  // Writable again: the status says so no more.
  store.failSave = false;
  await gladys.fake.ttsSynthesize('z'.repeat(10), 'en');
  assert.equal(lastStatus(gladys)[0], true);
  assert.doesNotMatch(lastStatus(gladys)[1], /not saved/);

  // A write that hangs: the request leaves after 1 s, the status says it.
  const save = store.save;
  store.save = () => new Promise(() => {});
  const pending = gladys.fake.ttsSynthesize('w'.repeat(10), 'en');
  await settle();
  await clock.advance(SECOND + 1);
  assert.equal((await pending).success, true);
  assert.match(lastStatus(gladys)[1], /monthly counter is not saved/);
  store.save = save;
});

test('stop while the count is being written: nothing sent, no client made', async () => {
  const store = createMemoryStore();
  const { gladys, azure, app, clock } = await makeApp({ store });
  store.save = () => new Promise(() => {});
  const pending = gladys.fake.ttsSynthesize('Hello', 'en');
  await settle();
  await app.stop();
  await clock.advance(SECOND + 1); // the 1 s budget of the write ends
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.equal(azure.calls.length, 0);
  assert.equal(azure.clients.length, 0);
});

test('a read-only /data is said as soon as the first write fails, before any synthesis', async () => {
  const store = createMemoryStore();
  store.failSave = true;
  const { gladys, azure } = await makeApp({ store });
  assert.equal(azure.calls.length, 0);
  assert.match(lastStatus(gladys)[1], /monthly counter is not saved/);
});

test('billable characters: markup and entities count, speak and voice tags do not, Han twice', () => {
  const plain = buildSsml('Porte ouverte', 'fr-FR-DeniseNeural', 'medium');
  assert.equal(billableChars(plain), 13);
  // A rate other than normal: the prosody tags are billed (about 32 characters).
  const slow = buildSsml('Porte ouverte', 'fr-FR-DeniseNeural', 'slow');
  assert.equal(billableChars(slow), 13 + '<prosody rate="slow">'.length + '</prosody>'.length);
  // Apostrophes and quotes are left as they are (1 each); &, < and > cost their entity.
  const quoted = buildSsml(`L'entrée "A" & <B>`, 'fr-FR-DeniseNeural', 'medium');
  assert.equal(billableChars(quoted), `L'entrée "A" &amp; &lt;B&gt;`.length);
  // Chinese characters count twice; an astral character is one code point.
  assert.equal(billableChars(buildSsml('客厅灯已打开', 'en-US-JennyNeural', 'medium')), 12);
  assert.equal(billableChars(buildSsml('ok 😀', 'en-US-JennyNeural', 'medium')), 4);
});

test('the limit counts what Azure bills: a slow rate never goes past it', async () => {
  const store = createMemoryStore();
  const config = { ...CONFIG, monthly_character_limit: 1000, speaking_rate: 'slow' };
  const { gladys, azure, app } = await makeApp({ store, config });
  for (let i = 0; i < 100; i += 1) await gladys.fake.ttsSynthesize(`Porte ouverte ${i}`, 'fr');
  const billed = azure.calls.reduce((sum, c) => sum + billableChars(c.ssml), 0);
  assert.equal(app.usage.used, billed);
  assert.ok(billed <= 1000, `${billed} billed`);
  assert.ok(azure.calls.length < 25, `${azure.calls.length} requests`);
  const han = await makeApp({ config: { ...CONFIG, monthly_character_limit: 1000 } });
  await han.gladys.fake.ttsSynthesize('客厅灯已打开', 'en');
  assert.equal(han.app.usage.used, 12);
});

test('a rate changed while a request waits in the queue: counted and sent with the new one', async () => {
  const releases = [];
  const azure = fakeSpeech(
    () => new Promise((resolve) => releases.push(() => resolve({ audio: MP3 }))),
  );
  const config = { ...CONFIG, monthly_character_limit: 1000 };
  const { gladys, app } = await makeApp({ azure, config });
  const running = [0, 1].map((i) => gladys.fake.ttsSynthesize(`${i}`.repeat(10), 'en'));
  const waiting = gladys.fake.ttsSynthesize('w'.repeat(10), 'en');
  await settle();
  assert.equal(app.usage.used, 20);
  await gladys.fake.configUpdated({ ...config, speaking_rate: 'x-slow' });
  releases[0]();
  await settle();
  assert.equal(azure.calls.length, 3);
  assert.equal(azure.calls[2].rate, 'x-slow');
  assert.equal(app.usage.used, 20 + billableChars(azure.calls[2].ssml));
  assert.ok(billableChars(azure.calls[2].ssml) > 30);
  releases[1]();
  releases[2]();
  await Promise.all([...running, waiting]);
  // Cached under the rate really used: asked again at x-slow, not sent again.
  await gladys.fake.ttsSynthesize('w'.repeat(10), 'en');
  assert.equal(azure.calls.length, 3);
});

test('the Test button respects the monthly limit: refused, nothing sent', async () => {
  const store = createMemoryStore({ usage: { month: '2026-11', used: 990 } });
  const config = { ...CONFIG, monthly_character_limit: 1000 };
  const { gladys, azure } = await makeApp({ store, config });
  const ack = await gladys.fake.action('test_voice', {});
  assert.equal(ack.success, false);
  assert.match(JSON.stringify(ack), /monthly limit of 1000 characters is reached/);
  assert.equal(azure.calls.length, 0);
});

test('a clock behind at start never overwrites the count of a later month kept in /data', async () => {
  // 2026-11-30 22:00 UTC, /data already in December (the clock was right before).
  const clock = testClock({ start: Date.UTC(2026, 10, 30, 22, 0, 0) });
  const store = createMemoryStore({ usage: { month: '2026-12', used: 480_000 } });
  const { gladys, app } = await makeApp({ store, clock });
  assert.deepEqual(store.data.usage, { month: '2026-12', used: 480_000 });
  await gladys.fake.ttsSynthesize('Hello', 'en');
  assert.deepEqual(app.usage, { month: '2026-12', used: 480_005 });
  // Midnight: December at last, the count goes on.
  await clock.advance(2 * HOUR + SECOND);
  await gladys.fake.ttsSynthesize('Hello again', 'en');
  assert.deepEqual(store.data.usage, { month: '2026-12', used: 480_016 });
  // An older month in /data is still not counted (see the October test).
});

test('cleanText: what XML 1.0 forbids becomes a space, even a surrogate left by the cut', () => {
  assert.equal(cleanText('a￾b￿c\uD800d'), 'a b c d');
  assert.equal(cleanText('ok 😀'), 'ok 😀');
  const cut = cleanText(`${'x'.repeat(1999)}😀`);
  assert.equal(cut.length, 1999); // the half pair at 2,000 becomes a space, then trimmed
  assert.ok(!/[\uD800-\uDFFF]/.test(cut.slice(-1)));
});
