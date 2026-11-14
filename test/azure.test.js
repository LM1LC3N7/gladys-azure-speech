// -----------------------------------------------------------------------------
// src/azure.js with Node's real fetch against a local HTTP server playing the
// Azure Speech REST API: the request sent, the error classes, the bounds on
// the answer, no redirect followed, no retry.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  SpeechError,
  classifyNetwork,
  classifyStatus,
  createSpeech,
  endpointOf,
} from '../src/azure.js';
import { KEY } from './helpers/app.js';

const SSML =
  '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="fr-FR">' +
  '<voice name="fr-FR-DeniseNeural">Bonjour</voice></speak>';

/** An Azure on 127.0.0.1: `handler(req, body, res)`; `requests` records each one. */
async function fakeAzureServer(handler) {
  const srv = { requests: [], sockets: new Set() };
  srv.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      srv.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, body, res);
    });
  });
  srv.server.on('connection', (s) => {
    srv.sockets.add(s);
    s.on('close', () => srv.sockets.delete(s));
  });
  await new Promise((resolve) => srv.server.listen(0, '127.0.0.1', resolve));
  srv.url = `http://127.0.0.1:${srv.server.address().port}/cognitiveservices/v1`;
  srv.close = () => {
    for (const s of srv.sockets) s.destroy();
    return new Promise((resolve) => srv.server.close(resolve));
  };
  return srv;
}

const clientFor = (srv) =>
  createSpeech({
    region: 'westeurope',
    key: KEY,
    endpoint: srv.url,
    userAgent: 'gladys-azure-speech/0.1.0',
  });

const request = (signal = AbortSignal.timeout(10_000)) => ({ ssml: SSML, signal });

test('the endpoint of a region is the official one', () => {
  assert.equal(
    endpointOf('westeurope'),
    'https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1',
  );
});

test('one POST with the key, SSML, the MP3 format and the user agent; the MP3 back', async (t) => {
  const srv = await fakeAzureServer((req, body, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end(Buffer.from('ID3-audio'));
  });
  t.after(() => srv.close());
  const out = await clientFor(srv).synthesize(request());
  assert.equal(out.audio.toString(), 'ID3-audio');
  assert.deepEqual(Object.keys(out), ['audio']);
  const [req] = srv.requests;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/cognitiveservices/v1');
  assert.equal(req.body, SSML);
  assert.equal(req.headers['ocp-apim-subscription-key'], KEY);
  assert.equal(req.headers['content-type'], 'application/ssml+xml');
  assert.equal(req.headers['x-microsoft-outputformat'], 'audio-24khz-48kbitrate-mono-mp3');
  assert.equal(req.headers['user-agent'], 'gladys-azure-speech/0.1.0');
  assert.equal(req.headers.authorization, undefined);
});

test('the HTTP statuses, classified; only a 401 is a refusal; the body never read', async (t) => {
  const answers = [
    [401, 'refused'],
    [403, 'denied'],
    [429, 'throttled'],
    [500, 'unavailable'],
    [502, 'unavailable'],
    [503, 'unavailable'],
    [400, 'invalid'],
    [415, 'invalid'],
    [404, 'invalid'],
  ];
  let i = 0;
  const srv = await fakeAzureServer((req, body, res) => {
    const [status] = answers[i];
    res.writeHead(status, {
      'content-type': 'text/plain',
      ...(status === 429 ? { 'retry-after': '120' } : {}),
      ...(status === 503 ? { 'retry-after': 'soon' } : {}),
    });
    // Azure may quote the request: never shown.
    res.end(`Bad: Bonjour ${KEY}\r\nX: y`);
  });
  t.after(() => srv.close());
  const speech = clientFor(srv);
  for (; i < answers.length; i += 1) {
    const [status, kind] = answers[i];
    const err = await speech.synthesize(request()).then(
      () => assert.fail('resolved'),
      (e) => e,
    );
    assert.ok(err instanceof SpeechError, String(status));
    assert.equal(err.kind, kind, String(status));
    assert.equal(err.status, status);
    if (status === 429) assert.equal(err.retryAfterMs, 120_000);
    if (status === 503) assert.equal(err.retryAfterMs, undefined);
    const shown = `${err.message} ${err.detail ?? ''} ${err.code ?? ''}`;
    assert.ok(!shown.includes('Bonjour') && !shown.includes(KEY), shown);
  }
  // No retry: one request per call (a retry may be billed twice).
  assert.equal(srv.requests.length, answers.length);
});

test('a redirect is never followed (the key header would go with it)', async (t) => {
  const other = await fakeAzureServer((req, body, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end('ID3');
  });
  t.after(() => other.close());
  const srv = await fakeAzureServer((req, body, res) => {
    res.writeHead(307, { location: other.url.replace('127.0.0.1', 'localhost') });
    res.end();
  });
  t.after(() => srv.close());
  const err = await clientFor(srv)
    .synthesize(request())
    .catch((e) => e);
  assert.equal(err.kind, 'bad_answer');
  assert.equal(other.requests.length, 0);
});

