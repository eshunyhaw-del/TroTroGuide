# TroTro Guide

**Step-by-step trotro directions for Accra: free, offline, and safety-first.**

New to the city, or just this neighbourhood? TroTro Guide tells you which trotro to board, what
the mate is shouting, and where to get off, right in your hand.

**Live app: [app.trotroguide.com](https://app.trotroguide.com/)**

## What it does

- **Find your trotro.** Type a destination and get the nearest stop, the car to board, and the
  mate's call to listen for.
- **Works offline.** Once loaded, search and directions need no signal or data.
- **On-board guidance.** A "you are here" dot follows the ride and tells you when to get down.
- **Safety guide.** How to stand, board, read the mate's calls, and the hand signals every rider uses.
- **Free.** No fares, no ads, no login. A community project mapping Greater Accra's trotros.

## Getting started

Requires Node.js 20 or newer.

```bash
npm install
node scripts/prepare-core-pack.mjs   # builds the offline data pack
npm run dev                          # http://localhost:3000
```

No API keys are needed to run the app locally. See `.env.example` for the optional services.

```bash
npm run typecheck
npm test
npm run build
```

## Built with

Next.js, React, TypeScript, MapLibre GL, MiniSearch, and H3. Optional backing services are
Supabase, Upstash Redis, and a Cloudflare Worker for edge caching.

## Contributing

Contributions are welcome, from code to fixing a wrong mate shout you heard on the road.
Read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License and attribution

The source code is released under the [MIT License](LICENSE). Photographs in the repository are
not covered by that license. They are by @thefotowalker, used with permission, and their owner
retains all rights.

Map data (c) [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, available
under the [ODbL](https://opendatacommons.org/licenses/odbl/). The Aspekta typeface is used under
the SIL Open Font License (`app/fonts/OFL.txt`).

Made in Accra.
