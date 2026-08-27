# Development

```bash
git clone https://github.com/fbnlrz/trek-track.git
cd trek-track
npm install
```

`trek-plugin-sdk` is a **devDependency only** — the host makes
`require('trek-plugin-sdk')` resolve inside the plugin process at runtime. Never
vendor it, and never add a runtime dependency: TREK does not run `npm install` on a
plugin, so anything else would have to be bundled.

Since 2.0.0 targets TREK 4, the SDK must be **1.6.0 or newer**. 1.5.0's vendored
permission list predates TREK 4 (58 ids against TREK 4's 63): it does not know
`hook:map-layer-provider` or `hook:day-schedule-provider`, both of which this
manifest now declares, so it rejects the manifest with `unknown permission(s): …`.
That is a stale local toolchain, not a broken manifest — check the SDK version
before believing the message. The registry's own CI already vendors TREK 4's full
63-id list, so a published entry is not affected.

### The vendored SDK — a temporary bootstrap

TREK 4.0.0 shipped before `trek-plugin-sdk` 1.6.0 reached npm, where `latest` is
still 1.5.0. So `npm install` against the registry cannot produce a toolchain that
accepts this manifest, and `npx -y trek-plugin-sdk` actively resolves to the wrong
one. To keep the repo self-contained, **1.6.0 is committed as a tarball** at
`vendor/trek-plugin-sdk-1.6.0.tgz` (built from `plugin-sdk/` in the TREK repo, MIT),
and the devDependency points at it:

```json
"trek-plugin-sdk": "file:vendor/trek-plugin-sdk-1.6.0.tgz"
```

A fresh clone therefore works with a plain `npm install`, and every npm script calls
the local `trek-plugin` binary rather than `npx -y`.

**This is meant to be removed.** Once 1.6.0 (or newer) is on npm:

```bash
npm pkg set devDependencies.trek-plugin-sdk="^1.6.0"
rm -rf vendor && npm install
```

Nothing else depends on it. The tarball is a **devDependency and never ships**:
`pack` writes only the manifest, `README`, `LICENSE`, `package.json`, `server/` and
`client/` — `vendor/` and `node_modules/` are not in the artifact, so the "never
vendor the SDK" rule (which is about the *installed plugin*, where the host injects
`require('trek-plugin-sdk')` itself) still holds. Verify with `unzip -l plugin.zip`
after any change to the packaging.

## Layout

| Path | |
|---|---|
| `trek-plugin.json` | manifest — permissions, egress, settings, TREK range |
| `server/index.js` | backend: routes, hooks, all `ctx` access |
| `client/index.html` | the whole widget, single file; TREK's kit is inlined at the `<!-- trek:ui -->` marker **when you pack** |
| `server/data/airlines.json` | generated — do not edit by hand |
| `server/data/airline-overrides.json` | hand-verified airline codes, applied last |
| `scripts/` | dataset build, documentation screenshots, store image |
| `vendor/` | the pinned SDK tarball — a temporary bootstrap, see above; never shipped |

## Commands

```bash
npm run build:airlines   # regenerate server/data/airlines.json from upstream
npm run screenshots      # regenerate docs/img/* (needs Chrome + npm i)
npm run store-shot       # regenerate docs/screenshot.png, the registry's store image
npm run validate         # the registry gates that can be answered offline
npm run status           # the same, graded, plus the one next command
npm run dev              # http://localhost:4317 — read the grant banner (see below)
npm run pack
```

Every script uses the **local** `trek-plugin` binary, not `npx -y trek-plugin-sdk`,
which resolves to 1.5.0 — see the version note above.

**Run `npm run dev` at least once before publishing and read its banner.** A hook,
event subscription, job or GDPR handler whose permission is missing is not an error:
TREK installs the plugin, activates it, and simply never calls that entry point, with
no log line anywhere. `validate` cannot catch it — it never loads `server/index.js` —
so the dev banner is the only automatic check that the manifest and the code agree.

## The airline dataset

`npm run build:airlines` merges, in increasing precedence:

1. **OpenFlights** — broad but frozen around 2017, kept only for extra historical name
   spellings.
2. **Virtual Radar Server standing-data** (CC0) — the authority for anything modern,
   pinned to a commit so builds are reproducible and an upstream edit cannot silently
   change bundled codes.
3. **`server/data/airline-overrides.json`** — hand-verified fixes for brand names,
   collisions and carriers missing upstream. Always wins.

The build then asserts a probe list of 58 known airline codes and **exits non-zero
without writing** if any mismatch. Treat a probe failure as a real signal: OpenFlights
alone maps `IndiGo` to `I9` (a defunct US carrier) and `Scoot` to its retired `TZ`, and
a wrong code silently queries someone else's flight.

Adding an override requires a code you actually verified from a fetched source —
record which one in the `src` field. If no source can confirm it, leave it out.

## Tests

The test suite is not committed. If you have it locally:

```bash
npm test              # unit + authorization tests, no network, no TREK host
npm run test:render   # renders the widget in headless Chrome with TREK's real kit
```

