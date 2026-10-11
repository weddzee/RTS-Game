# Upstream Baseline — OpenFrontIO Fork

## Upstream repository

- URL: https://github.com/openfrontio/OpenFrontIO.git
- Default branch at clone time: `main`
- Clone method: `git clone https://github.com/openfrontio/OpenFrontIO.git OpenFrontIO`
  (`gh` CLI not installed on this machine; HTTPS clone is equivalent).
  Local checkout lives in `OpenFrontIO/` next to `prompts/`.

## Commit SHA

- `e02eeba66b4801ebae0b686e1b0e4bc03fbf3654`
- Commit date: 2026-10-01 22:57:15 +0200
- Subject: "Fix solo game start opening the YouTube tutorial on Firefox Android 📺 (#5745)"

## Branch

- `game/rebuild-foundation`, created from upstream `main` at the SHA above.
- No work performed on upstream `main` (branch verified via
  `git branch --show-current`).

## Runtime requirements

- Node.js: `>=24.15.0 <25` (this machine was on `v24.14.1`; upgraded via
  `winget upgrade OpenJS.NodeJS.LTS` to `v24.19.0` before installing).
- npm: `>=12.1.0 <13` (this machine was on `11.19.1`; upgraded via
  `npm install --global --ignore-scripts npm@12.1.0` to `12.1.0`).
- Modern browser: Chrome / Edge / Firefox.
- No native desktop dependency; laptop-responsive; Cloudflare-ready
  architecture required (see `docs/CLOUDFLARE_COMPATIBILITY_AUDIT.md`).

## Package manager requirements

- Do NOT use `npm install` / `npm i` for project dependencies.
- Use `npm run inst`, which runs `npm ci --ignore-scripts` (exact
  versions from `package-lock.json`, no lifecycle scripts).
- `.npmrc` enforces: `ignore-scripts=true`, `engine-strict=true`,
  `min-release-age=7`, `allow-git=none`, `allow-remote=none`,
  `allow-file=none`, `allow-directory=none` (dependency releases must be
  ≥7 days old; no git/remote/tarball/directory deps).

## Build commands

- `npm run build-dev` — `concurrently "tsc --noEmit" "vite build --mode development"`.
- `npm run build-prod` — `concurrently --kill-others-on-fail "tsc --noEmit" "vite build" && tsx scripts/buildAssetHashes.ts`.
- No plain `npm run build` script exists.

## Test commands

- `npm test` — `vitest run && vitest run tests/server`.
- `npm run test:coverage` — `vitest run --coverage`.
- Single file: `npx vitest tests/YourTest.test.ts --run`.
- By name: `npx vitest NationAllianceBehavior --run`.
- Matchmaking: `npm run test:matchmaking[:e2e|:cancel]`.
- Perf: `npm run perf[:game]` / `npx tsx tests/perf/run-all.ts`.
- Replay: `npm run replay:game`.

## Development commands

- `npm run dev` — client (Vite `:9000`) + server (dev env) with hot reload;
  opens browser unless `SKIP_BROWSER_OPEN=true`.
- `npm run start:client` — Vite client only.
- `npm run start:server-dev` — game server with dev env
  (`GAME_ENV=dev`, Turnstile test key, dev API keys, `DOMAIN=localhost`).
- `npm run dev:staging` / `npm run dev:prod` — local client against
  staging/production API backends.
- `npm run lint` — `oxlint` + `eslint`; `npm run lint:fix` auto-fixes.
- `npm run format` — Prettier.

## Baseline health (this machine, 2026-10-04)

- Install (`npm run inst`): PASS — 666 packages, after toolchain upgrade
  above. No dependency upgrades performed.
- Lint (`npm run lint`): PASS — exit 0, no findings.
- Build (`npm run build-dev`): PASS — `tsc --noEmit` exit 0; Vite built
  in ~23 s (1447 modules; `static/index.html` 20.14 kB; JS/CSS/worker
  chunks emitted). Only pre-existing warnings (chunk >500 kB,
  plugin-timing notices). Per task instructions these were left alone.
- Tests, main suite (`vitest run`): 561/567 files passed, 7257 tests
  passed, 74 failed, 1 skipped. All 74 failures are in Linux
  deploy-script tests (`UpdateFlagLatest` 12, `UpdateRegister` 7, plus
  `UpdateTraefikHostRule` / `UpdateRestartPolicy` / `DeployIdentity` /
  `GenerateNginxUpstream` which pass once Git `bash` is on `PATH`).
  Root causes on this Windows box: `C:\Windows\System32\bash.exe` is an
  WSL stub with no distro installed, and `jq` is not installed
  (`environment: line 13: jq: command not found`). Zero game-logic
  failures. Not fixed (environment-only, unrelated to gameplay).
- Tests, server suite (`vitest run tests/server`): PASS — 80/80 files,
  893/893 tests.
- Local dev server smoke: PASS — `Server.ts` boots master `:3000` +
  workers `:3001`/`:3002`, generates map playlist, creates public
  games; `GET /` returns HTTP 200 (~20 kB `index.html`). Expected
  dev-only warnings (no local API at `:8787` for cosmetics/clan tags,
  no ranked coordinator) are fail-open and non-fatal.
- Browser interactive check (menu / map / local match / interaction /
  territory handover / client-server sync): NOT performed headlessly in
  this environment. Manual follow-up required: `npm run dev`, open
  menu, start single-player match, expand territory, confirm sync.

## Documents produced (this branch)

- `docs/UPSTREAM_BASELINE.md` (this file)
- `docs/LICENSE_AUDIT.md`
- `docs/ARCHITECTURE_BASELINE.md`
- `docs/CLOUDFLARE_COMPATIBILITY_AUDIT.md`
- `THIRD_PARTY_NOTICES.md`
