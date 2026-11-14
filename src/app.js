// -----------------------------------------------------------------------------
// The text-to-speech provider: Gladys sends a text and a language
// (onTtsSynthesize), the app picks the voice, asks Azure Speech for an MP3 and
// answers `audio/mpeg;base64,...` within 25 s (Gladys waits 30 s).
//
// What protects the Azure bill and the resource:
//   - the monthly character limit (500,000 by default: the free tier),
//     counted before a request leaves and kept in /data (a request that may
//     have been billed stays counted);
//   - the same text in the same voice served from memory (24 h, 20 clips),
//     and asked several times at once, one request shared by all;
//   - at most 2 requests in flight, 8 waiting, the others refused;
//   - after a throttling (429) or a server error: a pause (60 s doubled up to
//     1 h, a Retry-After up to 6 h), kept in /data, on every path, Test included;
//   - a key refused by Azure (401) in a region: nothing more sent with it there
//     (8 bits of a salted hash in /data) until it changes or the Test button succeeds.
// Time: every pause on the monotonic clock; the wall clock only for /data
// (pause end across a restart) and the calendar month of the limit (UTC).
// -----------------------------------------------------------------------------

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { languageOf, readConfig } from './config.js';
import {
  ACTIONS,
  CACHE_MAX_CHARS,
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  CONFIG_RETRY_MAX_MS,
  CONFIG_RETRY_MIN_MS,
  CONFIG_WAIT_MS,
  DEADLINE_MS,
  LANGUAGES,
  MAX_IN_FLIGHT,
  MAX_TEXT,
  MAX_WAITING,
  PAUSE_MAX_MS,
  PAUSE_MIN_MS,
  RETRY_AFTER_MAX_MS,
  SAVE_BUDGET_MS,
  STORE_LOAD_BUDGET_MS,
  STORE_RETRY_MS,
} from './constants.js';
import { both, t } from './i18n.js';
import { SpeechError } from './azure.js';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const credsOf = (cfg) => cfg.key;
// A refusal is tied to the key AND the region (a key of a resource in another
// region is refused with 401; back to the right region, it is tried again).
const refusalOf = (cfg) => `${credsOf(cfg)}\n${cfg.region}`;
const monthOf = (wall) => new Date(wall).toISOString().slice(0, 7);
export const fp8 = (salt, cfg) => createHmac('sha256', salt).update(refusalOf(cfg)).digest()[0];
const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

/** Bounded wait: resolves `fallback` after `ms` if `promise` is slower. */
function within(promise, ms, timers, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = timers.setTimeout(() => resolve(fallback), Math.max(0, ms));
    }),
  ]).finally(() => timers.clearTimeout(timer));
}

// Only what XML requires in element content: Azure bills every character of
// the markup, an `&apos;` would cost 6 instead of 1.
const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The SSML Azure needs: the voice, its locale, the rate when it is not the default. */
export function buildSsml(text, voice, rate) {
  const locale = voice.slice(0, 5);
  const said =
    rate === 'medium' ? escapeXml(text) : `<prosody rate="${rate}">${escapeXml(text)}</prosody>`;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${voice}">${said}</voice></speak>`;
}

/**
 * The characters Azure bills for a request ("Billable characters", Microsoft
 * Learn): every code point of the SSML body except the `<speak>` and `<voice>`
 * tags, markup and entities included, a Han character counted twice.
 */
export function billableChars(ssml) {
  const inner = ssml.replace(/<\/?(?:speak|voice)\b[^>]*>/g, '');
  let n = 0;
  for (const ch of inner) n += /\p{Script=Han}/u.test(ch) ? 2 : 1;
  return n;
}

/**
 * The text cleaned: control characters and what XML 1.0 forbids (U+FFFE,
 * U+FFFF, a lone surrogate, also one left by the cut) become spaces, at most
 * 2,000 characters.
 */
export function cleanText(text) {
  return (
    String(text ?? '')
      // eslint-disable-next-line no-control-regex -- control characters are what it removes
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .slice(0, MAX_TEXT)
      .replace(/[\uFFFE\uFFFF]|[\uD800-\uDFFF]/gu, ' ')
      .trim()
  );
}

