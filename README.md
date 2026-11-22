# ARK Explorer

A fast, lightweight, self-hostable block explorer for the [ARK](https://ark.io) blockchain (ARK Core v3 mainnet). It
is a static site: build it once, copy the `dist/` folder to any webserver, done. There is no backend, database or
indexer to run; every visitor's browser reads the official public ARK API (`api.ark.io`) directly.

Live instance: **https://ark.geops.net**

> **Independent community project.** ARK Explorer is not affiliated with, endorsed by or supported by ARK.io / ARK SCIC.
> "ARK" is used only to describe the blockchain this tool reads. Data comes from the official public ARK API and is
> shown as-is, without warranty (see the [MIT license](LICENSE)).

## Features

- **Validators** (ARK's new name for delegates): one live table combining a validator list and a validator monitor. Switch between **Rank View** (by
  rank) and **Forging View** (this round's forging order). For each validator it shows:
  - this round's status: forged (with the block height), forging now, next, a countdown to its slot, or missed
  - votes and approval %
  - voter count (voters holding at least 1 ARK, the same count ArkScan shows)
  - blocks produced
  - missed blocks in the last 24 h
  - forging health: forging, missed last slot, or dead (missed several slots in a row)
  - time since its last block

  Active, standby and resigned validators are listed separately, and you can filter them by name.
- **Blocks**: a live list of the latest blocks, paging through the whole chain, and a detail page for each block with
  its transactions.
- **Transactions**: a live list of the latest transactions and a detail page for each one. Detail pages cover all
  Core v3 types: multipayment recipients, votes with validator names, memo, signatures and asset data. Transactions
  still waiting in the pool update by themselves once they are confirmed.
- **Wallets**: every wallet holding at least 1 ARK, largest first, with rank, share of supply and vote. Each
  wallet page shows balance, vote, public key, second-signature and multisignature details, transaction history (all, sent
  or received), and a voters tab for validators. A wallet page refreshes by itself when a new block touches that wallet.
- **Named wallets**: exchange and ARK team wallets get their names everywhere an address is shown, the same names
  ArkScan uses. They come from ARK's public list,
  [`ArkEcosystem/common` `mainnet/known-wallets-extended.json`](https://github.com/ArkEcosystem/common/blob/master/mainnet/known-wallets-extended.json):
  a copy ships with the site (`src/lib/known-wallets.json`) and the live file is fetched from GitHub at most once a
  day, so new entries show up without a rebuild.
- **Search**: by address, validator or known wallet name (with suggestions as you type), public key, transaction ID
  or block ID.
- Works on phones; dark theme.

## How "near-live" works

New blocks show up about **1–2 seconds after they are forged**, and normal use costs about **12 API requests per
minute**. These numbers come from load-testing `api.ark.io` (November 2026):

| Measured | What the explorer does |
|---|---|
| A new block becomes visible in the API 0.8–1.8 s after its 8 s slot starts | **Slot-aware polling.** Instead of polling on a fixed timer, the explorer waits until 0.7 s into the next slot and checks a few more times until the block arrives. That is ~1.6 requests per block. |
| `/blocks?height.from=<tip+1>` takes ~0.2 s and returns the new blocks themselves | Each poll is a single request: there is no separate "check the tip, then fetch the block" step. |
| "Latest blocks" queries (`/blocks?limit=N`) take ~2.7 s and often fail with 500 | Block lists are always read by height range instead. |
| Rate limit: 200 requests per 60 s per IP. Browsers can't read `Retry-After`. | Every request goes through a budget (170/min by default) with priorities: the page you are looking at comes first, then the live poller, then background work. After a 429 the explorer checks every 10 s until it's allowed again. |
| Heavy queries can take up to ~3.3 s; overloaded ones return 500 after ~3.2 s | Page loads time out after 10 s and retry a 500 twice (after 0.3 s and 1 s) and a network error twice (after 0.5 s and 1.5 s). Live polls time out after 3 s and never retry, since the next poll is under a second away. |
| Newest-first pages more than ~20,000 rows deep usually fail | Deep pages are read oldest-first and reversed, which works at any depth in 1–2.5 s. |
| Several tabs open in one browser | One visible tab polls and shares new blocks with the others, so extra tabs cost nothing. Hidden tabs stop polling. |

The **forging order** is worked out in the browser exactly the way ARK Core 3.13 does it:
1. Take the round's validators, sorted by votes (highest first).
2. Shuffle them, seeded with SHA-256 of the round number.
3. The validator for a slot is `order[slot % 51]`.

This was checked against a full mainnet round, and all 51 slots matched. Countdowns come from the clock, not the API.
If the visitor's clock is off, the explorer corrects it using the arrival times of new blocks.

**Missed blocks** aren't available from the API, so the explorer works them out from gaps between block timestamps
plus the forging order. The first visit scans the last 24 h in the background (about 110 requests over a couple of
minutes). The result is cached, so later visits only check new blocks.

## Install

### Quick install: prebuilt download

Every [release](https://github.com/geopsllc/ark-explorer/releases/latest) includes the finished site as
`ark-explorer.zip` and `ark-explorer.tar.gz` (plus `SHA256SUMS`). The files sit at the archive root, so unpack them
straight into a folder your webserver serves:

```bash
mkdir -p /var/www/explorer
curl -L https://github.com/geopsllc/ark-explorer/releases/latest/download/ark-explorer.tar.gz \
  | tar -xz -C /var/www/explorer
```

No Node.js needed. To update, replace the folder's contents with a newer release. Then see
[Deploy to an existing webserver](#deploy-to-an-existing-webserver) for HTTPS and caching tips. To build it
yourself instead, read on.

### Requirements

- [Node.js](https://nodejs.org) 20 or newer, plus npm. This is only needed to build, not to host.
- Any webserver that can serve static files: nginx, Apache, Caddy, IIS, shared hosting, Cloudflare Pages, GitHub
  Pages, S3 and so on.

### Build

```bash
git clone https://github.com/geopsllc/ark-explorer.git
cd ark-explorer          # default branch: ark-mainnet
npm ci
npm run build
```

The finished site is in `dist/`:

```
dist/
├── index.html
├── favicon.svg
├── _headers         ← cache headers for Cloudflare Pages/Netlify (ignored elsewhere)
└── assets/          ← hashed JS/CSS bundles
```

### Deploy to an existing webserver

Copy the **contents** of `dist/` to any folder your webserver serves. For example:

```bash
rsync -av --delete dist/ user@server:/var/www/explorer/
```

That's all. Links use hash routes (`/#/block/123`) and every path is relative, which means:
- no rewrite rules or SPA fallback are needed
- it works at a domain root (`https://explorer.example.com/`) or in a sub-folder (`https://example.com/explorer/`)

**Linking from a wallet or another app.** Detail pages answer to both the explorer's own names and ArkScan's:

| Page | Works everywhere | Also works with ArkScan-style names |
|---|---|---|
| Transaction | `/#/transaction/<id>` | `/#/transactions/<id>`, `/transactions/<id>` |
| Wallet | `/#/wallet/<address>` | `/#/addresses/<address>`, `/addresses/<address>` |
| Block | `/#/block/<id or height>` | `/#/blocks/<id or height>`, `/blocks/<id or height>` |

So an app that links to ArkScan only needs its base URL changed. The forms without `#` need the server to answer
unknown paths with `index.html` (Cloudflare Pages and Netlify do this by default; in nginx add
`location / { try_files $uri /index.html; }`); `index.html` then redirects to the hash route before anything loads.

Recommended but optional: serve it over **HTTPS**. Also cache `assets/` for a long time, but not `index.html`. Example nginx block:

```nginx
server {
    server_name explorer.example.com;
    root /var/www/explorer;

    location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
    location = /index.html { add_header Cache-Control "no-cache"; }
}
```

Apache: no configuration is needed. To add the same caching, put this `.htaccess` in the folder:

```apache
<FilesMatch "^index\.html$">
  Header set Cache-Control "no-cache"
</FilesMatch>
<If "%{REQUEST_URI} =~ m#/assets/#">
  Header set Cache-Control "public, max-age=31536000, immutable"
</If>
```

### Settings

Each network gets its own branch. This branch, `ark-mainnet` (the default), is built for **ARK mainnet only** and
always talks to the official API, `https://api.ark.io/api`. There is no runtime configuration file. The few settings live in [`src/lib/site.ts`](src/lib/site.ts), and changing them
needs a rebuild:

| Constant | Default | Meaning |
|---|---|---|
| `TITLE` | `ARK Explorer` | Name shown in the header. The browser tab title is in `index.html`. |
| `REQUEST_BUDGET` | `170` | Requests per minute one browser may send. Keep it under the API's limit of 200 per IP. |
| `MISSED_WINDOW_HOURS` | `24` | How far back missed blocks are counted. Each hour costs ~5 extra requests on a visitor's first visit. |

The API's rate limit counts each visitor's IP separately, since requests come from their own browser. Visitors never
share one quota.

Why no backup nodes? ARK nodes serve their public API only over plain HTTP (port 4003), and browsers block HTTP
requests from an HTTPS page. A static site served over HTTPS can therefore only use an HTTPS API, and `api.ark.io` is
the one official HTTPS endpoint.

### Develop

```bash
npm install
npm run dev        # http://localhost:1430 with hot reload
npm run check      # type-check
npm run build      # production build into dist/
npm run preview    # serve dist/ on http://localhost:1431
```

## Tech

[Svelte 5](https://svelte.dev) + TypeScript + [Vite](https://vite.dev). There are no runtime dependencies; the built
site is under 50 KB gzipped.

| File | What it does |
|---|---|
| `src/lib/api.ts` | Request budget, priorities, timeouts, retries, failover and deep paging |
| `src/lib/live.svelte.ts` | Slot-aware poller, leader tab election and live state |
| `src/lib/chain.ts` | Slot and round math and the forging-order shuffle |
| `src/lib/delegates.svelte.ts` | Validator directory, voter counts and the missed-block scan |
| `src/pages/` | Validators (`Delegates.svelte`), Blocks, Block, Transactions, Transaction, Wallets and Wallet pages |

## License

[MIT](LICENSE) © 2026 geopsllc
