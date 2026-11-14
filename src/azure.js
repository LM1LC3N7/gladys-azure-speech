// -----------------------------------------------------------------------------
// Azure Speech text to speech through its official REST API
// (POST https://<region>.tts.speech.microsoft.com/cognitiveservices/v1, the
// resource key in `Ocp-Apim-Subscription-Key`, SSML in, MP3 out). One request
// per call, never retried (a retried synthesis may be billed twice and the
// answer has to fit the Gladys deadline); redirects never followed (the key
// header would follow them); the clip read no further than 5 MB. Every
// failure becomes a SpeechError whose `kind` drives the app; its message
// never carries the key nor the body of the answer (it may quote the text).
// -----------------------------------------------------------------------------

import { MAX_AUDIO_BYTES, OUTPUT_FORMAT } from './constants.js';

export class SpeechError extends Error {
  /**
   * @param {'refused'|'denied'|'throttled'|'unavailable'|'invalid'|'timeout'|'network'|'bad_answer'|'too_large'} kind
   */
  constructor(kind, { status, code, detail, retryAfterMs, sent = true } = {}) {
    super(`Azure Speech: ${kind}${code ? ` (${code})` : ''}`);
    this.name = 'SpeechError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
    // false only when the request certainly never reached Azure.
    this.sent = sent;
  }
}

// The connection itself failed: nothing left this machine.
const NOT_SENT = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Seconds of a Retry-After header (numbers only), bounded by the caller. */
function retryAfterOf(headers) {
  const raw = headers?.get?.('retry-after');
  if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw.trim())) return undefined;
  return Number(raw.trim()) * 1000;
}

/** The SpeechError of an HTTP status other than 200 (the body is never read). */
export function classifyStatus(status, headers) {
  // 401: the key is wrong, or not a key of this region (Microsoft's words).
  if (status === 401) return new SpeechError('refused', { status, code: `HTTP ${status}` });
  // 403: a valid key that may not do this (quota of the free tier, network
  // rules of the resource): never a refusal of the key.
  if (status === 403) return new SpeechError('denied', { status, code: `HTTP ${status}` });
  if (status === 429) {
    return new SpeechError('throttled', {
      status,
      code: `HTTP ${status}`,
      retryAfterMs: retryAfterOf(headers),
    });
  }
  if (status >= 500) {
    return new SpeechError('unavailable', {
      status,
      code: `HTTP ${status}`,
      retryAfterMs: retryAfterOf(headers),
    });
  }
  if (status >= 300 && status < 400) {
    return new SpeechError('bad_answer', { status, code: `HTTP ${status}` });
  }
  // 400, 415, others: the voice, the region, the SSML.
  return new SpeechError('invalid', { status, code: `HTTP ${status}`, detail: `HTTP ${status}` });
}

/** The SpeechError of a failed fetch (no HTTP answer). */
export function classifyNetwork(err, signal) {
  if (err instanceof SpeechError) return err;
  if (signal?.aborted || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return new SpeechError('timeout', { code: 'timeout' });
  }
  const code = err?.cause?.code ?? err?.code;
  const known = typeof code === 'string' && /^[A-Z_]{2,40}$/.test(code) ? code : 'network';
  return new SpeechError('network', { code: known, sent: !NOT_SENT.has(code) });
}

/** Reads a fetch body to a Buffer, never past `max` bytes; `signal` aborts it. */
export async function readBounded(body, max, signal) {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        reader.cancel().catch(() => {});
        throw new SpeechError('too_large', { code: 'too_large' });
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof SpeechError) throw err;
    reader.cancel().catch(() => {});
    throw classifyNetwork(err, signal);
  }
  return Buffer.concat(chunks, size);
}

/** The synthesis endpoint of a region (the region is checked against a list first). */
export const endpointOf = (region) =>
  `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

/**
 * One client per (region, key): `synthesize` resolves `{ audio, characters }`
 * (`characters` is null: Azure does not say how many it billed).
 * @param {{ region: string, key: string, endpoint?: string, userAgent: string, fetch?: typeof fetch }} options
 */
export function createSpeech({ region, key, endpoint, userAgent, fetch: fetchImpl = fetch }) {
  const url = endpoint ?? endpointOf(region);
  return {
    /** @param {{ ssml: string, signal: AbortSignal }} request */
    async synthesize({ ssml, signal }) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': key,
            'Content-Type': 'application/ssml+xml; charset=utf-8',
            'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
            'User-Agent': userAgent,
            Accept: 'audio/mpeg',
          },
          body: ssml,
          redirect: 'manual',
          signal,
        });
      } catch (err) {
        throw classifyNetwork(err, signal);
      }
      if (res.status !== 200) {
        res.body?.cancel().catch(() => {});
        throw classifyStatus(res.status, res.headers);
      }
      const type = String(res.headers.get('content-type') ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (type !== 'audio/mpeg') {
        res.body?.cancel().catch(() => {});
        throw new SpeechError('bad_answer', { code: 'content_type' });
      }
      const length = Number(res.headers.get('content-length'));
      if (Number.isFinite(length) && length > MAX_AUDIO_BYTES) {
        res.body?.cancel().catch(() => {});
        throw new SpeechError('too_large', { code: 'too_large' });
      }
      const audio = await readBounded(res.body, MAX_AUDIO_BYTES, signal);
      if (audio.length === 0) throw new SpeechError('bad_answer', { code: 'empty' });
      return { audio, characters: null };
    },
    destroy() {},
  };
}
