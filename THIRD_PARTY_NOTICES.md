# Third-Party Notices

This file records third-party content used by the OpenFrontIO baseline
forked at `e02eeba66b4801ebae0b686e1b0e4bc03fbf3654` (2026-10-01).

Our derivative game must preserve these notices and comply with the
corresponding licenses. This file is informational and does not change
any license terms. See `LICENSE`, `LICENSE-ASSETS`, `LICENSING.md`,
`CREDITS.md`, `proprietary/LICENSE`, and `resources/LICENSE`.

## 1. Source code

- OpenFrontIO — GNU Affero General Public License v3.0 (`LICENSE`).
  Copyright holders: OpenFront Inc. and Contributors; portions from
  WarFront.io Team (historical MIT, see `LICENSING.md` Phase 1).
- Additional AGPL v3 Section 7 terms (`LICENSE` tail):
  preserve "© OpenFront and Contributors" in a reasonably visible
  location (footer / loading screen / splash / main menu), and do not
  misrepresent origin or imply official endorsement. Do not use
  "OpenFront" as the primary title of a modified version without
  permission.

## 2. Open assets (`resources/`) — CC BY-SA 4.0

Per `LICENSE-ASSETS` and `resources/LICENSE`:

- All files under `resources/` (graphics, sprites, images, 3D/models,
  audio, animations, fonts, level/map data) are Creative Commons
  Attribution-ShareAlike 4.0 International.
- Attribution required: "OpenFront" or "OpenFront Inc."
- License text: http://creativecommons.org/licenses/by-sa/4.0/

Includes (non-exhaustive):

- Map binaries and manifests under `resources/maps/` (132 maps).
  Map _source data_ carries its own upstream terms — see `CREDITS.md`
  and Section 4 below. Generated `.bin` derivatives remain CC BY-SA 4.0
  as distributed, but ODbL share-alike obligations from OpenStreetMap
  data survive for those maps.
- Sprites under `resources/sprites/`, atlases under `resources/atlases/`.
- Sounds under `resources/sounds/effects/` and `resources/sounds/ambience/`.
- Fonts under `resources/fonts/` (Overpass, round_6x6_modified).
- Language files under `resources/lang/` (Crowdin-managed; source of
  truth is `en.json`).
- Flags under `resources/flags/` (1082 SVGs; Wikimedia Commons,
  CC BY-SA 3.0 DE — see Section 4).
- Images/icons under `resources/images/`, `resources/icons/`,
  `resources/public/`, plus `manifest.json`, `countries.json`,
  `QuickChat.json`, `tribeNameThemes.json`, `news.json`, `streams.json`.

## 3. Proprietary assets (`proprietary/`) — All Rights Reserved

Per `proprietary/LICENSE` (Copyright 2025-2026 OpenFront Inc. and
Contributors, All Rights Reserved):

- `proprietary/images/`: `OpenFrontLogo.png/.svg`, `OpenFrontLogoDark.svg`,
  `OpenFront.png/.webp`, `OF.png/.webp`, `Favicon.svg` — core branding.
- `proprietary/sounds/music/`: `menu-theme.mp3`, `gameplay.mp3`.
- `proprietary/sounds/effects/game-start-alert.mp3`.
- `proprietary/fonts/OpenFront.ttf`.

Permitted only for development/testing/contribution to OpenFront and
solely as part of the complete OpenFront software package. Do NOT
extract, copy, modify for redistribution, sublicense, sell, or use
separately. These files MUST be replaced with original branding before
any public release of our derivative.

Build note: proprietary assets override open assets during the
production build (`vite.config.ts`, `src/server/PublicAssetManifest.ts`).

## 4. Map / data upstream sources (see `CREDITS.md`)

- OpenStreetMap contributors — ODbL (Los Angeles, Pulicat Lake maps;
  any OSM-derived map data).
- Natural Earth — Public Domain.
- Bedmap3 Antarctica dataset (Pritchard et al., Sci Data 12, 109, 2025)
  — CC-BY 4.0.
- Copernicus Global DEM (DLR/Airbus, via EU/ESA) — proprietary COPDEM
  license; distributed via OpenTopography (all rights reserved, Terms of
  Use). Mark for replacement review.
- New Jersey topographic map — ODbL.
- Geographicus 1901 (1915) USGS New York City map — Public Domain.
- NASA Earth Observatory / JPL-Caltech / SVS / USGS — Public Domain
  (Milky Way, Titan, Luna, Antarctica GT30, general imagery).
- Polar Geospatial Center Map Catalog (2018) — PGC acknowledgement
  policy applies.
- Hawaii relief (NordNordWest) — CC BY-SA 3.0 DE.
- Nile Delta (John187) — CC BY-SA 4.0.
- Arctic SDI catalogue — CC0 1.0.
- Sumatra topography (Sadalmelik, SRTM-derived) — CC BY-SA 3.0.
- The Noun Project icons (Meko, Fauzan Adiima, Snow, Trimanggolo Mulyo)
  — Noun Project license terms apply; verify per-icon commercial terms.
- Wikimedia Commons flags — CC BY-SA 3.0 DE.

## 5. External / proprietary assets NOT in this repository

Per `LICENSE-ASSETS` and `LICENSING.md`:

- CDN-hosted assets, database-stored assets, premium skins/models/
  textures, sound effects/music served via API, and anything not
  explicitly in the repo remain property of OpenFront Inc.,
  All Rights Reserved.
- Do NOT scrape assets from the production OpenFront or FrontWars
  websites. Do NOT use FrontWars/OpenFront logos as our branding.

## 6. NPM runtime dependencies (licenses vary)

See `package.json` + `package-lock.json`. Key runtime deps and their
upstream licenses (verify via installed `node_modules/*/package.json`
before distribution):

- `express`, `compression`, `express-rate-limit`, `mrmime` — MIT.
- `ws` — MIT.
- `zod` — MIT.
- `jose` — MIT (WebCrypto JWT; Cloudflare-compatible).
- `nanoid` — MIT.
- `winston`, `@opentelemetry/*`, `@grafana/faro-web-sdk` — MIT/Apache-2.0
  (telemetry; slated for replacement on Cloudflare).
- `dotenv` — BSD-2-Clause (remove on Cloudflare; env bindings instead).
- `ejs` — Apache-2.0 (replace; file-based templates incompatible).
- `howler` — MIT (client audio).
- `lit`, `tailwindcss`, `vite`, `pixi.js` (via transitive/client) —
  MIT/BSD (client bundle).
- `@stripe/stripe-js` — proprietary Stripe terms (client-only; no
  server-side charge in this repo).
- `canvas`, `jsdom`, `vitest`, `typescript`, `eslint/oxlint`, `prettier`
  — dev/tooling only.

Run `npx license-checker --summary` (add temporarily via
`npx`, do not add as a dependency) before any public release to
regenerate this list from the locked tree.

## 7. Planned Credits / Open Source link location

- Preserve "© OpenFront and Contributors" in footer + loading screen
  until rebrand lands (AGPL Section 7 requirement).
- Eventual derivative must add a visible Credits / Open Source link.
  Recommended locations (to be implemented in Prompt 1+):
  `src/client/components/PageFooter.ts` (site footer) and the settings/
  help modal (`user-setting` / `help-modal` in `index.html`), linking to
  `/credits` (or footer anchor) containing this file plus
  `docs/LICENSE_AUDIT.md`.
