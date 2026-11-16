# Changelog

Notable changes to this project are recorded here, kept in sync across both languages.

## 0.1.0 - 2026-11-16

### Added

- Repository scaffolding: `package.json`, `cordis.patch.yml`, `AGENTS.md`, bilingual docs and the MIT LICENSE.
- Wiring to the shared `TLEWA/dsh-plugin-ci` pipeline: verify, `pr-guard`, drift patrol and tag-driven release.
- Migrated the `dsh-ps51-guard` development roadmap to the maintainer's local workspace (`ROADMAP.md` is git-ignored, not committed and not published).

### Notes

- The plugin body is not implemented yet; `lib/index.js` only keeps the Cordis `apply` contract so the manifest, packaging and CI wiring can be verified.
