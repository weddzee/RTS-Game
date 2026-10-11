# Private-Lobby Mode — Prompt 1 Foundation

Temporary product name: **PROJECT_NAME** (not a permanent brand).

Objective: "Open browser → enter nickname → create/join private room →
choose spawn → play." Battle plans, planes, factories and progression are
explicitly out of scope.

## What changed

| Area          | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity      | `PROJECT_NAME` text replaces the proprietary OpenFront logo in `PlayPage` (mobile bar) and `DesktopNavBar`; `main.title` in `en.json` + `<title>` in `index.html`. Upstream files under `proprietary/` are untouched on disk.                                                                                                                                                                                                                                                                                                                                                  |
| Attribution   | `© OpenFront and Contributors` footer notice preserved (AGPL §7). New `credits-modal` (`src/client/CreditsModal.ts`) opened from the private menu and the footer; Texts under `credits.*` in `en.json`. Deployments must set `credits.our_source_url` to their own fork.                                                                                                                                                                                                                                                                                                       |
| Menu          | New `<private-lobby-menu>` (`src/client/PrivateLobbyMenu.ts`) rendered first in `PlayPage`: nickname, CREATE PRIVATE GAME, room-code + JOIN GAME, pacing/map/bots selects, Settings, Credits. All strings via `translateText` + `private_menu.*` keys (`en.json` only).                                                                                                                                                                                                                                                                                                        |
| Nicknames     | `src/core/PrivateNickname.ts`: trim, 1–20 code points, RENDERABLE charset (HTML-safe by construction; Lit `${}` escapes on render). Persisted to `localStorage["username"]` only — no account. Wire `UsernameSchema` widened `.min(3)` → `.min(1)` (widening is archive-safe; `.max(27)` unchanged); the account form keeps its own min-3 check in `validateUsername`. `Main.handleJoinLobby` prefers the menu name; Worker trims + clamps authoritatively and disambiguates duplicates inside room-code games (`" 2"` suffix in wire-safe characters, reconnects unaffected). |
| Rooms         | `src/server/PrivateRooms.ts`: 6-char uppercase codes (no `0/O/1/I/L`), server-minted with worker affinity, `PrivateRoomRegistry` per worker. `POST /api/create_private_game` (auth + pacing preset → game + code), `GET /api/room/:code` (404 `room_not_found` for unknown/malformed/expired). Join-by-code reuses the standard private flow (`JoinLobbyModal` resolves codes; started rooms admit spectators, turn players away with a clean message; full rooms surface the existing `full-lobby` error).                                                                    |
| Pacing        | `src/core/MatchPacing.ts`: Rapid 10 / Standard 15 / Extended 20 / Sandbox unlimited, with centralized resource/construction/movement/troop/XP/late-game multipliers. Only `maxTimerValue` + `goldMultiplier` ride the wire today; the rest are recorded on the room and documented for later phases — no scattered constants.                                                                                                                                                                                                                                                  |
| Host controls | Map + bots via existing lobby UI; duration preset via the menu (stored on the room, applied to `maxTimerValue`/`goldMultiplier`). Fog / aircraft / advanced-supply toggles are recorded on the room record and returned by `/api/room/:code`, with no simulation effect yet (their systems land in later phases).                                                                                                                                                                                                                                                              |

## Retained but disabled (not deleted)

Per Prompt 1's "disable / feature-flag / isolate / bypass" rule, upstream
systems stay in the tree so the game cannot destabilize:

- **Store / subscriptions / cosmetics gating** — code retained. Inline
  Stripe stays off by leaving `STRIPE_PUBLISHABLE_KEY` unset (existing
  `stripeInlineAvailable() === false` path); public-listing subscription
  gates are server-enforced and irrelevant to unlisted private rooms.
- **Public matchmaking / ranked / hosted-browser** — retained; the menu
  no longer routes to them. `GameModeSelector`, `Matchmaking`,
  `RankedCheckin` untouched.
- **Accounts / JWT / Turnstile** — retained and still enforced outside
  dev. Private rooms need no account: dev joins use the persistent-ID
  fallback; prod keeps the existing token + Turnstile path unchanged.
- **Advertising** — off: `window.adsEnabled = false` in `Main.ts`
  (Admiral payload + adblock watcher never start; promos early-return)
  plus the Playwire/gtag/beacon script blocks commented out in
  `index.html`. Restore the blocks + the old `onUserMe` computation to
  re-enable.
- **Telemetry** — off by default as before (`FARO_COLLECTOR_URL` unset,
  `TELEMETRY_ENABLED=false`, OTEL requires endpoint + auth). Untouched.
- **News / streaming / clan / leaderboard / rewards modals** — retained,
  reachable via existing nav; not on the private path.

## Lobby state mapping (Prompt 1 §1.4)

The existing lobby already carries: host (creator persistentID +
`lobbyCreatorClientID`), players (roster broadcast), selected map +
options (`gameConfig`), ready/start (`prestart`/`start`), spectator
flags, started boolean. Room codes add the alias layer (`roomCode`,
`options.durationPreset`, recorded toggles) without touching it.

## Re-enabling / next phases

- Set `credits.our_source_url` to the fork before any hosted playtest
  (AGPL §13 source offer).
- Fog / aircraft / supply: read `PrivateRoomOptions` from the room
  record when those simulations land; enforcement points are marked in
  `PrivateRooms.ts`.
- Pacing consumers: import `matchPacingConfigFor` — do not copy numbers.
