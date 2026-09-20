# Contributing to TroTro Guide

Thanks for helping. TroTro Guide gives riders step-by-step trotro directions for Accra:
which car to board, what the mate shouts, and where to get off. It has to work on a cheap
phone, on a weak connection, and often with none. Every contribution is measured against that.

By taking part you agree to follow the [ground rules](#ground-rules) and the
[code of conduct](#code-of-conduct).

## Ways to contribute

- **Fix a wrong route detail.** A mate shout, route name, or stop that doesn't match what you
  saw on the road. See [Data contributions](#data-contributions).
- **Report a bug or a missing route.** Open an issue with the steps you took, what you expected,
  and what happened. For a route problem, include the route number, direction, and where you boarded.
- **Fix a bug or build a feature.** See [Development](#development) and
  [Pull request protocol](#pull-request-protocol).
- **Improve docs or translations.**

For anything bigger than a small fix, open an issue first so we can agree on the approach
before you spend time on it.

## Good first issues

Known gaps that need a hand:

- Split the two largest files, `components/Trotro.tsx` and `lib/corepack/client.ts`.
- Add component and end-to-end tests. Only the logic in `lib/` is covered today.
- The admin page key (`app/admin/treasure-map/page.tsx`) is shipped in the client bundle. It only
  gates public OpenStreetMap data, but it should come from configuration.
- Per-stop mate shouts are captured by the admin tool but dropped when the pack is built.

## Ground rules

1. **Offline first.** Search and directions run on the device from a cached data pack. New
   features must not make the core flow depend on the network.
2. **Privacy.** Raw GPS never leaves the device or reaches logs. Servers only ever see a coarse
   H3 cell (resolution 9). Don't add code that sends, stores, or logs precise coordinates.
3. **Safety.** A wrong mate shout puts a rider on the wrong car. Route data changes need evidence,
   and unverified data must be presented as unverified.
4. **Low-end devices.** Watch bundle size and main-thread work. Prefer small, dependency-free
   solutions over new packages.
5. **Free and ad-free for riders.** No tracking, ads, or login walls.

## Development

Requirements: Node.js 20 or newer and npm.

```bash
git clone https://github.com/eshunyhaw-del/TroTroGuide.git
cd TroTroGuide
npm install
node scripts/prepare-core-pack.mjs   # builds the offline data pack into public/core-pack
npm run dev                          # http://localhost:3000
```

No account or API key is needed to run the app. Every service below is optional, and the app
degrades gracefully without it. To use one, copy `.env.example` to `.env.local` and fill it in.

| Service | Without it |
| --- | --- |
| Supabase | Search and directions still work from the local pack |
| Upstash Redis | Rate limiting is disabled |
| Google Sheets webhook | "Missing route" reports are only logged |
| Mapillary token | The "Look out for" card shows no street image |

Useful commands:

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run typecheck` | TypeScript check |
| `npm test` | Unit tests (Vitest) |
| `npm run build` | Builds the pack, then the production app |
| `npm run extract:osm` then `npm run build:admin` | Re-pulls OSM data and regenerates the admin snapshot (maintainers) |

### Project layout

| Path | Contents |
| --- | --- |
| `app/` | Next.js routes and API handlers |
| `components/` | React components |
| `lib/corepack/` | Loading, indexing, and searching the offline pack; trip planning |
| `lib/onboard/` | On-board guidance: map matching and ride progress |
| `lib/geo/` | Pure geometry helpers (distance, polyline, H3) |
| `lib/streetview/` | Street-level imagery, behind a provider interface |
| `edge/` | Cloudflare Worker that caches the read APIs |
| `db/migrations/` | Postgres schema, applied in order |
| `scripts/` | Data extraction and pack building |
| `data/` | Field corrections and sample data |

## Data contributions

The map data starts as OpenStreetMap and is corrected by field verification. When you know that
something in the app is wrong, **correct the existing record. Don't add a parallel one.**

### Correcting a route's mate shout or name

Edit `data/route-overrides.json`. Entries are keyed by the OSM relation ref:

```json
{
  "routes": {
    "relation/16498284": {
      "shout": "Dodowa Dodowa Dodowa",
      "note": "Trotro 929 toward Oyibi. Field-verified: the mate shouts Dodowa, not the far terminus Ministries."
    }
  }
}
```

- `shout` replaces the mate's call (the trailing `!` is added for you). `name` optionally
  replaces the route's display name.
- `note` is required. Say what you observed, where, and when. Changes without evidence
  will be asked for it.
- A route is one direction. Each direction is its own relation, so check which one you mean.
- Find the relation ref by searching the route number in `public/admin/osm-data.json`, or on the
  route's OpenStreetMap page (`relation/<id>`).
- Rebuild with `node scripts/prepare-core-pack.mjs` and search the route in the app to confirm
  the change shows up.

### Rules for data

- **Don't edit `public/admin/osm-data.json` by hand.** It is generated from OpenStreetMap, and
  a regeneration would silently undo your edit. Put corrections in the override file.
- If the OpenStreetMap record itself is wrong, please also fix it on
  [openstreetmap.org](https://www.openstreetmap.org). That helps everyone.
- **Licensing.** OSM-derived data is ODbL and keeps its attribution. Never commit raw extracts
  (`data/osm_raw/`), built packs (`public/core-pack/`, `data/core-pack-verified.json`), or the
  other generated files listed in `.gitignore`.
- Don't add personal information (phone numbers, plates, names of drivers or mates).

## Code style

- TypeScript in strict mode. Match the file you are editing: naming, imports, formatting.
- Keep functions small and pure where you can. Put logic in `lib/` and keep components thin.
- **Comments explain why, not what.** Write one short line for a non-obvious constraint or
  trade-off. Don't narrate the code, restate a name, or leave history ("added for X", "old
  behaviour was Y"). If a comment needs a paragraph, the code probably needs restructuring.
- No new dependency without a reason in the PR description.
- Never put secrets in code. Anything prefixed `NEXT_PUBLIC_` ships to the browser.

## Tests

Logic in `lib/` is unit tested with Vitest, and the tests sit next to the code
(`thing.ts`, `thing.test.ts`). Add or update tests for behaviour you change. A bug fix should
come with a test that fails without the fix.

## Database migrations

Files in `db/migrations/` are numbered and append-only. Never edit a migration that has been
merged. Add a new one. Keep the separation between the OSM mirror schema and the `core` schema,
and include row-level security for any new table.

## Pull request protocol

1. **Fork** the repo and create a branch from `main`. Name it by intent, for example
   `fix/oyibi-mate-shout` or `feat/route-search-filter`.
2. **Keep it small.** One logical change per PR. Unrelated cleanups go in their own PR.
3. **Commit messages:** a short imperative subject of about 72 characters or fewer
   ("Fix Oyibi mate shout"), then a body that says why if it isn't obvious. Commit under your
   own name and email.
4. **Before you push**, run both and make sure they pass:
   ```bash
   npm run typecheck
   npm test
   ```
5. **Open the PR** against `main`, fill in the template, and link the issue if there is one.
   For UI changes, add a screenshot at phone width.
6. **Review.** A maintainer will review, and may ask for changes. Push follow-up commits to the
   same branch. Once approved, a maintainer merges. Don't merge your own PR.
7. **Be patient and be kind.** This is a volunteer project.

A PR is ready to merge when it passes CI, has tests for changed behaviour, doesn't add secrets
or generated/licensed data, and follows the ground rules above.

## Licensing of contributions

The code is MIT licensed (see `LICENSE`). By opening a pull request you confirm you wrote the
change or have the right to submit it, and you agree it is released under the same license.
Photographs in the repository are by @thefotowalker and are not covered by the MIT license.
Don't submit photographs or other media unless you own them or they carry a license that allows
redistribution. State the source and license in the PR.

## Reporting security issues

Please **don't** open a public issue for a vulnerability. Use GitHub's private
"Report a vulnerability" option on the repository's Security tab. If it is unavailable, open an
issue asking for a private contact, without any details. Never include real credentials or a
rider's location data in a report.

## Code of conduct

Be respectful and assume good faith. No harassment, discrimination, or personal attacks.
Critique the work, not the person. Maintainers may edit or remove contributions and block
participants who break these rules.