const cacheKey = (voice, rate, text) => sha256(JSON.stringify([voice, rate, text]));

export class AzureSpeechApp {
  constructor({
    gladys,
    store,
    createSpeech,
    logger = console,
    now = () => performance.now(),
    wallNow = () => Date.now(),
    timers = { setTimeout, clearTimeout },
    userAgent = 'gladys-azure-speech',
  }) {
    Object.assign(this, { gladys, store, createSpeech, logger, now, wallNow, timers, userAgent });
    this.stopped = false;
    // Configuration.
    this.config = null; // readConfig() result once read
    this.configRead = false;
    this.configLoop = null;
    this.configTimer = null;
    this.configWaiters = [];
    // /data.
    this.storeReady = false;
    this.loading = null;
    this.storeTimer = null;
    this.firstLoad = null;
    this.usage = { month: monthOf(wallNow()), used: 0 };
    this.pauseUntil = 0; // monotonic
    this.pauseStep = 0;
    this.refused = null; // { salt, fp } (persisted)
    this.refusedFull = null; // sha256 of the refused key, this process only
    this.succeeded = null; // the key of the last success, to drop a stale refusal
    // Requests.
    this.client = null;
    this.clientKey = null;
    this.inFlight = 0;
    this.waiting = [];
    this.controllers = new Set();
    this.cache = new Map();
    this.shared = new Map(); // cache key -> the promise of the request in flight
    this.cacheChars = 0;
    // Status.
    this.outcome = 'ready';
    this.outcomeVars = {};
    this.lastStatus = null;
    this.persisted = undefined; // last write to /data: true, false, or none yet
  }

  /** Handlers first, then /data, then the connection. */
  async start() {
    const { gladys } = this;
    gladys.onTtsSynthesize((text, language) => this.synthesize(text, language));
    gladys.onConfigUpdated(async (raw) => this.applyConfig(raw));
    gladys.onAction(ACTIONS.TEST, async (fields) => this.test(fields));
    gladys.on('connected', () => this.onConnected());
    this.firstLoad = this.loadStore();
    await gladys.connect();
  }

  async stop() {
    this.stopped = true;
    for (const timer of [this.configTimer, this.storeTimer]) this.timers.clearTimeout(timer);
    for (const w of this.waiting.splice(0)) {
      this.timers.clearTimeout(w.timer);
      w.reject(new Error(t('stopped')));
    }
    for (const c of this.controllers) c.abort();
    for (const w of this.configWaiters.splice(0)) w();
    this.client?.destroy();
    this.client = null;
    await this.store.flush?.();
  }

  // --- Configuration -----------------------------------------------------------

  /** Every (re)connection: the configuration read again, the status published again. */
  onConnected() {
    this.lastStatus = null;
    this.refreshConfig(CONFIG_RETRY_MIN_MS);
    this.publishStatus();
  }

  /** getConfig() until it answers, 5 s doubled up to 60 s between tries, without end. */
  refreshConfig(delay) {
    if (this.configLoop || this.stopped) return;
    this.timers.clearTimeout(this.configTimer);
    this.configTimer = null;
    this.configLoop = (async () => {
      try {
        const raw = await this.gladys.getConfig();
        if (this.stopped) return;
        this.applyConfig(raw);
      } catch (err) {
        if (this.stopped) return;
        this.logger.warn(`getConfig failed (${err?.name ?? 'error'}); retry in ${delay / 1000} s`);
        this.publishStatus();
        this.configTimer = this.timers.setTimeout(() => {
          this.configTimer = null;
          this.refreshConfig(Math.min(delay * 2, CONFIG_RETRY_MAX_MS));
        }, delay);
      } finally {
        this.configLoop = null;
      }
    })();
  }

  applyConfig(raw) {
    const cfg = readConfig(raw);
    const before = this.config;
    if (
      before?.ok &&
      (!cfg.ok || credsOf(before) !== credsOf(cfg) || before.region !== cfg.region)
    ) {
      this.client?.destroy();
      this.client = null;
      this.clientKey = null;
    }
    const sameKeys = before?.ok && cfg.ok && credsOf(before) === credsOf(cfg);
    this.config = cfg;
    this.configRead = true;
    // Key or region changed: the last outcome no longer says anything. The
    // same key saved again keeps it (no false reason, no temporary refusal).
    if (!sameKeys || before.region !== cfg.region) {
      this.outcome = 'ready';
      this.outcomeVars = {};
    }
    for (const w of this.configWaiters.splice(0)) w();
    this.publishStatus();
  }

