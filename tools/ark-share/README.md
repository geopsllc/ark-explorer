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
| Payout runs | Groups multipayments sent close together. If payouts are ≥ 6 h apart, pieces up to 2 h apart are merged | Pools that batch 64-recipient multipayments over ~1 h (hash) |
| Multipayments first | Public pools pay voters with multipayments. Single transfers count as operator income | A wallet that pays voters with single transfers only is **private** (arkpool, quarkpool) |
| Forged | Block count per payout interval (`meta.totalCount`) × reward, plus fees of fee-carrying blocks | Missed blocks; fees (~0.1%) |
| Per-voter ratio | paid ÷ (forged × voter weight ÷ total votes), measured between the voter's own payouts | Pools that pay a voter only once a minimum payout is reached |
| Share | The densest ratio band, scored by share of voters + share of vote weight; the band's total paid ÷ total due | One whale on a special deal can't override 100 voters (samuray) |
| Maximum weight | Top voters with equal payouts despite different balances | umbrella, dev51 (~100k ARK cap) |
| Minimum weight | Every unpaid voter is smaller than every paid one | Reported as a minimum, not as unpaid voters |
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
