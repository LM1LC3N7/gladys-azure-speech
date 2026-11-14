# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-14

### Added

- First version: Microsoft Azure Speech as the text-to-speech provider of
  Gladys (type `tts`, Gladys 5.3.0+), with the key and region of the user's
  own Speech resource (official REST API, MP3 24 kHz).
- One standard neural voice per language (French, English, German) and one
  for an unknown language; speaking rate; 33 Azure regions.
- Cost guards: monthly character limit kept in `/data` (500,000 by default,
  the free tier), clips replayed from memory for the same text and voice,
  identical requests at the same moment sharing one request, no retry, at
  most 2 requests at once.
- A key refused (HTTP 401) never sent again until it or the region changes,
  or the Test button succeeds; a pause after a throttling or a server error
  (60 s doubled up to 1 h, `Retry-After` up to 6 h), kept across a restart.
- "Test the voice" button.
- The monthly limit counts what Azure bills: the SSML markup (speaking rate
  tag) and Chinese characters twice; characters XML forbids are removed; a
  choice that is not a string is refused.

[Unreleased]: https://github.com/LM1LC3N7/gladys-azure-speech/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-azure-speech/releases/tag/v0.1.1