The 2.0.0 work added two suites under the same convention (`test/` stays in
`.gitignore`), and they are worth recreating if you do not have them:

- **`test/v4.test.js`** drives the plugin's own entry points through the SDK's
  `createMockHost`, which enforces the same permission model as TREK — including the
  *entry-point* grants, so a hook fired without its `hook:*` permission throws in the
  test exactly as it would be silently skipped in production. It covers the four new
  provider hooks' return shapes and host caps, the GDPR handlers, the event
  subscriptions, and asserts that the job and the event handlers never touch a
  route-only namespace.
- **`test/notify.test.js`** runs against a **real `node:sqlite` database** with a
  stubbed AeroDataBox, because the notification fix cannot be tested any other way:
  the mock's db is a recorder that reports `{changes: 0}` for every write, and the fix
  turns on a compare-and-swap whose whole point is reading a real `changes` count. It
  pins the send-before-persist ordering, the roll-back on a failed send, the quota
  governor, and the background job's merge.

Two conventions worth keeping if you add tests:

- **`FT_SERVER` / `FT_CLIENT`** point the suites at an older build, so a regression
  test can be proven non-vacuous. A security test that passes against the vulnerable
  code is worthless — the authorization tests fail 14-of-18 against the pre-fix
  server, and the layover scenario fails against the pre-fix client.
- **The render harness inlines the SDK's real `TREK_UI_CSS`** rather than an
  approximation, so what it asserts is what the host actually renders. It skips
  cleanly when Chrome or the devDependencies are absent.

## Things that will bite you

- **`ctx.trips` works only inside route handlers.** In `onLoad`, in the refresh job and
  in event handlers there is no acting user, so it throws `RESOURCE_FORBIDDEN`. Never
  wrap that call in a swallow-everything helper — doing so once turned a failed
  permission check into a successful request. The userless paths work off rows the
  write side already membership-checked, which is why the trip id is normalised before
  it is stored.
- **Egress is driven by `http:outbound:<host>` permissions**, not by `egress[]`. A
  host in `egress[]` but not granted is silently blocked at runtime. Keep both lists
  identical, and remember any new host needs a README entry (a hard CI gate) and admin
  re-approval on update.
- **Every permission string must appear verbatim in `README.md`.** It is a hard CI
  gate and it is the thing a permission change breaks first — 2.0.0 went from 12
  permissions to 20, and each new one needed a row in the README's Permissions table
  before `validate` would pass. Any added permission also forces **admin re-approval**
  on update, so the plugin sits inactive until someone approves it.
- **A hook or job you forget to declare is not an error.** TREK simply never calls that
  entry point, silently; `trek-plugin dev` warns at load, nothing else does.
- **The `<!-- trek:ui -->` kit is inlined at pack time**, not at runtime — `pack`
  rewrites `client/index.html` with the design kit of the SDK doing the packing. So a
  release picks up a newer kit only if it is **re-packed**; re-tagging an existing
  artifact changes nothing. It also means the same tree packed with two SDK versions
  produces different bytes, and therefore a different sha256.
- **The UI frame renders no bundled or external images.** Opaque origin, strict CSP —
  only inline SVG and `data:`/`blob:` work. `trek-plugin dev` applies no CSP, so
  something that works there can still fail in the real host.
- **`docs/` is not shipped** in `plugin.zip` by design; the store fetches images from
  GitHub at the pinned commit.
- **Git tag must equal the manifest version**, and the registry pins the release
  asset's sha256 — never re-upload a released `plugin.zip`, cut a new version.

## Releasing

```bash
# bump "version" in trek-plugin.json first, then:
./node_modules/.bin/trek-plugin publish --repo fbnlrz/trek-track --tag v2.0.0 --sign
```

Release with an SDK that is **1.6.0 or newer**, for the reason above: an older one
rejects the manifest before it packs anything.

**Re-pack, never re-tag.** Because the design kit is inlined at pack time, an existing
release asset is frozen with the kit of the SDK that built it. Picking up a newer kit
means a new `pack`, a new version and a new release — the registry pins the asset's
sha256, so released bytes are immutable in practice anyway.

Signing is a one-way door: once shipped signed, an unsigned or differently-keyed
update is refused until an admin re-trusts the plugin. Back up
`~/.trek-plugin/signing.key`.

The registry entry (`registry/plugins/flight-tracker.json` in
[liketrek/TREK-Plugins](https://github.com/liketrek/TREK-Plugins)) must keep the
maintainer-set top-level `reviewedAt` and `boundOwner` fields, and keep prior versions
in `versions`, newest first. `entry --sign` regenerates only the current version block,
so re-add those by hand.

Its `trek` field carries the manifest's range verbatim — for 2.0.0, `">=4.0.0 <5.0.0"`.
It is the only compatibility field a new version block needs, and CI checks it against
the manifest at the pinned commit. **Leave the 1.8.0 block in `versions[]` untouched**:
TREK 3.x instances resolve to it, and removing it would strand them.

## Updating this wiki

The pages live in `wiki/` in the main repo and are pushed to the wiki repo:

```bash
node scripts/publish-wiki.js
```
