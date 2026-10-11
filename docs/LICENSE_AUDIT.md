# License Audit — OpenFrontIO Baseline

Baseline: `e02eeba66b4801ebae0b686e1b0e4bc03fbf3654` (2026-10-01),
branch `game/rebuild-foundation`.
Audited files: `LICENSE`, `LICENSE-ASSETS`, `LICENSING.md`, `CREDITS.md`,
`proprietary/LICENSE`, `resources/LICENSE`, `README.md`, `CONTRIBUTING.md`.

## Summary

| Category                                         | License                                         | What to do                                                                                                                                                              |
| ------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source code (`src/`, `tests/`, `zbin/`, configs) | AGPL v3.0 + Section 7 additional terms          | Keep AGPL; publish Corresponding Source for any networked modified version (AGPL §13); preserve "© OpenFront and Contributors"; do not use "OpenFront" as primary title |
| Open assets (`resources/`)                       | CC BY-SA 4.0                                    | Attribute "OpenFront" / "OpenFront Inc."; ShareAlike on derivatives                                                                                                     |
| Proprietary assets (`proprietary/`)              | All Rights Reserved                             | Do NOT extract/reuse; replace before public release                                                                                                                     |
| External CDN/DB/API assets                       | Proprietary, not in repo                        | Do NOT scrape; replace with originals                                                                                                                                   |
| Map source data                                  | Mixed (ODbL, CC-BY, CC0, Public Domain, COPDEM) | Preserve per-source attribution; review COPDEM/Noun Project items                                                                                                       |
| Branding (name, logos)                           | Reserved + §7(c) misrepresentation bar          | Rebrand; no OpenFront/FrontWars logos                                                                                                                                   |

## 1. Source code we can modify (under AGPL v3.0)

- Entire codebase (`src/client`, `src/core`, `src/server`, `tests`,
  `zbin`, `map-generator`, build configs) is AGPL v3.0 as of Phase 3
  (2025-09-04). Historical MIT (pre-2025-03-25) and MIT/GPL-split
  (2025-03-25 → 2025-09-04) code remains available under those terms
  _from historical commits only_; the combined current work is AGPL v3.
- AGPL §13 (Remote Network Interaction): any publicly networked
  modified version must offer Corresponding Source over the network.
  Plan: public fork URL + `/source` link before any hosted playtest.
- AGPL §7(b) additional term: keep "© OpenFront and Contributors" in
  footer + loading screen (or equally visible splash/main-menu) until a
  compliant rebrand notice scheme is reviewed.
- AGPL §7(c) additional term: do not misrepresent origin; do not title
  the fork "OpenFront" or imply endorsement.
- `CONTRIBUTING.md`: all contributions licensed AGPL v3 (code) /
  CC BY-SA 4.0 (assets). Our branch makes no license change.

## 2. Reusable openly licensed assets (`resources/`)

- CC BY-SA 4.0, attribution "OpenFront" or "OpenFront Inc."
- Safe to ship in the fork _with_ attribution + ShareAlike, subject to
  per-source map/data terms below.
- `resources/lang/en.json` is the i18n source of truth (Crowdin); do not
  hand-edit other locales.

## 3. Assets requiring attribution / share-alike

- ODbL (OpenStreetMap-derived maps, NJ topo): attribute
  "© OpenStreetMap contributors", preserve ODbL share-alike for those
  map derivatives; link ODbL summary in Credits.
- CC-BY 4.0 (Bedmap3): attribute authors + DOI + CC-BY link.
- CC BY-SA 3.0 DE (Wikimedia flags, Hawaii relief, Sumatra topo):
  attribute author + license link; ShareAlike.
- CC0 1.0 (Arctic SDI): no attribution required (attribute anyway).
- Public Domain (Natural Earth, NASA/JPL/USGS, Geographicus): no
  restriction (attribute as courtesy).
- PGC acknowledgement policy (Antarctica): include PGC acknowledgement.
- Noun Project icons: attribute creator + icon URL (done in
  `CREDITS.md`); confirm Noun Project terms for commercial/browser-game
  use before keeping.

## 4. Proprietary / restricted assets (`proprietary/` + external)

- `proprietary/` (8 images/logos, `OpenFront.ttf`, 3 audio files):
  All Rights Reserved; dev/test use only as part of complete OpenFront
  package. MUST be replaced. Build override means they silently win
  over `resources/` in prod — rebrand must delete or swap these files,
  not just add new ones.
- External (CDN/DB/API, premium skins, API-served SFX/music): fully
  proprietary; not in repo; no license implied. Do NOT download,
  extract, or bundle.
- `@stripe/stripe-js`: client-only; Stripe proprietary terms; no
  server-side charge code in repo (monetization lives in closed
  Cloudflare API).

## 5. Branding that should be replaced

- Name "OpenFront" / "OpenFront.io" (title, `index.html`, manifest,
  README, footer, loading screen).
- `proprietary/images/OpenFrontLogo*.svg`, `OpenFront.png/.webp`,
  `OF.png/.webp`, `Favicon.svg`.
- `proprietary/fonts/OpenFront.ttf`, menu/gameplay music, start alert.
- SEO/OG tags (`openfront.io` canonical, descriptions), PWA manifest
  name, `streams.json`/`news.json` feeds, CrazyGames/Playwire/AdSense
  snippets in `index.html` (remove or replace with our vendors).
- `gitCommit` / `CDN_BASE` / API domains (`api.openfront.io`) in
  `BOOTSTRAP_CONFIG` and `ClientEnv`.

## 6. Legally ambiguous — mark for replacement, do not assume permission

1. Copernicus DEM / OpenTopography elevation data (COPDEM license,
   "all rights reserved"): verify redistribution rights for derived
   map `.bin` files before shipping our maps; prefer regenerating maps
   from clearly licensed sources.
2. Noun Project icons: free-tier terms may require attribution and may
   restrict commercial use; confirm or redraw.
3. Historical WarFront.io code lineage (MIT): current files are heavily
   rewritten; treat combined work as AGPL, do not strip notices.
4. `CREDITS.md` vs `proprietary/LICENSE` referencing `CONTRIBUTORS.md`
   (missing file): resolve attribution file name during rebrand.
5. Crowdin translations: contributor rights flow through Crowdin terms;
   keep `en.json` workflow; do not hand-edit other locales.

## 7. Compliance checklist for the fork

- [ ] Keep `LICENSE`, `LICENSE-ASSETS`, `LICENSING.md`, `CREDITS.md`,
      `THIRD_PARTY_NOTICES.md` in the fork.
- [ ] Preserve "© OpenFront and Contributors" visibly until legal
      review of replacement notice.
- [ ] Publish fork source for any networked playtest (AGPL §13).
- [ ] Replace `proprietary/` branding + audio + font with originals.
- [ ] Add visible Credits / Open Source link (footer + settings/help
      modal) pointing at third-party notices.
- [ ] Regenerate license list from lockfile before release
      (`npx license-checker`).
- [ ] Resolve ambiguous items in §6 (COPDEM maps, Noun icons,
      CONTRIBUTORS file) before public launch.
