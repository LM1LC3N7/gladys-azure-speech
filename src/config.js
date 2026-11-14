// -----------------------------------------------------------------------------
// Configuration: the values of the `config_schema`, checked. `readConfig`
// never throws: it returns `{ ok: true, ... }` or `{ ok: false, reason }`, the
// reason being an i18n key (an invalid value is never shown back).
// -----------------------------------------------------------------------------

import {
  DEFAULT_MONTHLY_LIMIT,
  DEFAULT_VOICES,
  LANGUAGES,
  MAX_MONTHLY_LIMIT,
  MIN_MONTHLY_LIMIT,
  RATES,
  REGIONS,
  VOICES,
} from './constants.js';

export const DEFAULTS = {
  region: 'westeurope',
  voice_fr: DEFAULT_VOICES.fr,
  voice_en: DEFAULT_VOICES.en,
  voice_de: DEFAULT_VOICES.de,
  default_language: 'en',
  speaking_rate: 'medium',
  monthly_character_limit: DEFAULT_MONTHLY_LIMIT,
};

// An Azure Speech resource key: 32 hexadecimal characters (older resources)
// or 84 letters and digits (newer ones); no space, no control character.
const KEY = /^[A-Za-z0-9]{32,128}$/;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const pick = (value, allowed, fallback) => {
  // A choice that is not a string (a number, an array) is not a choice: refused.
  if (value !== undefined && value !== null && typeof value !== 'string') return { bad: true };
  const v = text(value);
  if (v === '') return { value: fallback };
  return allowed.includes(v) ? { value: v } : { bad: true };
};

/**
 * @param {Record<string, unknown>} raw the values from Gladys
 */
export function readConfig(raw = {}) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const key = text(config.speech_key);
  if (!key) return { ok: false, reason: 'not_configured' };
  if (!KEY.test(key)) return { ok: false, reason: 'key_invalid' };

  const region = pick(config.region, REGIONS, DEFAULTS.region);
  if (region.bad) return { ok: false, reason: 'region_invalid' };
  const voices = {};
  for (const lang of LANGUAGES) {
    const voice = pick(config[`voice_${lang}`], VOICES[lang], DEFAULT_VOICES[lang]);
    if (voice.bad) return { ok: false, reason: 'voice_invalid' };
    voices[lang] = voice.value;
  }
  const language = pick(config.default_language, LANGUAGES, DEFAULTS.default_language);
  if (language.bad) return { ok: false, reason: 'language_invalid' };
  const rate = pick(config.speaking_rate, RATES, DEFAULTS.speaking_rate);
  if (rate.bad) return { ok: false, reason: 'rate_invalid' };

  let limit = DEFAULTS.monthly_character_limit;
  const rawLimit = config.monthly_character_limit;
  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== '') {
    // Strict: '' or a decimal is not a number of characters.
    const n = typeof rawLimit === 'number' ? rawLimit : Number(text(rawLimit));
    if (
      !Number.isInteger(n) ||
      (typeof rawLimit === 'string' && !/^\d+$/.test(text(rawLimit))) ||
      n < MIN_MONTHLY_LIMIT ||
      n > MAX_MONTHLY_LIMIT
    ) {
      return { ok: false, reason: 'limit_invalid' };
    }
    limit = n;
  }

  return {
    ok: true,
    key,
    region: region.value,
    voices,
    defaultLanguage: language.value,
    rate: rate.value,
    monthlyLimit: limit,
  };
}

/** The Gladys language of a request ('fr', 'fr-FR', 'FR' -> 'fr'); the default otherwise. */
export function languageOf(config, language) {
  const lang = typeof language === 'string' ? language.slice(0, 2).toLowerCase() : '';
  return LANGUAGES.includes(lang) ? lang : config.defaultLanguage;
}