test('an answer too large is cut at 5 MB; not MP3 or empty is refused, and counted as sent', async (t) => {
  let mode = 'huge';
  const srv = await fakeAzureServer((req, body, res) => {
    if (mode === 'declared') {
      // 64 MB announced, a few bytes sent, then silence: refused on the header,
      // without waiting for a body that never comes.
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': String(64 * 1024 * 1024),
      });
      res.write(Buffer.from('ID3'));
    } else if (mode === 'huge') {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      const chunk = Buffer.alloc(256 * 1024, 1);
      let sent = 0;
      const pump = () => {
        while (sent < 64 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return res.once('drain', pump);
        }
        res.end();
      };
      res.on('close', () => (srv.sentBeforeClose = sent));
      pump();
    } else if (mode === 'json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"not":"audio"}');
    } else {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end();
    }
  });
  t.after(() => srv.close());
  const speech = clientFor(srv);
  let err = await speech.synthesize(request()).catch((e) => e);
  assert.equal(err.kind, 'too_large');
  // Billed by Azure: no status, so the app keeps it counted.
  assert.equal(err.status, undefined);
  // The read stopped: the server never wrote the 64 MB.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok((srv.sentBeforeClose ?? 0) < 32 * 1024 * 1024, `${srv.sentBeforeClose}`);
  mode = 'declared';
  err = await speech.synthesize(request(AbortSignal.timeout(2000))).catch((e) => e);
  assert.equal(err.kind, 'too_large');
  mode = 'json';
  err = await speech.synthesize(request()).catch((e) => e);
  assert.equal(err.kind, 'bad_answer');
  assert.equal(err.status, undefined);
  mode = 'empty';
  err = await speech.synthesize(request()).catch((e) => e);
  assert.equal(err.kind, 'bad_answer');
});

test('a silent Azure is aborted by the signal; a refused connection was never sent', async (t) => {
  const srv = await fakeAzureServer(() => {}); // never answers
  t.after(() => srv.close());
  const started = performance.now();
  const err = await clientFor(srv)
    .synthesize(request(AbortSignal.timeout(300)))
    .catch((e) => e);
  assert.equal(err.kind, 'timeout');
  assert.ok(performance.now() - started < 5000);

  // A body that stalls after the headers is cut too.
  const stall = await fakeAzureServer((req, body, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.write(Buffer.from('ID3'));
  });
  t.after(() => stall.close());
  const cut = await clientFor(stall)
    .synthesize(request(AbortSignal.timeout(300)))
    .catch((e) => e);
  assert.equal(cut.kind, 'timeout');

  const closed = await fakeAzureServer(() => {});
  await closed.close();
  const net = await clientFor(closed)
    .synthesize(request())
    .catch((e) => e);
  assert.equal(net.kind, 'network');
  assert.equal(net.code, 'ECONNREFUSED');
  assert.equal(net.sent, false);
});

test('a connection cut after the request is sent: one request, network, sent', async (t) => {
  const srv = await fakeAzureServer((req) => req.socket.destroy());
  t.after(() => srv.close());
  const err = await clientFor(srv)
    .synthesize(request())
    .catch((e) => e);
  assert.equal(err.kind, 'network');
  assert.equal(err.sent, true);
  assert.equal(srv.requests.length, 1);
});

test('classify: unknown codes kept out, not-sent codes recognised', () => {
  const odd = classifyNetwork(
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'x\r\ny' } }),
  );
  assert.equal(odd.code, 'network');
  assert.equal(odd.sent, true);
  const dns = classifyNetwork(
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
  );
  assert.equal(dns.sent, false);
  const aborted = classifyNetwork(new Error('x'), AbortSignal.abort());
  assert.equal(aborted.kind, 'timeout');
  assert.equal(classifyStatus(302).kind, 'bad_answer');
  assert.equal(classifyStatus(401).detail, undefined);
});

test('the body of an error answer is never read: an endless 400 is dropped at once', async (t) => {
  let closed = false;
  const srv = await fakeAzureServer((req, body, res) => {
    res.writeHead(400, { 'content-type': 'text/plain' });
    const chunk = Buffer.alloc(64 * 1024, 65);
    const timer = setInterval(() => res.write(chunk), 5);
    res.on('close', () => {
      closed = true;
      clearInterval(timer);
    });
  });
  t.after(() => srv.close());
  const started = performance.now();
  const err = await clientFor(srv)
    .synthesize(request(AbortSignal.timeout(3000)))
    .catch((e) => e);
  assert.equal(err.kind, 'invalid');
  assert.ok(performance.now() - started < 1500);
  const until = performance.now() + 2000;
  while (!closed && performance.now() < until) await new Promise((r) => setTimeout(r, 20));
  assert.ok(closed, 'the server saw the answer dropped');
});

test('an MP3 under another usual name or with parameters is accepted; HTML is not', async (t) => {
  let type = 'audio/mp3';
  const srv = await fakeAzureServer((req, body, res) => {
    res.writeHead(200, { 'content-type': type });
    res.end('ID3');
  });
  t.after(() => srv.close());
  const speech = clientFor(srv);
  for (type of ['audio/mp3', 'Audio/MPEG; codec=mp3', 'audio/mpeg3']) {
    assert.equal((await speech.synthesize(request())).audio.toString(), 'ID3', type);
  }
  type = 'text/html';
  assert.equal((await speech.synthesize(request()).catch((e) => e)).kind, 'bad_answer');
});
