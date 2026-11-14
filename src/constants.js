// -----------------------------------------------------------------------------
// Fixed values: the Azure voices offered per Gladys language, the regions,
// and the limits the integration holds itself to.
//
// The voice lists come from the Azure Speech documentation ("Language and
// voice support", November 2026). A voice a region does not offer is refused
// by Azure (HTTP 400), not billed.
// -----------------------------------------------------------------------------

/**
 * The Gladys languages and the Azure neural voices offered for each (short
 * names). Standard neural voices only: the HD and Dragon voices cost more.
 */
export const VOICES = {
  fr: [
    'fr-FR-DeniseNeural',
    'fr-FR-HenriNeural',
    'fr-FR-EloiseNeural',
    'fr-FR-VivienneMultilingualNeural',
    'fr-FR-RemyMultilingualNeural',
    'fr-FR-AlainNeural',
    'fr-FR-BrigitteNeural',
    'fr-FR-CelesteNeural',
    'fr-FR-ClaudeNeural',
    'fr-FR-CoralieNeural',
    'fr-FR-JacquelineNeural',
    'fr-FR-JeromeNeural',
    'fr-FR-JosephineNeural',
    'fr-FR-MauriceNeural',
    'fr-FR-YvesNeural',
    'fr-FR-YvetteNeural',
    'fr-BE-CharlineNeural',
    'fr-BE-GerardNeural',
    'fr-CA-SylvieNeural',
    'fr-CA-JeanNeural',
    'fr-CA-AntoineNeural',
    'fr-CA-ThierryNeural',
    'fr-CH-ArianeNeural',
    'fr-CH-FabriceNeural',
  ],
  en: [
    'en-US-JennyNeural',
    'en-US-GuyNeural',
    'en-US-AriaNeural',
    'en-US-AvaNeural',
    'en-US-AndrewNeural',
    'en-US-EmmaNeural',
    'en-US-BrianNeural',
    'en-US-AvaMultilingualNeural',
    'en-US-AndrewMultilingualNeural',
    'en-US-DavisNeural',
    'en-US-JaneNeural',
    'en-US-JasonNeural',
    'en-US-SaraNeural',
    'en-US-TonyNeural',
    'en-US-NancyNeural',
    'en-GB-SoniaNeural',
    'en-GB-RyanNeural',
    'en-GB-LibbyNeural',
    'en-AU-NatashaNeural',
    'en-AU-WilliamNeural',
    'en-CA-ClaraNeural',
    'en-CA-LiamNeural',
    'en-IE-EmilyNeural',
    'en-IE-ConnorNeural',
    'en-IN-NeerjaNeural',
    'en-IN-PrabhatNeural',
  ],
  de: [
    'de-DE-KatjaNeural',
    'de-DE-ConradNeural',
    'de-DE-AmalaNeural',
    'de-DE-KillianNeural',
    'de-DE-LouisaNeural',
    'de-DE-SeraphinaMultilingualNeural',
    'de-DE-FlorianMultilingualNeural',
    'de-AT-IngridNeural',
    'de-AT-JonasNeural',
    'de-CH-LeniNeural',
    'de-CH-JanNeural',
  ],
};

export const DEFAULT_VOICES = {
  fr: 'fr-FR-DeniseNeural',
  en: 'en-US-JennyNeural',
  de: 'de-DE-KatjaNeural',
};

export const LANGUAGES = Object.keys(VOICES);

export const RATES = ['x-slow', 'slow', 'medium', 'fast', 'x-fast'];

/** The Azure regions with neural text to speech (Microsoft Learn, "Speech service regions", 2026-11-10). */
export const REGIONS = [
  'australiaeast',
  'brazilsouth',
  'canadacentral',
  'canadaeast',
  'centralindia',
  'centralus',
  'eastasia',
  'eastus',
  'eastus2',
  'francecentral',
  'germanywestcentral',
  'italynorth',
  'japaneast',
  'japanwest',
  'koreacentral',
  'northcentralus',
  'northeurope',
  'norwayeast',
  'qatarcentral',
  'southafricanorth',
  'southcentralus',
  'southeastasia',
  'swedencentral',
  'switzerlandnorth',
  'switzerlandwest',
  'uaenorth',
  'uksouth',
  'ukwest',
  'westcentralus',
  'westeurope',
  'westus',
  'westus2',
  'westus3',
];

/** MP3, 24 kHz mono, 48 kbit/s: small clips every speaker plays. */
export const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

export const ACTIONS = { TEST: 'test_voice' };

/** The SDK caps the text at 2,000 characters; the core truncates before the relay. */
export const MAX_TEXT = 2000;
/** The clip the SDK accepts (decoded), read no further. */
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
/** Gladys waits 30 s for the ack: the whole answer fits in 25 s, queue included. */
export const DEADLINE_MS = 25_000;
export const CONNECT_TIMEOUT_MS = 5_000;
/** Requests in flight at once; the others wait in a bounded queue. */
export const MAX_IN_FLIGHT = 2;
export const MAX_WAITING = 8;

/** Pause after a throttling or a server error: 60 s, doubled up to 1 h; a Retry-After up to 6 h. */
export const PAUSE_MIN_MS = 60_000;
export const PAUSE_MAX_MS = 3_600_000;
export const RETRY_AFTER_MAX_MS = 6 * 3_600_000;

/** Clips kept in memory (same text, same voice: not billed twice). */
export const CACHE_MAX_ENTRIES = 20;
export const CACHE_MAX_CHARS = 20 * 1024 * 1024;
export const CACHE_TTL_MS = 24 * 3_600_000;

/** /data read again on this timer while it cannot be read; the first read waits this long. */
export const STORE_RETRY_MS = 10_000;
export const STORE_LOAD_BUDGET_MS = 2_000;
/** The count is written to /data before a request leaves, waited for this long at most. */
export const SAVE_BUDGET_MS = 1_000;
/** getConfig() retried without end: 5 s, doubled up to 60 s. */
export const CONFIG_RETRY_MIN_MS = 5_000;
export const CONFIG_RETRY_MAX_MS = 60_000;
/** A synthesis arriving before the configuration was read waits for it this long at most. */
export const CONFIG_WAIT_MS = 3_000;

/** The free tier (F0) gives 500,000 characters of neural voices a month. */
export const DEFAULT_MONTHLY_LIMIT = 500_000;
export const MIN_MONTHLY_LIMIT = 1_000;
export const MAX_MONTHLY_LIMIT = 100_000_000;