  /** Waits (bounded) for the configuration and the first read of /data. */
  async ready() {
    const waits = [];
    if (!this.configRead) {
      if (!this.configLoop && !this.configTimer) this.refreshConfig(CONFIG_RETRY_MIN_MS);
      waits.push(
        within(
          new Promise((resolve) => this.configWaiters.push(resolve)),
          CONFIG_WAIT_MS,
          this.timers,
        ),
      );
    }
    if (!this.storeReady && this.firstLoad) {
      waits.push(within(this.firstLoad, STORE_LOAD_BUDGET_MS, this.timers));
    }
    await Promise.all(waits);
    if (this.stopped) throw new Error(t('stopped'));
  }

  // --- /data ------------------------------------------------------------------------

  /** One read at a time; an unreadable /data is read again every 10 s, never overwritten. */
  loadStore() {
    if (this.loading || this.storeReady || this.stopped) return this.loading;
    this.loading = (async () => {
      try {
        const data = await this.store.load();
        if (this.stopped) return;
        this.merge(data);
      } catch (err) {
        if (this.stopped) return;
        this.logger.warn(`/data unreadable (${err?.message ?? 'error'}); read again in 10 s`);
        this.storeTimer = this.timers.setTimeout(() => {
          this.storeTimer = null;
          this.loadStore();
        }, STORE_RETRY_MS);
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** What /data says, merged with what happened since the start (never lost). */
  merge(data) {
    const now = this.now();
    const wall = this.wallNow();
    const usage = data?.usage;
    if (
      usage &&
      typeof usage.month === 'string' &&
      /^\d{4}-(0[1-9]|1[0-2])$/.test(usage.month) &&
      usage.month >= this.usage.month &&
      isInt(usage.used, 0, 1e12)
    ) {
      // A later month than the clock says: the clock is behind (no RTC, a VM
      // restored). That count is kept, never overwritten, and what was sent
      // since the start is added to it.
      this.usage = { month: usage.month, used: this.usage.used + usage.used };
    }
    const pause = data?.pause;
    if (pause && Number.isFinite(pause.until)) {
      const left = pause.until - wall;
      // A date further than the longest pause is invalid (clock jumped, foreign file).
      if (left > 0 && left <= RETRY_AFTER_MAX_MS) {
        this.pauseUntil = Math.max(this.pauseUntil, now + left);
      }
      if (isInt(pause.step, PAUSE_MIN_MS, PAUSE_MAX_MS)) {
        this.pauseStep = Math.max(this.pauseStep, pause.step);
      }
    }
    const refused = data?.refused;
    if (
      !this.refused &&
      refused &&
      typeof refused.salt === 'string' &&
      /^[0-9a-f]{32}$/.test(refused.salt) &&
      isInt(refused.fp, 0, 255)
    ) {
      // A key that succeeded since the start lifts a refusal read late.
      const lifted = this.succeeded && fp8(refused.salt, this.succeeded) === refused.fp;
      if (!lifted) this.refused = { salt: refused.salt, fp: refused.fp };
    }
    this.storeReady = true;
    this.save();
    this.publishStatus();
  }

  snapshot() {
    const left = this.pauseUntil - this.now();
    return {
      usage: { ...this.usage },
      pause:
        left > 0 || this.pauseStep
          ? { until: this.wallNow() + Math.max(0, left), step: this.pauseStep }
          : null,
      refused: this.refused ? { ...this.refused } : null,
    };
  }

  /** Resolves true once written, false when /data is not read or the write failed. */
  save() {
    if (!this.storeReady) return Promise.resolve(false);
    return this.store.save(this.snapshot()).then(
      () => {
        this.setPersisted(true);
        return true;
      },
      (err) => {
        this.logger.warn(`/data not saved (${err?.message ?? 'error'})`);
        this.setPersisted(false);
        return false;
      },
    );
  }

  setPersisted(value) {
    if (this.persisted === value) return;
    this.persisted = value;
    this.publishStatus();
  }

  // --- Guards -------------------------------------------------------------------------

  isRefused(cfg) {
    if (this.refusedFull) return this.refusedFull === sha256(refusalOf(cfg));
    return Boolean(this.refused) && fp8(this.refused.salt, cfg) === this.refused.fp;
  }

  pausedFor() {
    return Math.max(0, this.pauseUntil - this.now());
  }

  /** Only forward: a clock gone back never resets the count of a later month. */
  rollMonth() {
    const month = monthOf(this.wallNow());
    if (month > this.usage.month) this.usage = { month, used: 0 };
  }

  /** Throws the reason nothing can be sent now (the order is the status order). */
  gate(cfg, chars, lang, { allowRefused = false } = {}) {
    if (!allowRefused && this.isRefused(cfg)) throw new Error(t('refused', lang));
    const left = this.pausedFor();
    if (left > 0) throw new Error(t('paused', lang, { time: this.pauseEnd(left) }));
    this.rollMonth();
    if (this.usage.used + chars > cfg.monthlyLimit) {
      throw new Error(t('limit_reached', lang, { limit: cfg.monthlyLimit, used: this.usage.used }));
    }
  }

  pauseEnd(left) {
    return new Date(this.wallNow() + left).toISOString().slice(11, 16);
  }

  // --- Queue ----------------------------------------------------------------------------

  acquire(deadline, lang) {
    if (this.inFlight < MAX_IN_FLIGHT) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    if (this.waiting.length >= MAX_WAITING) return Promise.reject(new Error(t('busy', lang)));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timer = this.timers.setTimeout(
        () => {
          this.waiting = this.waiting.filter((w) => w !== waiter);
          reject(new Error(t('timeout', lang)));
        },
        Math.max(0, deadline - this.now()),
      );
      this.waiting.push(waiter);
    });
  }

  release() {
    const next = this.waiting.shift();
    if (next) {
      this.timers.clearTimeout(next.timer);
      next.resolve(); // the slot passes on
    } else {
      this.inFlight -= 1;
    }
  }

  // --- Cache --------------------------------------------------------------------------

  cacheGet(key) {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > CACHE_TTL_MS) {
      this.cache.delete(key);
      this.cacheChars -= hit.audio.length;
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, hit); // most recent last
    return hit.audio;
  }

  cachePut(key, audio) {
    if (audio.length > CACHE_MAX_CHARS) return;
    const old = this.cache.get(key);
    if (old) {
      this.cache.delete(key);
      this.cacheChars -= old.audio.length;
    }
    this.cache.set(key, { audio, at: this.now() });
    this.cacheChars += audio.length;
    for (const [k, v] of this.cache) {
      if (this.cache.size <= CACHE_MAX_ENTRIES && this.cacheChars <= CACHE_MAX_CHARS) break;
      this.cache.delete(k);
      this.cacheChars -= v.audio.length;
    }
  }

  // --- Synthesis ----------------------------------------------------------------------

  /** onTtsSynthesize: the clip, or an error in the language of the request. */
  async synthesize(rawText, language) {
    const deadline = this.now() + DEADLINE_MS;
    const lang = typeof language === 'string' && language.startsWith('fr') ? 'fr' : 'en';
    await this.ready();
    const cfg = this.config;
    if (!cfg) throw new Error(t('config_unread', lang));
    if (!cfg.ok) throw new Error(t(cfg.reason, lang));
    const text = cleanText(rawText);
    if (!text) throw new Error(t('empty_text', lang));
    const pick = (c) => c.voices[languageOf(c, language)];
    const key = cacheKey(pick(cfg), cfg.rate, text);
    const cached = this.cacheGet(key);
    if (cached) return cached;
    // The same text in the same voice already asked (a scene announcing on
    // several speakers at once): one request, its answer or failure shared.
    const inFlight = this.shared.get(key);
    if (inFlight) return inFlight;
    const job = this.run({ text, pick, lang, deadline }).then((done) => {
      // Kept under the voice and rate really used (the settings may have
      // changed while it waited in the queue).
      this.cachePut(cacheKey(done.voice, done.rate, text), done.audio);
      return done.audio;
    });
    this.shared.set(key, job);
    try {
      return await job;
    } finally {
      if (this.shared.get(key) === job) this.shared.delete(key);
    }
  }

  /** The Test button: a short sentence, sent even with a refused key (never during a pause). */
  async test(fields = {}) {
    const deadline = this.now() + DEADLINE_MS;
    await this.ready();
    const cfg = this.config;
    if (!cfg) throw new Error(t('config_unread'));
    if (!cfg.ok) throw new Error(t(cfg.reason));
    const wanted = typeof fields?.language === 'string' ? fields.language : '';
    const language = LANGUAGES.includes(wanted) ? wanted : cfg.defaultLanguage;
    const text =
      language === 'de'
        ? t('test_sentence_de')
        : t('test_sentence', language === 'fr' ? 'fr' : 'en');
    const started = this.now();
    const { bytes, voice } = await this.run({
      text,
      pick: (c) => c.voices[language],
      lang: 'en',
      deadline,
      allowRefused: true,
    });
    return both('test_ok', {
      voice,
      size: Math.max(1, Math.round(bytes / 1024)),
      ms: Math.round(this.now() - started),
    });
  }

  /**
   * Gate, queue, gate again, count, send. `pick(cfg)` gives the voice: the
   * SSML and its billable count are built again from the configuration read
   * after the queue (the rate or the voice may have changed meanwhile).
   */
  async run({ text, pick, lang, deadline, allowRefused = false }) {
    const before = buildSsml(text, pick(this.config), this.config.rate);
    this.gate(this.config, billableChars(before), lang, { allowRefused });
    await this.acquire(deadline, lang);
    try {
      if (this.stopped) throw new Error(t('stopped', lang));
      // Things may have changed while waiting: the configuration, a refusal, a pause.
      const cfg = this.config;
      if (!cfg?.ok) throw new Error(t(cfg?.reason ?? 'config_unread', lang));
      const voice = pick(cfg);
      const ssml = buildSsml(text, voice, cfg.rate);
      const chars = billableChars(ssml);
      this.gate(cfg, chars, lang, { allowRefused });
      const left = deadline - this.now();
      if (left <= 0) throw new Error(t('timeout', lang));
      // Counted in memory before it leaves (the limit always holds while the
      // process runs), and written to /data first, 1 s at most: a slow,
      // read-only or unread /data never blocks an announcement (an alarm
      // matters more than a fraction of a cent). The status then says the
      // count is not saved; a crash at that moment may lose this request.
      this.usage.used += chars;
      const saved = await within(this.save(), SAVE_BUDGET_MS, this.timers, false);
      if (!saved) this.setPersisted(false);
      if (this.stopped) throw new Error(t('stopped', lang));
      const started = this.now();
      let result;
      try {
        result = await this.send(cfg, ssml, left);
      } catch (err) {
        this.failed(err, cfg, chars);
        throw new Error(this.message(err, lang), { cause: err });
      }
      this.succeededWith(cfg);
      const kb = Math.round(result.audio.length / 1024);
      this.logger.info(
        `synthesized ${chars} characters (voice ${voice}, ${kb} KB, ${Math.round(this.now() - started)} ms)`,
      );
      return {
        audio: `audio/mpeg;base64,${result.audio.toString('base64')}`,
        bytes: result.audio.length,
        voice,
        rate: cfg.rate,
      };
    } finally {
      this.release();
    }
  }

  clientFor(cfg) {
    const key = sha256(`${cfg.region}\n${credsOf(cfg)}`);
    if (!this.client || this.clientKey !== key) {
      this.client?.destroy();
      this.client = this.createSpeech({
        region: cfg.region,
        key: cfg.key,
        userAgent: this.userAgent,
      });
      this.clientKey = key;
    }
    return this.client;
  }

  async send(cfg, ssml, left) {
    const controller = new AbortController();
    const timer = this.timers.setTimeout(() => controller.abort(), left);
    this.controllers.add(controller);
    try {
      return await this.clientFor(cfg).synthesize({
        ssml,
        signal: controller.signal,
      });
    } finally {
      this.timers.clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  succeededWith(cfg) {
    this.pauseStep = 0;
    this.pauseUntil = 0;
    this.refused = null;
    this.refusedFull = null;
    this.succeeded = { key: cfg.key, region: cfg.region };
    this.outcome = 'working';
    this.outcomeVars = {};
    this.save();
    this.publishStatus();
  }

  failed(err, cfg, chars) {
    const kind = err instanceof SpeechError ? err.kind : 'network';
    // Answered with an error status (or never sent): not billed. A timeout, a
    // cut connection or a 200 whose clip is unusable may have been billed: it
    // stays counted.
    const answered = err instanceof SpeechError && typeof err.status === 'number';
    const notSent = err instanceof SpeechError && err.sent === false;
    if (answered || notSent) this.usage.used = Math.max(0, this.usage.used - chars);
    if (kind === 'refused') {
      const salt = randomBytes(16).toString('hex');
      this.refused = { salt, fp: fp8(salt, cfg) };
      this.refusedFull = sha256(refusalOf(cfg));
      this.succeeded = null;
    } else if (kind === 'throttled' || kind === 'unavailable') {
      this.pauseStep = this.pauseStep ? Math.min(this.pauseStep * 2, PAUSE_MAX_MS) : PAUSE_MIN_MS;
      const asked = Number.isFinite(err.retryAfterMs)
        ? Math.min(err.retryAfterMs, RETRY_AFTER_MAX_MS)
        : 0;
      this.pauseUntil = this.now() + Math.max(this.pauseStep, asked);
    }
    this.outcome = kind;
    this.outcomeVars = { detail: err?.detail ?? '' };
    this.logger.warn(
      `synthesis failed: ${kind}${err?.code ? ` (${err.code})` : ''}${err?.status ? ` HTTP ${err.status}` : ''}`,
    );
    this.save();
    this.publishStatus();
  }

  message(err, lang) {
    const kind = err instanceof SpeechError ? err.kind : 'network';
    if (kind === 'throttled' || kind === 'unavailable') {
      return t('paused', lang, { time: this.pauseEnd(this.pausedFor()) });
    }
    return t(kind, lang, { detail: err?.detail || err?.code || '' });
  }

  // --- Status -------------------------------------------------------------------------

  status() {
    if (!this.configRead) return { ok: false, key: 'config_unread' };
    const cfg = this.config;
    if (!cfg.ok) return { ok: false, key: cfg.reason };
    if (this.isRefused(cfg)) return { ok: false, key: 'refused' };
    const left = this.pausedFor();
    if (left > 0) return { ok: false, key: 'paused', vars: { time: this.pauseEnd(left) } };
    this.rollMonth();
    if (this.usage.used >= cfg.monthlyLimit) {
      return {
        ok: false,
        key: 'limit_reached',
        vars: { limit: cfg.monthlyLimit, used: this.usage.used },
      };
    }
    // /data not read, read-only or slow: the count is not saved (the limit,
    // the pause and a refusal kept there may also be unknown).
    if (
      (!this.storeReady || this.persisted === false) &&
      (this.outcome === 'working' || this.outcome === 'ready')
    ) {
      return { ok: true, key: 'not_persisted' };
    }
    if (this.outcome === 'working') {
      return {
        ok: true,
        key: 'working',
        vars: { voice: Object.values(cfg.voices).join(', ') },
      };
    }
    if (this.outcome !== 'ready' && this.outcome !== 'refused') {
      return { ok: false, key: this.outcome, vars: this.outcomeVars };
    }
    return { ok: true, key: 'ready' };
  }

  /** One setConnectionStatus per change of state. */
  publishStatus() {
    if (this.stopped) return;
    const { ok, key, vars = {} } = this.status();
    const message = both(key, vars);
    const id = JSON.stringify([ok, message]);
    if (id === this.lastStatus) return;
    this.lastStatus = id;
    Promise.resolve()
      .then(() => this.gladys.setConnectionStatus(ok, message))
      .catch((err) => {
        if (this.lastStatus === id) this.lastStatus = null;
        this.logger.warn(`setConnectionStatus failed (${err?.name ?? 'error'})`);
      });
  }
}
