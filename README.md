# Azure Speech for Gladys Assistant

Unofficial [Gladys Assistant](https://gladysassistant.com) integration, not
affiliated with Microsoft: a **text-to-speech provider** (manifest type `tts`)
that speaks the Gladys announcements with the neural voices of **Microsoft
Azure Speech**, billed to your own Azure subscription (free tier F0 included).

- French, English and German voices, one per language, standard neural voices
  only (the HD voices cost more); speaking rate; the region of your resource;
- a monthly character limit kept in `/data` (500,000 by default: the free
  tier), the same text in the same voice replayed from memory, no retry that
  could be billed twice;
- the official REST API (`Ocp-Apim-Subscription-Key`, SSML, MP3 out) through
  Node's own `fetch`: no dependency beyond the Gladys SDK.

Needs Gladys 5.3.0 or later. Never tested with a real Azure account yet.

Documentation: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test            # node --test
npm run lint
npm run format:check
npm run mutants     # mutation check of the guards (scripts/mutants.json), with memcap
npm run cover       # regenerates cover.png
```

Rules for contributors and coding assistants: [CLAUDE.md](CLAUDE.md).
Open points and decisions: [TODO.md](TODO.md).

## Credits and license

Apache-2.0 ([LICENSE](LICENSE)). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
