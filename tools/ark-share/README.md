# ark-share

Works out how much of their forged rewards ARK Core v3 mainnet delegates really share with voters,
from on-chain payouts only (api.ark.io). This is the logic stage; a web page comes next.

```bash
python3 analyzer.py                       # all 51 active delegates (~760 requests, ~4.5 min)
python3 analyzer.py --only hash,geops     # selected delegates
python3 analyzer.py --json results.json   # full results
```

The full method is described in the `analyzer.py` docstring. In short:

| Step | What it does | Edge cases it handles |
|---|---|---|
| Payout runs | Groups multipayments sent close together. If payouts are ≥ 6 h apart, pieces up to a quarter of the pool's interval apart are merged (~6 h for daily pools) | Pools that batch 64-recipient multipayments hours apart (hash) |
| Multipayments first | Public pools pay voters with multipayments. Single transfers count as operator income | A wallet that pays voters with single transfers only is **private** (arkpool, quarkpool) |
| Forged | Block count per payout interval (`meta.totalCount`) × reward, plus fees of fee-carrying blocks | Missed blocks; fees (~0.1%) |
| Per-voter ratio | paid ÷ (forged × voter weight ÷ total votes), measured between the voter's own payouts | Pools that pay a voter only once a minimum payout is reached |
| Votes over time | Pools pay by true block weight, so each interval uses the block-weighted average of 1 ÷ votes over the time it was forged (shifted by the payout delay), rebuilt from vote transactions | Voters joining or leaving mid-window (a 411k joiner at cams, a 7k move from hash to goose) |
| Cycle | Own blocks between payouts tell a block-count pool (same count each time, kaos 211) from a timer pool (208–214) and a fixed-period pool (hash: pays 211-block chunks from a backlog at drifting times). Fixed-period pools are measured per 211 blocks, not per gap between payouts | hash read 76% instead of 75% |
| Own votes | A voter whose whole cut goes to the operator with the operator cut is the operator's own wallet. Measured again without those votes; kept only if that lands on a multiple of 5% and the first reading doesn't | geops leaves its own 5% out of the split (52.3% → 50%); brohan and goose count theirs |
| Share | The densest ratio band, scored by share of voters + share of vote weight; the band's total paid ÷ total due | One whale on a special deal can't override 100 voters (samuray) |
| Maximum weight | Top voters with equal payouts despite different balances | umbrella, dev51 (~100k ARK cap) |
| Minimum weight | Every unpaid voter is smaller than every paid one; reported as the roundest number between them. Caps snap to a round number within 10% | geops: unpaid below 8.2, paid from 18.3 → 10 ARK minimum |
| Fees | Shares are measured on rewards + fees; when fees reach 0.25% of forged, also on rewards only, kept if clearly rounder | Scripts that keep the fees (fees are ~0.04% of forged today) |
| Redirects | A recipient whose amount matches a voter's shortfall (alone, or plus the operator cut) | Voters paid to another address (geops, brohan, goose) |
| Operator | Large non-voters paid every run; the part of a voter's payout above the share | One or two operator addresses inside the multipayment (del, kaos) |
| Payout wallet | Follows the main forwarding address, or a sender paying the top voters | Delegates paying from a separate wallet |
| Delay | New voters (≥ 3 days, still voting): first payout ÷ accrual rate from later payouts | hash pays ~35 h behind forging; first payout ~52 h after voting |
| Page | Lists sharing, irregular and gone-dark delegates with a share of 50% or more that pay at least daily; never private ones | A clean table of real public pools |
| Status | sharing / private (fewer than 20 voters, transfers only, or pays more often than every 6 h) / stopped / irregular / not sharing | biz_classic: last payout 69 days ago |

**Share** is what a paid voter receives as a percentage of their proportional cut of everything
forged, rounded down to a whole percent after allowing 0.3% of measurement noise
(`SHARE_TOLERANCE`). **Effective** is everything paid to voters ÷ everything forged. It is lower
when vote weight goes unpaid (caps, minimums, self-votes).

## API use

`ark_api.py` follows the limits measured for ark-wallet / ark-explorer:
- 200 requests per fixed 60 s window per IP; it budgets 180 of them.
- A 429 pauses for `Retry-After` (or 10 s).
- 10 s timeout. A 500 is retried after 0.3 s and 1 s; a network error after 0.5 s and 1.5 s.
- Timestamp filters use ARK-epoch seconds (unix − 1490101200).

## Limits

- A redirect can't be told apart from the operator's own voting wallet getting a token rate.
  Both are labelled "partial" when the voter also gets an amount at their own address.
- Shares are measured over the last 7 days (≥ 3 runs, ≤ 21). A rate change inside the window shows
  as low confidence until it ages out.
- Payout delay needs a voter who voted ≥ 3 days ago and still votes. Votes are rare (~1/day
  network-wide), so some delegates have no sample.
