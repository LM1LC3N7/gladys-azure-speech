// -----------------------------------------------------------------------------
// Every text shown to the user, in English and French. `{name}` placeholders
// are filled by `t`. No text carries a key, a secret or the spoken text.
// -----------------------------------------------------------------------------

export const ALL_TEXTS = {
  // Status (Configuration screen).
  not_configured: {
    en: 'Enter the key of your Azure Speech resource and choose its region.',
    fr: 'Saisissez la clé de votre ressource Azure Speech et choisissez sa région.',
  },
  key_invalid: {
    en: 'The resource key is not valid (32 to 128 letters and digits, no space).',
    fr: 'La clé de la ressource n’est pas valide (32 à 128 lettres et chiffres, sans espace).',
  },
  region_invalid: { en: 'Unknown Azure region.', fr: 'Région Azure inconnue.' },
  voice_invalid: { en: 'Unknown voice.', fr: 'Voix inconnue.' },
  language_invalid: { en: 'Unknown default language.', fr: 'Langue par défaut inconnue.' },
  rate_invalid: { en: 'Unknown speaking rate.', fr: 'Débit de parole inconnu.' },
  limit_invalid: {
    en: 'The monthly limit must be a whole number between 1,000 and 100,000,000 characters.',
    fr: 'La limite mensuelle doit être un nombre entier de 1 000 à 100 000 000 caractères.',
  },
  config_unread: {
    en: 'The configuration could not be read from Gladys yet; trying again.',
    fr: 'La configuration n’a pas encore pu être lue depuis Gladys ; nouvel essai en cours.',
  },
  ready: {
    en: 'Ready. The key is checked by Azure at the first announcement or with the Test button.',
    fr: 'Prêt. La clé est vérifiée par Azure à la première annonce ou avec le bouton Tester.',
  },
  not_persisted: {
    en: 'Ready, but the monthly counter is not saved (/data unread, read-only or slow): the limit is only guaranteed until the next restart.',
    fr: 'Prêt, mais le compteur mensuel n’est pas enregistré (/data non lu, en lecture seule ou lent) : le plafond n’est garanti que jusqu’au prochain redémarrage.',
  },
  working: {
    en: 'Azure Speech answered (voices {voice}).',
    fr: 'Azure Speech a répondu (voix {voice}).',
  },
  refused: {
    en: 'Azure refused this key in this region (HTTP 401: wrong or regenerated key, or a key of a resource in another region). Nothing is sent with it until the key or the region changes, or the Test button succeeds.',
    fr: 'Azure a refusé cette clé dans cette région (HTTP 401 : clé erronée ou régénérée, ou clé d’une ressource d’une autre région). Plus rien n’est envoyé avec elle tant que la clé ou la région ne change pas, ou que le bouton Tester ne réussit pas.',
  },
  denied: {
    en: 'Azure denied the synthesis (HTTP 403): the quota of the free tier may be used up, or the network rules of the resource block this address. The key itself is not taken as refused.',
    fr: 'Azure a refusé la synthèse (HTTP 403) : le quota du palier gratuit est peut-être épuisé, ou les règles réseau de la ressource bloquent cette adresse. La clé elle-même n’est pas tenue pour refusée.',
  },
  paused: {
    en: 'Azure Speech asked to slow down or failed: no request before {time} (UTC).',
    fr: 'Azure Speech a demandé de ralentir ou a échoué : aucune requête avant {time} (UTC).',
  },
  invalid: {
    en: 'Azure Speech refused the request ({detail}): check the voice is offered in this region.',
    fr: 'Azure Speech a refusé la requête ({detail}) : vérifiez que la voix est proposée dans cette région.',
  },
  timeout: {
    en: 'Azure Speech did not answer in time.',
    fr: 'Azure Speech n’a pas répondu à temps.',
  },
  network: {
    en: 'Azure Speech could not be reached, or the connection was cut (network).',
    fr: 'Azure Speech est injoignable, ou la connexion a été coupée (réseau).',
  },
  bad_answer: {
    en: 'Azure Speech sent an answer that is not an MP3 clip.',
    fr: 'Azure Speech a envoyé une réponse qui n’est pas un clip MP3.',
  },
  too_large: {
    en: 'The clip is larger than the 5 MB Gladys accepts.',
    fr: 'Le clip dépasse les 5 Mo acceptés par Gladys.',
  },
  limit_reached: {
    en: 'The monthly limit of {limit} characters is reached ({used} sent this month, UTC): nothing more is sent before next month or a higher limit.',
    fr: 'La limite mensuelle de {limit} caractères est atteinte ({used} envoyés ce mois-ci, UTC) : plus rien n’est envoyé avant le mois prochain ou une limite plus haute.',
  },
  busy: {
    en: 'Too many announcements at once: this one was not sent.',
    fr: 'Trop d’annonces à la fois : celle-ci n’a pas été envoyée.',
  },
  empty_text: {
    en: 'Nothing to say: the text is empty.',
    fr: 'Rien à dire : le texte est vide.',
  },
  stopped: {
    en: 'The integration is stopping.',
    fr: 'L’intégration s’arrête.',
  },
  // The Test button.
  test_ok: {
    en: 'Azure Speech answered: voice {voice}, {size} KB of MP3 in {ms} ms. Nothing is played here: try a “Play a notification” scene action.',
    fr: 'Azure Speech a répondu : voix {voice}, {size} Ko de MP3 en {ms} ms. Rien n’est joué ici : essayez l’action de scène « Jouer une notification ».',
  },
  test_sentence: {
    en: 'Hello, this is Azure Speech speaking for Gladys.',
    fr: 'Bonjour, ici Azure Speech qui parle pour Gladys.',
  },
  test_sentence_de: {
    en: 'Hallo, hier spricht Azure Speech für Gladys.',
    fr: 'Hallo, hier spricht Azure Speech für Gladys.',
  },
};

/** The text of `key` in `lang` ('fr' or English), placeholders filled. */
export function t(key, lang = 'en', vars = {}) {
  const entry = ALL_TEXTS[key] ?? ALL_TEXTS.network;
  const text = lang === 'fr' ? entry.fr : entry.en;
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

/** Both languages, for setConnectionStatus and the action results. */
export function both(key, vars = {}) {
  return { en: t(key, 'en', vars), fr: t(key, 'fr', vars) };
}
