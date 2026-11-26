# Mainsail Explorer (testnet)

A fast, lightweight, self-hostable block explorer for the **ARK Mainsail testnet** (ARK's new BFT, EVM-based chain).
It is a static site: build it once, copy the `dist/` folder to any webserver, done. There is no backend, database or
indexer to run; every visitor's browser reads the public Mainsail API (`testnet.mainsailhq.com/api`) directly.

Live instance: **https://mainsail.geops.net**

This is the `mainsail` branch of [ARK Explorer](https://github.com/geopsllc/ark-explorer). The default branch,
`ark-mainnet`, is the same explorer for ARK Core v3 mainnet (https://ark.geops.net). Each network gets its own
branch.

> **Independent community project.** Not affiliated with, endorsed by or supported by ARK.io / ARK SCIC. "ARK" and
> "Mainsail" are used only to describe the blockchain this tool reads. Data comes from the public Mainsail testnet API
> and is shown as-is, without warranty (see the [MIT license](LICENSE)). Testnet tokens (shown as **TARK**) have no
> value.

## Features

- **Validators**: one live table combining a validator list and a validator monitor. Switch between **Rank View** (by
  rank) and **Forging View** (this round's proposal order). For each validator it shows:
  - this round's status: forged (with the block number), proposing now, next, a countdown to its turn, or missed
  - votes and approval %
  - voter count
  - blocks produced
  - missed turns in the last 24 h
  - forging health: forging, missed (its last turn), or dead (2 missed turns in a row at least half a rotation, 27
    turns, apart, or 3+; counted in turns, so a chain stall in between doesn't make a validator look dead)
  - time since its last block

  Active, standby and resigned validators are listed separately, and you can filter them by name.
- **Blocks**: a live list of the latest blocks (with how many proposers missed before each one), paging through the
  whole chain, and a detail page for each block: consensus round, who missed, how many validators signed it, gas,
  fees, reward and its transactions.
- **Transactions**: a live list of the latest transactions and a detail page for each one. Mainsail transactions are
  EVM calls; the explorer decodes the protocol's own ones into readable types: transfers (with a text memo), votes and
  unvotes, multipayments (with every recipient), validator registration / update / resignation, username registration
  / resignation, contract deployments and calls, and ERC-20 token transfers and approvals. It shows status (failed
  calls still pay their fee), gas used, gas price and the raw call data. Transactions still waiting in the pool update
  by themselves once they are confirmed.
- **Wallets**: every wallet, with share of supply and vote. Each wallet page shows balance, vote, public key, username,
  the validator's BLS key, legacy origin (wallets carried over from ARK Core), transaction history (all, sent or
  received), and a voters tab for validators. A wallet page refreshes by itself when a new block touches that wallet.
- **Legacy cold wallets**: an ARK Core address (base58) that had never sent a transaction before the snapshot opens as a
  cold wallet, with its balance and whether it has been claimed (merged into a 0x account) yet.
- **Search**: by 0x address, validator name or username (with suggestions as you type), legacy ARK address, public
  key, transaction hash, block hash or block number.
- Works on phones; dark theme.

## How it reads Mainsail

Mainsail differs from ARK Core in ways an explorer has to follow (all checked against the node's source,
[ArkEcosystem/mainsail](https://github.com/ArkEcosystem/mainsail), and the testnet's own history):

| Mainsail | What the explorer does |
|---|---|
| A round is **53 blocks**. Round 1 starts at the block after genesis (the testnet started from an ARK devnet snapshot, so the genesis height is read from the API once). | Round math in `src/lib/chain.ts`. |
| No time slots: each block number is decided by consensus rounds 0, 1, 2…, and the proposer of consensus round r is `roundValidators[(totalRound + r) % 53]` (`totalRound` grows by the commit round + 1 per block). | A "turn" is one consensus round of one block number. Forging View has one row per turn: 53 rows, plus one for each miss. |
| A block's `round` is the consensus round it was proposed in, so `round` = r means the proposers of rounds 0…r-1 **missed** (the node's own reporter counts misses the same way). | **Missed blocks come straight from block data**: no timestamp-gap guessing. The round's proposal order says who missed. |
| Every miss pushes the rotation on by one turn, so validators from the start of the order get extra turns (a down validator can get several and miss them all) until the round has its 53 blocks. | Same handling as on Core: Forging View grows by a row per miss. |
| Rarely a block is committed in a later consensus round than it was proposed in (re-proposed by the next proposer). Those turns are nobody's miss. | Each block is matched to its proposer's turn; turns it skipped show as "–", not as missed. |
| The API stores each round's validators in proposal order (`/rounds/{n}`), but some stored rounds start at another point of the rotation. | The order is rotated to match the round's real proposers before it is used. |
| Blocks come every 8 s; after a missed proposal the next one takes ~18 s, then ~32 s, ~50 s, ~72 s, ~98 s (consensus timeouts grow each round; medians of 3,000 testnet blocks). | Countdowns and "late" use the same timings. |
| The REST API runs **one block behind**: block N appears there only once N+1 is committed (~8.7 s after N, or ~18 s / ~30 s when N+1 needed extra rounds). The node's JSON-RPC (`/rpc/api`) has N 1-1.4 s after its timestamp (it is load-balanced over nodes that can be a block apart). | The tip watcher polls `eth_getBlockByNumber("latest")` shortly after each block is due, then every 1.5 s. A new RPC block shows at once as a provisional block of the round (its proposer places it, any turns before count as missed) and triggers a REST poll for the full block before it. Without RPC, REST polling takes over on its own schedule. |
| Amounts are in wei (18 decimals); fees are `gasUsed × gasPrice`. | All amounts stay exact (BigInt). Dust below 8 decimals is shown in full. |

`npm run test:rounds` replays the testnet's recent rounds through the round logic and checks every block's turn,
every miss and every skipped turn against what the chain recorded (plus synthetic edge cases).

Requests: normal use costs 2-3 RPC and 1-2 REST requests per block; the first visit scans the last 24 h for missed
turns in the background (about 110 REST requests, 4 at a time: a few seconds, cached afterwards). Every request goes
through a per-host budget with priorities (the page you are looking at first, then the live poller, then background
work). One visible tab polls and shares new blocks with your other tabs; hidden tabs stop polling.

## Install

### Quick install: prebuilt download

Every release of this branch (tags `mainsail-v…`, on the
[releases page](https://github.com/geopsllc/ark-explorer/releases)) includes the finished site as
`ark-explorer-mainsail.zip` and `ark-explorer-mainsail.tar.gz` (plus `SHA256SUMS`). The files sit at the archive root,
so unpack them straight into a folder your webserver serves:

```bash
mkdir -p /var/www/mainsail-explorer
curl -L https://github.com/geopsllc/ark-explorer/releases/download/mainsail-v0.1.0/ark-explorer-mainsail.tar.gz \
  | tar -xz -C /var/www/mainsail-explorer
```

No Node.js needed. To update, replace the folder's contents with a newer release. Then see
[Deploy to an existing webserver](#deploy-to-an-existing-webserver) for HTTPS and caching tips.

### Requirements

- [Node.js](https://nodejs.org) 20 or newer, plus npm. This is only needed to build, not to host.
- Any webserver that can serve static files: nginx, Apache, Caddy, IIS, shared hosting, Cloudflare Pages, GitHub
  Pages, S3 and so on.

### Build

```bash
git clone -b mainsail https://github.com/geopsllc/ark-explorer.git ark-explorer-mainsail
cd ark-explorer-mainsail
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
rsync -av --delete dist/ user@server:/var/www/mainsail-explorer/
```

That's all. Links use hash routes (`/#/block/123`) and every path is relative, which means:
- no rewrite rules or SPA fallback are needed
- it works at a domain root (`https://explorer.example.com/`) or in a sub-folder (`https://example.com/explorer/`)

**Linking from a wallet or another app.** Detail pages answer to both the explorer's own names and the usual
explorer-style ones:

| Page | Works everywhere | Also works |
|---|---|---|
| Transaction | `/#/transaction/<hash>` | `/#/transactions/<hash>`, `/transactions/<hash>` |
| Wallet | `/#/wallet/<address>` | `/#/addresses/<address>`, `/addresses/<address>` |
| Block | `/#/block/<hash or number>` | `/#/blocks/<hash or number>`, `/blocks/<hash or number>` |

The forms without `#` need the server to answer unknown paths with `index.html` (Cloudflare Pages and Netlify do this
by default; in nginx add `location / { try_files $uri /index.html; }`); `index.html` then redirects to the hash route
before anything loads.

Recommended but optional: serve it over **HTTPS**. Also cache `assets/` for a long time, but not `index.html`. Example nginx block:

```nginx
server {
    server_name explorer.example.com;
    root /var/www/mainsail-explorer;

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

This branch is built for the **Mainsail testnet only** and talks to its public API,
`https://testnet.mainsailhq.com/api` (and `/tx/api` for pending transactions). There is no runtime configuration
file. The few settings live in [`src/lib/site.ts`](src/lib/site.ts), and changing them needs a rebuild:

| Constant | Default | Meaning |
|---|---|---|
| `TITLE` | `Mainsail Explorer` | Name shown in the header. The browser tab title is in `index.html`. |
| `SYMBOL` | `TARK` | Currency name shown after amounts. |
| `REQUEST_BUDGET` | `600` | REST requests per minute one browser may send (the testnet REST API enforces no limit). |
| `RPC_BUDGET` | `120` | JSON-RPC requests per minute (the RPC endpoint allows 150 per IP per 60 s). |
| `MISSED_WINDOW_HOURS` | `24` | How far back missed turns are counted. Each hour costs ~5 extra requests on a visitor's first visit. |

Rate limits count each visitor's IP separately, since requests come from their own browser. Visitors never share
one quota.

Measured testnet API limits (November 2026): REST answers every request (it sends `x-ratelimit-limit: 200` but
never counts down; 1,000+ requests a minute went through), with ~180 ms median latency for 100 blocks. JSON-RPC
allows 150 requests per fixed 60 s window per IP, then answers 429 until the window ends. The wallet list ignores `orderBy=balance` (the Wallets page says so when the
order comes back unsorted), and `balance.from` only takes values below ~0.009 TARK, so dust can't be filtered out.

### Develop

```bash
npm install
npm run dev        # http://localhost:1430 with hot reload
npm run check      # type-check
npm run build      # production build into dist/
npm run preview    # serve dist/ on http://localhost:1431
npm run test:rounds   # replay recent testnet rounds through the round logic (needs network)
```

## Tech

[Svelte 5](https://svelte.dev) + TypeScript + [Vite](https://vite.dev). There are no runtime dependencies.

| File | What it does |
|---|---|
| `src/lib/api.ts` | Request budget, priorities, timeouts, retries and deep paging |
| `src/lib/ms.ts` | Mainsail adapter: blocks, transactions (ABI decoding), wallets and validators; EIP-55 checksums |
| `src/lib/live.svelte.ts` | RPC tip watcher, REST block poller, leader tab election, live state and turn timing |
| `src/lib/chain.ts` | Round math, genesis height and the rounds' proposal orders |
| `src/lib/roundview.ts` | Who proposes which turn of the round, extra turns, misses, skipped turns and forging health (pure functions) |
| `src/lib/delegates.svelte.ts` | Validator directory and the missed-turn scan |
| `src/pages/` | Validators (`Delegates.svelte`), Blocks, Block, Transactions, Transaction, Wallets and Wallet pages |

## License

[MIT](LICENSE) © 2026 geopsllc
