# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** of type `tts` (text-to-speech
provider, Gladys 5.3.0+): a Node.js service (Node 22+, ESM, no build step) in
its own sandboxed Docker container, talking to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js)
and to **Microsoft Azure Speech** through its official REST API (Node's
`fetch`, no other dependency) with the key and region of the user's own
Speech resource. Gladys
sends a text (2,000 characters at most) and a language; the integration
answers an MP3 clip as `audio/mpeg;base64,...` within 25 s (Gladys waits
30 s). Unofficial: not affiliated with Microsoft.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "limit"   # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run mutants                           # mutation check (scripts/mutants.json), use memcap
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: AzureSpeechApp, FileStore, createSpeech
src/app.js                        AzureSpeechApp: handlers, configuration, voice, SSML, cache,
                                  monthly limit, queue, pause, refusal, status, Test button
src/azure.js                      the only network access: one POST, error classes by
                                  status, bounded read of the clip, no redirect
src/config.js                     the form, checked (never throws, never shows a bad value)
src/store.js                      /data/azure-speech.json (count, pause, refusal)
src/constants.js                  voices, regions, output format, bounds, manifest keys
src/i18n.js                       runtime texts (en/fr)
gladys-assistant-integration.json manifest: type tts, config, Test action
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test: fake Gladys, scripted Azure, virtual clock;
                                  test/azure.test.js: the real fetch on a local server
scripts/                          cover.png generator, mutation runner and list
```

## Rules

- **The bill is the user's.** Standard neural voices only; never a retry;
  never a redirect followed; the monthly limit (500,000 by default, the free
  tier) counted BEFORE a request leaves (refunded only when Azure answered an
  error status, or the connection never opened); the Test button respects the
  pause and the limit.
- **Never the key** in a log, the status, an error, `/data` or a test fixture
  other than the made-up ones of `test/helpers/app.js`. The body of an Azure
  error is never read (it may quote the text). The spoken text is never logged
  nor written to `/data` (only its length).
- **Only a 401 is a refusal** (key wrong or of another region), tied to the
  key and the region; a 403 is "denied" (quota, network rules). A refused key
  is never sent again by itself; a new key or region is always tried.
- **Throttling or 5xx**: a pause on the monotonic clock (60 s doubled up to
  1 h, Retry-After up to 6 h), its wall end in `/data`; the wall clock serves
  only `/data` and the calendar month (UTC) of the limit.
- **/data unreadable is not empty**: read again every 10 s, one read at a time,
  never written before it was read; a synthesis waits 2 s for it at most.
- **Config keys and the action key are forever** (`speech_key`,
  `region`, `voice_fr|en|de`,
  `default_language`, `speaking_rate`, `monthly_character_limit`,
  `test_voice`): users store their values.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (the SDK tests talk to a local
  server on 127.0.0.1).
