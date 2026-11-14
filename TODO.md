# TODO

## Before announcing

- [ ] Test on a real Gladys 5.3+ with a real Azure Speech resource (F0): the
      Test button, a "Play a notification" scene action on a Sonos or Cast
      speaker, a wrong key, a key used in the wrong region, a voice the region
      does not offer.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).
- [ ] Store fields left out of the manifest on purpose (Louis' rule):
      keywords `Azure`, `Microsoft`, `Speech`, `TTS`, `text-to-speech`,
      `synthèse vocale`; no `countries` (worldwide).

## To confirm on a real account (built without one)

- [ ] The status Azure answers when the F0 quota is used up (403 expected from
      the Cognitive Services gateway; a 429 would pause instead, also fine).
- [ ] The status for a voice the region does not offer (400 expected).
- [ ] The voice lists against `GET /cognitiveservices/voices/list` (not called:
      it would be a call at start-up; a voice Azure does not know is refused,
      not billed).
- [ ] How Azure counts characters against our count (text length; SSML tags
      are not billed according to the pricing notes).

## Later

- More languages than the three of the Gladys interface, if Gladys starts
  sending them; a free voice name field for custom or HD voices.
- Speaking styles (`mstts:express-as`) for the voices that have them.
- Microsoft Entra authentication instead of a key.

## Decisions

- **0.1.0 set by hand** in package.json, package-lock.json and the manifest
  (`docker_image` `ghcr.io/lm1lc3n7/gladys-azure-speech:0.1.0`); the Release
  workflow takes over afterwards.
- **`gladys_version: ">=5.3.0"`**: the `tts` type arrived with Gladys 5.3.0.
- **REST API through Node's `fetch`**, not the Microsoft Speech SDK (a large
  native-free but WebSocket-based package for what is one POST): no dependency
  beyond the Gladys SDK. The key goes in `Ocp-Apim-Subscription-Key` (no STS
  token: one request per announcement, a token would be one more request).
  Built on the module gladys-amazon-polly (same guards, same structure).
- **`redirect: 'manual'`**: fetch would carry the key header to a redirect
  target; a 3xx is a bad answer.
- **No retry anywhere**: a retried synthesis may be billed twice and the
  answer must fit the 30 s of Gladys (25 s budget).
- **Cheapest by default**: standard neural voices only (Azure retired its
  non-neural voices; HD voices cost more and are not offered); monthly limit
  500,000 characters by default (the F0 free tier).
- **The monthly limit is a local guard**: counted before the request leaves
  (the text length: Azure gives no billed count), refunded when Azure answered
  an error status or the connection never opened, kept on a timeout, a cut
  connection, or a 200 whose clip is unusable (maybe billed).
- **Only a 401 is a refusal** (Microsoft: key invalid or of another region),
  tied to the key and the region; a 403 (F0 quota, network rules) is
  "denied", never a refusal, and does not pause.
- **The body of an error answer is never read nor shown**: it could quote the
  SSML, hence the private text; the status code says enough.
- **No call at start-up or on a schedule**: the key is checked by the first
  announcement or the Test button. The status says "Ready", not "Connected".
- **Refused key**: 8 bits of an HMAC-SHA-256 under a random salt in `/data`
  (never the key; the full hash stays in memory only). After a restart,
  another key collides with probability 1/256; the Test button clears it.
- **Pause**: 60 s doubled up to 1 h (inside the 60 s-6 h rule), a
  `Retry-After` honored up to 6 h; on every path, the Test button included.
- **Cache**: 20 clips, 20 MB of base64, 24 h, in memory only; identical
  requests at the same moment share the request in flight.
- **/data never blocks a synthesis** (as gladys-amazon-polly): the count is
  checked in memory; the write is awaited 1 s at most; the status says when
  the counter is not saved.
- **No categories beyond `assistants`** (the spec of the `tts` type).
