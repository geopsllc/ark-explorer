#!/usr/bin/env python3
"""Estimate how much of their forged rewards ARK Core v3 delegates really share with voters.

Method (per delegate)
---------------------
1. Payout runs. Read the delegate's outgoing transfers and multipayments. Public pools pay voters
   with multipayments and use single transfers only for the operator's own earnings, so when the
   wallet sends multipayments, runs are built from those and every single transfer counts as
   operator income. A wallet that pays voters only with single transfers is marked private.
   Multipayments are grouped into "runs": transactions less than RUN_GAP apart belong to one payout. A pool with 2,000 voters
   sends about 30 multipayments in a minute or two. Some pools space their batches 20-60 min
   apart, so when payouts are at least 6 h apart, pieces less than 2 h apart are merged.
2. Window. Take the runs from the last WINDOW_DAYS, at least MIN_RUNS and at most MAX_RUNS of them,
   looking back at most LOOKBACK_DAYS. The run just before the window is the boundary. Daily
   payouts usually pay for blocks forged before the payout; that lag is the same each run, so
   the intervals still have the right length.
3. Forged. Count the delegate's blocks per interval (one request each, `meta.totalCount`) times
   the block reward, plus the fees of the blocks that carried any (`totalFee.from=1`).
4. Per-voter ratio, measured between the voter's own payouts:
       ratio = paid after their first payout / (forged between first and last payout * b / V)
   A voter holding b of the delegate's V votes would get F*b/V at a 100% share. In an honest
   proportional (TBW) pool every paid voter lands on the same ratio, and that ratio is the share.
   Measuring between a voter's own payouts also works for pools that only pay a voter once their
   pending balance crosses a threshold.
5. Whale cap. Some pools pay their largest voters the same capped amount. Two or more top voters
   with different balances but identical payouts are reported as a cap and left out of step 6.
6. Estimate. The densest +-0.75% bin of ratios, scored by its share of voters plus its share of
   vote weight (so one whale on a special deal can't outvote 100 voters), refined to the weighted
   aggregate (total paid / total due) of the voters inside +-2% of it, rounded down to a whole
   percent after allowing SHARE_TOLERANCE (0.3%) of measurement noise. Confidence is the share of vote
   weight that is explained (in the band, capped, or redirected), averaged with the same share
   counted in voters, so the result reflects the bulk of voters, not one whale.
   Minimum weight: when every unpaid voter is smaller than every paid one, it is reported as a
   minimum, not as unpaid voters. Maximum weight: see 5; a lone largest voter at a lower rate
   is reported as a possible cap.
7. Redirects. A voter can ask for their payout to go to another address. Those voters look unpaid
   (or underpaid), and the other address looks like an operator. A recipient whose amount matches a
   voter's shortfall at the estimated share (one voter, or two together) is credited to the voter.
   When an operator address also collects a redirect, the amount is the shortfall plus the usual
   operator cut (1 - share of everything forged). That combined case is matched too, at most once.
   Matches are tried for one voter, two voters, and all short-paid voters together. A voter that
   still gets a token rate at their own address is a "partial" redirect: it can't be told apart
   from the operator's own voting wallet getting a token rate, so it is labelled.
8. Breakdown. Voters (including redirects) / operator (a large non-voter paid in most runs, or the
   part of a voter's payout far above the band) / other (former voters, small non-voters) / kept.
9. Payout wallet. If the delegate wallet pays no voters, the payouts may come from another wallet.
   Candidates: (a) the address the delegate forwards most of its income to, (b) a sender that
   paid several of the delegate's top voters in the last week. A candidate is used only if it
   passes the same test on the delegate's voters.

10. Payout delay. Many pools pay for blocks forged a day or more before the payout. A fixed delay
   doesn't change the share (every interval keeps its length), but voters care about it, and it
   explains voters who haven't been paid yet. Measured from voters who voted for the delegate
   >= 3 days ago and still do (one network-wide scan of recent vote transactions covers all
   delegates): their later payouts give their accrual rate, the first payout / that rate gives the
   hours of forging it covered, so delay = first payout - (vote time + covered hours). With only
   one payout so far, the accrual rate comes from share * vote weight instead. When a delay is
   found, the forging intervals are shifted by it and the delegate is analysed again.

11. Votes during the window. Payouts were paid on the votes as they stood during the window, not
   on today's. Pools pay by true block weight: each block pays b / (votes at that block), and a
   voter is paid only for the blocks forged while it was voting (cams paid a 411k voter who joined
   a third into a day a third of that day). So every interval (shifted by the payout delay) is
   measured against the block-weighted average of 1 / votes over it, rebuilt from the vote scan. Without this, a 7k ARK switch
   from one 1M delegate to another moves both shares by ~0.7%, and a 411k joiner moves cams by 3%.

12. Operator-owned votes. When a recipient's amount is a voter's whole cut plus the operator cut
   (the combined case in 7), that voter is the operator's own wallet: its payout goes to the
   operator with the operator's income. Pools leave those votes out of the voters' split, so every
   other voter gets share / (1 - own votes). Other pools count those votes in the split and send
   their cut to the operator (brohan, goose); the amounts fit both readings, so the share is
   measured again without those votes and that reading is kept only when it lands on a multiple
   of 5% and the first one clearly doesn't (geops: 52.3% with them, 49.7% without; the real
   share is 50%). Their payout then counts as operator, and what the own wallets still get at
   their own address is added back to the share: it comes out of the voters' pool (geops 49.7 + 0.36).

13. Fixed periods. Some pools pay a fixed period per payout (24 h of rewards) at times that drift
   (hash: 08:56, 08:38, 07:40 ... 02:56). Measured between payout times, such a pool reads too
   high or too low by the drift (hash: 7 days paid in 164 h read 76% instead of 75%). A period is
   the delegate's own blocks, not hours: "daily" is 211 blocks (one per 51-slot round of 8 s, 23.9 h).
   The own-block count of every interval tells the cycles apart: a block-count pool (kaos) has the
   same count between payouts (211); a timer pool varies (208-214) with an even ARK per hour; a
   fixed-period pool varies more (hash: 191-209, it pays 211-block chunks from a backlog) with an
   even ARK per payout. Both readings are tried on the ordinary payouts and the one that makes them
   most even is used; when the gaps vary by less than 1.5 h they can't be told apart and the time
   since the last payout is used.

14. Fees. Some scripts share rewards + fees, others keep the fees and share block rewards only.
   Fees are ~0.04% of forged on mainnet today, too little to matter; once they reach 0.25%, the
   share is also measured on rewards only and that reading is kept when it is clearly rounder.

Two numbers come out:
- share: what a voter actually receives as a % of their proportional cut of everything forged.
  This is the number a voter cares about.
- effective: everything paid to voters / everything forged. Lower than `share` when vote weight
  isn't paid (operator self-vote, minimums, blacklists, caps, new voters).
"""
from __future__ import annotations

import argparse
import itertools
import math
import json
import statistics
import sys
import time
from collections import defaultdict

from ark_api import Client, ApiError

EPOCH = 1490101200          # ARK mainnet epoch 2017-03-21T13:00:00Z; API timestamp filters use it
SATOSHI = 100_000_000
RUN_GAP = 20 * 60           # txs closer than this belong to the same payout run
MERGE_GAP = 2 * 3600        # ...or closer than this, when runs are >= MERGE_IF apart
MERGE_IF = 6 * 3600
WINDOW_DAYS = 7
MIN_RUNS = 3
MAX_RUNS = 21               # window cap: every interval gets its own block count
LOOKBACK_DAYS = 30
MIN_VOTER_BALANCE = SATOSHI  # voters below 1 ARK are ignored (ArkScan counts the same way)
PRIVATE_MAX_VOTERS = 19     # <= this many voters (>= 1 ARK): a private pool (a closed group, or the
                            # operator's own wallets), not a public one. Public pools have 20+.
FREQUENT_H = 6              # public pools pay daily or a few times a day; more often is unusual
IN_PROGRESS = 5 * 60        # a run whose last tx is younger than this may still be sending
SHARE_TOLERANCE = 0.3       # % of noise allowed before rounding the share down to a whole percent
BAND = 0.02                 # +- around the estimate that counts as "on the share"
MATCH_TOL = 0.015           # redirect amount must match the shortfall within 1.5%
CUT_TOL = 0.005             # combined redirect+operator: remainder within 0.5% of forged
VOTE_LOOKBACK_DAYS = 180    # new voters to measure payout delay from (votes are ~1/day network-wide)
DELAY_MIN_DAYS = 3          # a voter needs this long for a first (partial) and a full payout
DELAY_SAMPLES = 3


# --------------------------------------------------------------------------------------------
# Fetching
# --------------------------------------------------------------------------------------------

def norm_tx(t):
    """Transfer or multipayment -> {ts, id, sender, vendor, payments:[(addr, amount)]}; else None."""
    if t.get("typeGroup") != 1:
        return None
    if t["type"] == 0:
        pays = [(t["recipient"], int(t["amount"]))]
    elif t["type"] == 6:
        pays = [(p["recipientId"], int(p["amount"])) for p in t["asset"]["payments"]]
    else:
        return None
    return {"ts": t["timestamp"]["unix"], "id": t["id"], "sender": t["sender"], "multi": t["type"] == 6,
            "vendor": t.get("vendorField") or "", "payments": pays}


def fetch_sent(c: Client, address, now, window_days=WINDOW_DAYS, lookback_days=LOOKBACK_DAYS):
    """Outgoing payouts, newest first, until we have the window plus one run before it.
    -> (txs, newest payout ts even if older than the lookback, or None)"""
    window_start = now - window_days * 86400
    oldest_allowed = now - lookback_days * 86400
    out, newest = [], None
    for t in c.pages(f"/wallets/{address}/transactions/sent?orderBy=timestamp:desc", max_pages=40):
        ts = t["timestamp"]["unix"]
        n = norm_tx(t)
        if n and newest is None:
            newest = ts
        if ts < oldest_allowed:
            break
        if n:
            out.append(n)
        if ts < window_start - MERGE_GAP and len(out) % 25 == 0:
            runs = group_runs(out)
            if len(runs) > MIN_RUNS and runs[0]["ts"] < window_start:
                break
    return out, newest


def fetch_voters(c: Client, address):
    voters = {}
    for v in c.pages(f"/delegates/{address}/voters?orderBy=balance:desc&balance.from={MIN_VOTER_BALANCE}",
                     max_pages=60):
        voters[v["address"]] = int(v["balance"])
    return voters


def fetch_recent_votes(c: Client, now, days=VOTE_LOOKBACK_DAYS):
    """Network-wide vote transactions, newest first -> {voter: (ts, [votes])} (latest vote only)."""
    latest = {}
    for t in c.pages("/transactions?type=3&typeGroup=1&orderBy=timestamp:desc", max_pages=10):
        ts = t["timestamp"]["unix"]
        if ts < now - days * 86400:
            break
        latest.setdefault(t["sender"], (ts, t["asset"]["votes"]))
    return latest


def fetch_first_payouts(c: Client, voter, payer, since, n=10):
    """[(ts, amount)] the payer sent to the voter after `since`, oldest first."""
    d = c.get(f"/wallets/{voter}/transactions/received?orderBy=timestamp:asc"
              f"&timestamp.from={since - EPOCH}&limit=50")
    out = []
    for t in d["data"]:
        n_ = norm_tx(t)
        if n_ and t["sender"] == payer:
            out.append((t["timestamp"]["unix"], sum(a for r, a in n_["payments"] if r == voter)))
    return out[:n]


def count_blocks(c: Client, pk, t_from, t_to):
    """Blocks forged in (t_from, t_to] (unix seconds)."""
    d = c.get(f"/blocks?generatorPublicKey={pk}&timestamp.from={t_from - EPOCH + 1}"
              f"&timestamp.to={t_to - EPOCH}&limit=1")
    return d["meta"]["totalCount"]


def fee_blocks(c: Client, pk, t_from, t_to):
    """[(unix ts, fee)] of blocks in (t_from, t_to] that carried fees."""
    return [(b["timestamp"]["unix"], int(b["forged"]["fee"]))
            for b in c.pages(f"/blocks?generatorPublicKey={pk}&timestamp.from={t_from - EPOCH + 1}"
                             f"&timestamp.to={t_to - EPOCH}&totalFee.from=1", max_pages=20)]


def fetch_forged(c: Client, pk, reward, boundaries):
    """boundaries = [t0, t1, ..., tn] -> forged per interval (ti-1, ti] and in total."""
    fees = fee_blocks(c, pk, boundaries[0], boundaries[-1])
    per_run = []
    for a, b in zip(boundaries, boundaries[1:]):
        n = count_blocks(c, pk, a, b)
        f = sum(fee for ts, fee in fees if a < ts <= b)
        per_run.append({"from": a, "to": b, "blocks": n, "forged": n * reward + f})
    fee_total = sum(f for _, f in fees)
    blocks = sum(p["blocks"] for p in per_run)
    return {"blocks": blocks, "rewards": blocks * reward, "fees": fee_total,
            "forged": blocks * reward + fee_total, "per_run": per_run}


# --------------------------------------------------------------------------------------------
# Pure analysis (no I/O): ports 1:1 to the web page
# --------------------------------------------------------------------------------------------

def _group(txs, gap):
    runs = []
    for t in txs:
        if runs and t["ts"] - runs[-1]["last"] < gap:
            runs[-1]["txs"].append(t)
            runs[-1]["last"] = t["ts"]
        else:
            runs.append({"ts": t["ts"], "last": t["ts"], "txs": [t]})
    return runs


def group_runs(txs):
    txs = sorted(txs, key=lambda t: t["ts"])
    runs = _group(txs, RUN_GAP)
    if len(runs) >= 3:
        gaps = [b["ts"] - a["ts"] for a, b in zip(runs, runs[1:])]
        if statistics.median(gaps) >= MERGE_IF:
            runs = _group(txs, MERGE_GAP)
            # Batches of one payout can be hours apart (hash: 2-4 h on some days). Merge pieces
            # within a quarter of the pool's own interval: ~6 h for daily pools, 2 h at 6-hourly.
            if len(runs) >= 3:
                gaps = [b["ts"] - a["ts"] for a, b in zip(runs, runs[1:])]
                wide = statistics.median(gaps) / 4
                if wide > MERGE_GAP:
                    runs = _group(txs, wide)
    for r in runs:
        pays = defaultdict(int)
        for t in r["txs"]:
            for a, amt in t["payments"]:
                pays[a] += amt
        r["pays"] = dict(pays)
    return runs


def pick_window(runs, now, window_days=WINDOW_DAYS, min_runs=MIN_RUNS):
    """-> (boundary run, [runs in window]) or None. Drops a run that may still be sending."""
    runs = [r for r in runs if now - r["last"] >= IN_PROGRESS]
    if len(runs) < 2:
        return None
    start = now - window_days * 86400
    idx = next((i for i, r in enumerate(runs) if r["ts"] >= start), len(runs))
    idx = min(idx, max(1, len(runs) - min_runs))      # at least min_runs if history allows
    idx = max(idx, 1, len(runs) - MAX_RUNS)           # a boundary run before the window; cap
    return runs[idx - 1], runs[idx:]


def weighted_median(pairs):
    pairs = sorted(pairs)
    total = sum(w for _, w in pairs)
    acc = 0
    for v, w in pairs:
        acc += w
        if acc >= total / 2:
            return v
    return pairs[-1][0] if pairs else None


def weighted_quantile(pairs, q):
    pairs = sorted(pairs)
    total = sum(w for _, w in pairs)
    acc = 0
    for v, w in pairs:
        acc += w
        if acc >= q * total:
            return v
    return pairs[-1][0] if pairs else None


def ratio_mode(pairs, half=0.0075):
    """Densest ratio bin [v, v + 2*half], scored by share of voters + share of vote weight."""
    vals = sorted(pairs)
    n, total = len(vals), sum(w for _, w in vals) or 1
    best, best_s = None, -1
    for v, _ in vals:
        inside = [wt for x, wt in vals if v <= x <= v + 2 * half]
        score = len(inside) / n + sum(inside) / total
        if score > best_s:
            best_s, best = score, v + half
    return best


def round_share(pct):
    """Whole percent, rounded down, allowing for SHARE_TOLERANCE of measurement noise
    (84.86 -> 85, 75.33 -> 75, 98.54 -> 98, 49.70 -> 50)."""
    return int(math.floor(round(pct + SHARE_TOLERANCE, 6)))


def off_round(est):
    """Distance in % from the nearest multiple of 5% (share settings almost always are one)."""
    p = 100 * est
    return abs(p - 5 * round(p / 5))


def _nice(levels):
    """round numbers, roundest first within each power of ten: 10, 50, 20, 25, then 1-9 x 10^k"""
    for m in levels:
        for k in range(-1, 8):
            yield m * 10 ** k


def roundest_between(lo, hi):
    """The roundest number in (lo, hi]: operators set minimums at round numbers (geops: 10 ARK,
    seen as 'unpaid below 8.2, paid from 18.3'). None if there is none."""
    for levels in ((1,), (5,), (2, 2.5), (3, 4, 6, 7, 8, 9), (1.5,)):
        found = [x for x in _nice(levels) if lo < x <= hi]
        if found:
            return max(found) if levels == (1,) else min(found)
    return None


def round_cap(x):
    """A measured cap snapped to the nearest round number within 10% (caps are set as 60k, 100k ...)."""
    if not x:
        return x
    best = min(_nice((1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9)), key=lambda n: abs(n - x))
    return best if abs(best - x) <= 0.1 * x else x


def nominal_interval(h):
    for n in (24, 12, 8, 6):
        if abs(h - n) <= n * 0.17:
            return n
    return None


def period_model(addr, boundary_run, runs_window, per_run):
    """Forged per payout if the pool pays a whole number of nominal periods per payout at
    drifting times (method 13). -> (per-run forged, period h), or None when the time since the
    last payout fits the pool's payouts better."""
    ts = [boundary_run["ts"]] + [r["ts"] for r in runs_window]
    nom = nominal_interval(statistics.median((b - a) / 3600 for a, b in zip(ts, ts[1:])))
    if not nom:
        return None
    k = [round((t - ts[0]) / (nom * 3600)) for t in ts]
    if k[-1] < MIN_RUNS or any(b < a for a, b in zip(k, k[1:])):
        return None
    # a period is a whole number of the delegate's own blocks: 211 for "daily" (one block per
    # 51-slot round of 8 s is 211.8 a day; pools pay 211, 23.9 h, not 24 h)
    blocks = sum(p.get("blocks", 0) for p in per_run)
    if not blocks:
        return None
    per_period = sum(p["forged"] for p in per_run) / blocks * int(nom * 3600 / (8 * 51))
    alt = [per_period * (b - a) for a, b in zip(k, k[1:])]
    # ordinary payouts only (one period after the previous one): if the pool pays the time since
    # the last payout, payout / hours is even; if it pays a fixed period, the payout itself is
    out, hrs = [], []
    for j, r in enumerate(runs_window):
        h = (ts[j + 1] - ts[j]) / 3600
        if k[j + 1] - k[j] == 1 and 0.75 * nom <= h <= 1.25 * nom:
            out.append(sum(amt for x, amt in r["pays"].items() if x != addr))
            hrs.append(h)
    if len(out) < 4 or max(hrs) - min(hrs) < 1.5:     # too even to tell the two apart
        return None

    def cv(xs):
        m = statistics.mean(xs)
        return statistics.pstdev(xs) / m if m else None

    a, b = cv([o / h for o, h in zip(out, hrs)]), cv(out)
    if a is None or b is None or b >= 0.5 * a:
        return None
    return alt, nom


def voter_ratios(voters, V, addr, boundary_run, runs_window, per_run, v_runs=None, minus=0):
    """-> {address: (ratio, due at 100%)} measured between each voter's own payouts (method 4).
    v_runs: votes at each payout ([boundary] + window), so interval j is owed on v_runs[j + 1]
    (method 11). minus: operator-owned votes left out of the split (method 12)."""
    cum = [0]
    for p in per_run:
        cum.append(cum[-1] + p["forged"])
    hist = defaultdict(list)
    for i, r in enumerate([boundary_run] + runs_window):
        for a, amt in r["pays"].items():
            if a in voters and a != addr:
                hist[a].append((i, amt))
    out = {}
    for a, h in hist.items():
        first, last = h[0][0], h[-1][0]
        if last > first and voters[a] > 0:
            got = sum(amt for i, amt in h if i > first)
            if v_runs:
                due = voters[a] * sum(per_run[j]["forged"] / (v_runs[j + 1] - minus)
                                      for j in range(first, last))
            else:
                due = (cum[last] - cum[first]) * voters[a] / (V - minus)
            out[a] = (got / due, due)
    return out


def detect_cap(paid, voters, addr):
    """Top voters (by balance) paid identical amounts despite different balances -> cap.
    -> (cap amount over the window, [addresses]) or None"""
    top = sorted((a for a in paid if a in voters and a != addr), key=lambda a: -voters[a])
    if len(top) < 2:
        return None
    cap = paid[top[0]]
    group = [a for a in itertools.takewhile(lambda a: abs(paid[a] - cap) <= 0.002 * cap, top)]
    if len(group) >= 2 and voters[group[0]] > 1.03 * voters[group[-1]]:
        return cap, group
    return None


def match_redirects(est, F, V, voters, paid, seen, n_runs, addr, skip):
    """Recipients that carry a voter's payout (method 7).
    -> [{to, voters:[...], amount, operator_part}]"""
    floor = 0.003 * F
    deficits = {}
    for a, b in voters.items():
        if a == addr or a in skip:
            continue
        due = est * F * b / V
        d = due - paid.get(a, 0)
        if d >= floor and paid.get(a, 0) < 0.9 * due:
            deficits[a] = d
    if not deficits:
        return []
    # candidates: regular non-voter recipients, and the excess of voters paid far above the band
    cands = []
    for x, p in paid.items():
        if x == addr or seen[x] < max(1, 0.5 * n_runs):
            continue
        if x not in voters:
            cands.append((x, p))
        elif x not in skip:
            excess = p - est * F * voters[x] / V
            if excess >= floor and p > (est * 1.5 + 0.05) * F * voters[x] / V:
                cands.append((x, excess))
    cands.sort(key=lambda c: -c[1])
    found, used, combined_done = [], set(), False

    def subsets(free):
        """one voter, two voters, then all of them"""
        for v, d in free:
            yield [v], d
        for (v1, d1), (v2, d2) in itertools.combinations(free[:15], 2):
            yield [v1, v2], d1 + d2
        if len(free) > 2:
            yield [v for v, _ in free], sum(d for _, d in free)

    for x, m in cands:
        free = sorted(((v, d) for v, d in deficits.items() if v not in used), key=lambda vd: -vd[1])
        hit, op_part = next((vs for vs, d in subsets(free) if abs(m - d) <= MATCH_TOL * d), None), 0
        if not hit and not combined_done:
            for vs, d in subsets(free):
                r = m - d
                if r > 0 and abs(r / F - (1 - est)) <= CUT_TOL:
                    hit, op_part, combined_done = vs, r, True
                    break
        if hit:
            used.update(hit)
            found.append({"to": x, "voters": hit, "amount": m - op_part, "operator_part": op_part,
                          "partial": [v for v in hit if paid.get(v, 0) > 0]})
    return found


def window_votes(V, voters, votes, pk, t0, t1, left_balances):
    """Time-averaged votes over the forging window (t0, t1] (method 11).
    votes: {voter: (ts, [votes])} latest vote tx per wallet; left_balances: {voter: balance} of
    wallets whose latest vote removed this delegate. -> (votes, [changes])"""
    span = max(1, t1 - t0)
    out, changes = V, []
    for v, (ts, vs) in votes.items():
        if ts <= t0:
            continue
        before = (min(ts, t1) - t0) / span           # share of the window before the vote tx
        if "+" + pk in vs and v in voters:            # joined: not voting before ts
            out -= voters[v] * before
            changes.append({"voter": v, "joined": ts, "ark": voters[v] / SATOSHI})
        elif "-" + pk in vs and v in left_balances:   # left: was voting until ts
            out += left_balances[v] * before
            changes.append({"voter": v, "left": ts, "ark": left_balances[v] / SATOSHI})
    return int(out), changes


def estimate_delay(samples, est, rate_per_s, V, voters):
    """samples: [(vote ts, voter, [(payout ts, amount)])] -> per-sample delay (method 10)."""
    out = []
    for t_vote, v, pays in samples:
        if not pays:
            out.append({"voter": v, "voted": t_vote, "paid": False})
            continue
        t1, a1 = pays[0]
        if len(pays) >= 2 and pays[-1][0] > t1:
            accrual = sum(a for _, a in pays[1:]) / (pays[-1][0] - t1)
            how = "payouts"
        elif est:
            accrual = est * rate_per_s * voters[v] / V
            how = "share"
        else:
            continue
        covered = a1 / accrual if accrual else 0
        out.append({"voter": v, "voted": t_vote, "paid": True, "method": how,
                    "first_payout_h": round((t1 - t_vote) / 3600, 1),
                    "delay_h": round((t1 - t_vote - covered) / 3600, 1)})
    return out


def analyze(delegate, voters, runs_window, boundary_run, forged, now, payer=None,
            side=None, transfers_only=False, v_window=None, joined=None, v_runs=None):
    """side: {address: amount} single transfers sent during the window by a multipayment payer
    (operator income). transfers_only: the payer pays everyone with single transfers."""
    side = side or {}
    joined = joined or set()          # voters who joined during/after the window: not owed for all of it
    addr = delegate["address"]
    V = v_window or int(delegate["votes"])      # votes during the window (method 11)
    F_actual = forged["forged"]
    fixed_period = period_model(addr, boundary_run, runs_window, forged["per_run"])
    if fixed_period:      # method 13: measure against whole periods, not the drifting payout times
        forged = dict(forged, forged=sum(fixed_period[0]),
                      per_run=[dict(p, forged=f) for p, f in zip(forged["per_run"], fixed_period[0])])
    F = forged["forged"]
    n_runs = len(runs_window)
    times = [boundary_run["ts"]] + [r["ts"] for r in runs_window]
    gaps_h = [(b - a) / 3600 for a, b in zip(times, times[1:])]
    med_gap = statistics.median(gaps_h)
    res = {
        "username": delegate["username"], "address": addr, "rank": delegate["rank"],
        "votes": int(delegate["votes"]) / SATOSHI, "votes_window": V / SATOSHI,
        "voters": len(voters), "payer": payer or addr,
        "window": {"from": times[0], "to": times[-1], "runs": n_runs,
                   "hours": round((times[-1] - times[0]) / 3600, 1)},
        "schedule": {
            "median_interval_h": round(med_gap, 2),
            "irregularity": round(statistics.pstdev(gaps_h) / med_gap, 2) if len(gaps_h) > 1 else None,
            "payouts_per_day": round(24 / med_gap, 1),
            "txs_per_run": round(sum(len(r["txs"]) for r in runs_window) / n_runs, 1),
            "last_payout_h_ago": round((now - runs_window[-1]["last"]) / 3600, 1),
        },
        "forged": {"blocks": forged["blocks"], "ark": F_actual / SATOSHI,
                   "fees_pct": round(100 * forged["fees"] / F_actual, 2) if F_actual else 0},
        "fixed_period_h": fixed_period[1] if fixed_period else None,
        "flags": [],
    }
    if F <= 0:
        res["status"] = "no blocks"
        return res

    paid, seen = defaultdict(int), defaultdict(int)
    for r in runs_window:
        for a, amt in r["pays"].items():
            paid[a] += amt
            seen[a] += 1
    total_out = sum(p for a, p in paid.items() if a != addr)
    due100 = {a: F * b / V for a, b in voters.items()}      # a voter's cut at 100%

    basis = forged["per_run"]

    def measure(minus=0):
        ratios = voter_ratios(voters, V, addr, boundary_run, runs_window, basis, v_runs, minus)
        cap = detect_cap(paid, voters, addr)
        capped = set(cap[1]) if cap else set()
        pool = [(r, voters[a], due) for a, (r, due) in ratios.items() if a not in capped]
        est = None
        if pool:
            mode = ratio_mode([(r, w) for r, w, _ in pool])
            band = [(r, due) for r, _, due in pool if abs(r - mode) <= BAND]
            # aggregate over the band: total paid / total due. Voters' deposits and withdrawals
            # during the window push single ratios up or down; the aggregate averages that out.
            est = sum(r * due for r, due in band) / sum(due for _, due in band)
        return ratios, cap, capped, est

    ratios, cap, capped, est = measure()
    # some scripts share rewards + fees, others keep the fees: with fees a real part of forged
    # (>= 0.25%), measure on rewards only too and keep it if it is clearly rounder (method 14)
    fee_basis = False
    if est is not None and forged.get("fees", 0) >= 0.0025 * F:
        keep = forged["rewards"] / (forged["rewards"] + forged["fees"])
        basis = [dict(p, forged=p["forged"] * keep) for p in forged["per_run"]]
        again = measure()
        if again[3] is not None and off_round(again[3]) + 0.2 < off_round(est):
            ratios, cap, capped, est = again
            fee_basis = True
        else:
            basis = forged["per_run"]
    redirects = match_redirects(est, F, V, voters, paid, seen, n_runs, addr, capped | joined) \
        if est is not None and not transfers_only else []
    # a voter's whole cut arriving with the operator cut: the operator's own votes, left out of
    # the voters' split (method 12). Measure the share again without them.
    own = [rd for rd in redirects if rd["operator_part"] > 0]
    own_voters = [v for rd in own for v in rd["voters"]]
    own_votes = sum(voters[v] for v in own_voters)
    if own_votes:
        again = measure(own_votes)
        if again[3] is not None:
            # whatever the own wallets still get at their own address comes out of the same pool
            again = again[:3] + (again[3] + sum(paid.get(v, 0) for v in own_voters) / F,)
        if again[3] is not None and off_round(again[3]) <= 0.5 and off_round(est) >= 1.0:
            ratios, cap, capped, est = again
            redirects = [rd for rd in redirects if rd["operator_part"] <= 0]
        else:                        # the pool counts those votes: a redirect + operator cut
            own, own_voters, own_votes = [], [], 0
    hi = est * 1.5 + 0.05 if est is not None else None
    redirected_to = defaultdict(int)          # recipient -> amount credited to voters
    redirect_voters = {}
    for rd in redirects:
        redirected_to[rd["to"]] += rd["amount"]
        for v in rd["voters"]:
            redirect_voters[v] = rd["to"]

    # split every recipient's amount into voter / operator / other
    to_voters = defaultdict(int)
    groups = {"voters": 0, "operator": 0, "other": 0}
    operators = defaultdict(int)
    for a, p in paid.items():
        if a == addr:
            continue
        v_part = 0
        if a in voters:
            r = ratios.get(a, (p / due100[a], 0))[0]
            v_part = p if (hi is None or r <= hi or a in capped) else min(p, est * due100[a])
        v_part += min(redirected_to.get(a, 0), p - v_part)
        rest = p - v_part
        is_op = rest > 0 and (a in voters or (rest >= 0.01 * F and seen[a] >= max(1, 0.5 * n_runs))
                              or a in redirected_to)
        groups["voters"] += v_part
        to_voters[a] = v_part
        if is_op:
            groups["operator"] += rest
            operators[a] += rest
        else:
            groups["other"] += rest

    paid_voters = {a for a in paid if a in voters and a != addr} | set(redirect_voters)
    per_run_amounts = defaultdict(list)
    for r in runs_window:
        for a, amt in r["pays"].items():
            per_run_amounts[a].append(amt)
    fixed = {a for a, v in per_run_amounts.items() if a in voters and len(v) >= 3 and len(v) == n_runs
             and max(v) - min(v) <= 1 and v[0] % 1_000_000 == 0}       # identical, whole 0.01 ARK
    off = [(a, r) for a, (r, _) in ratios.items()
           if est is not None and abs(r - est) > BAND and r <= hi and a not in capped
           and a not in redirect_voters]
    tiers = []
    for a, r in sorted(off, key=lambda ar: ar[1]):
        if a in fixed:
            continue
        if tiers and abs(r - tiers[-1]["r"]) <= 0.01:
            tiers[-1]["n"] += 1
            tiers[-1]["w"] += voters[a]
        else:
            tiers.append({"r": r, "n": 1, "w": voters[a]})
    tiers = [{"rate": round(100 * t["r"], 1), "voters": t["n"], "pct_votes": round(100 * t["w"] / V, 1)}
             for t in tiers if t["n"] >= 3 or t["w"] >= 0.05 * V]
    unpaid = {a: b for a, b in voters.items() if a not in paid_voters and a != addr}
    measured = [(r, voters[a]) for a, (r, _) in ratios.items()]

    # voters paid far above the share: their excess is operator income (operator's own vote,
    # partner deal); they are left out of the confidence
    over = {a for a, (r, _) in ratios.items() if hi is not None and r > hi}

    # maximum weight with a single voter above it: the largest voter alone at a lower rate
    single_cap = False
    if not cap and est is not None:
        top = max((a for a in ratios if a not in redirect_voters and a not in over),
                  key=lambda a: voters[a], default=None)
        if top and ratios[top][0] < est - BAND:
            cap, capped, single_cap = (paid[top], [top]), {top}, True

    # minimum weight: every unpaid voter is smaller than every paid one
    minimum = None
    paid_bal = [voters[a] for a in paid_voters]
    if paid_bal and len(unpaid) >= 3:
        lo = min(paid_bal)
        below = [b for b in unpaid.values() if b < lo]
        if len(below) >= 0.9 * len(unpaid) and lo >= 2 * SATOSHI:
            minimum = {"between_ark": [round(max(below) / SATOSHI, 1), round(lo / SATOSHI, 1)],
                       "ark": roundest_between(max(below) / SATOSHI, lo / SATOSHI),
                       "voters": len(below), "pct_votes": round(100 * sum(below) / V, 1)}
    new_unpaid = {a: b for a, b in unpaid.items() if a in joined}
    excluded = {a: b for a, b in unpaid.items()
                if a not in joined and (minimum is None or b >= min(paid_bal))}

    # confidence, from the large sample: share of voters + share of vote weight that sit on the
    # share or are explained (capped, fixed, redirected)
    c_in = c_all = w_in = w_all = 0
    for a in set(ratios) | set(redirect_voters):
        if a in over:
            continue
        ok = a in capped or a in redirect_voters or abs(ratios[a][0] - est) <= BAND
        c_all += 1
        w_all += voters[a]
        c_in += ok
        w_in += voters[a] if ok else 0
    conf = (c_in / c_all + w_in / w_all) / 2 if c_all and w_all else None

    res.update({
        "fees_kept": fee_basis,
        "share_pct": round_share(100 * est) if est is not None else None,
        "share_raw_pct": round(100 * est, 2) if est is not None else None,
        "confidence": round(conf, 2) if conf is not None else None,
        "effective_pct": round(100 * groups["voters"] / F, 1),
        "operator_pct": round(100 * groups["operator"] / F, 1),
        "other_pct": round(100 * groups["other"] / F, 1),
        "kept_pct": round(100 * (1 - total_out / F), 1),
        "separate_transfers_pct": round(100 * sum(side.values()) / F, 1),
        "operators": [{"address": a, "pct": round(100 * p / F, 2), "voter": a in voters}
                      for a, p in sorted(operators.items(), key=lambda kv: -kv[1])],
        "own_votes": {"voters": own_voters, "to": [rd["to"] for rd in own],
                      "pct_votes": round(100 * own_votes / V, 1)} if own_votes else None,
        "redirects": [{"to": rd["to"], "voters": rd["voters"],
                       "pct_votes": round(100 * sum(voters[v] for v in rd["voters"]) / V, 1),
                       "pct_forged": round(100 * rd["amount"] / F, 2),
                       "with_operator_cut_pct": round(100 * rd["operator_part"] / F, 2),
                       "partial": len(rd["partial"])}
                      for rd in redirects],
        "cap": {"ark_per_run": round(cap[0] / n_runs / SATOSHI, 2), "voters": len(cap[1]), "single": single_cap,
                "votes_ark": round_cap(round(cap[0] / (est * F / V) / SATOSHI)) if est else None}
               if cap else None,
        "voters_paid": len(paid_voters),
        "voters_measured": len(ratios),
        "paid_weight_pct": round(100 * sum(voters[a] for a in paid_voters) / V, 1),
        "minimum": minimum,
        "over_rate": [{"address": a, "pct_votes": round(100 * voters[a] / V, 1),
                       "rate": round(100 * ratios[a][0], 1),
                       "fixed_ark_per_run": per_run_amounts[a][0] / SATOSHI if a in fixed else None}
                      for a in sorted(over, key=lambda a: -voters[a]) if voters[a] >= 0.01 * V],
        "excluded": {"count": len(excluded), "pct_votes": round(100 * sum(excluded.values()) / V, 1)},
        "new_voters": {"count": len(new_unpaid), "ark": round(sum(new_unpaid.values()) / SATOSHI)},
        "unpaid": {"count": len(unpaid), "weight_pct": round(100 * sum(unpaid.values()) / V, 1),
                   "self_vote_pct": round(100 * voters.get(addr, 0) / V, 1),
                   "largest": [{"address": a, "pct": round(100 * b / V, 1)}
                               for a, b in sorted(unpaid.items(), key=lambda kv: -kv[1])[:3]]},
        "fixed": [{"address": a, "pct_votes": round(100 * voters[a] / V, 1),
                   "ark_per_run": per_run_amounts[a][0] / SATOSHI} for a in fixed
                  if a in dict(off) or a in capped],
        "tiers": [t for t in tiers if t["voters"] >= 3],
        "off_rate": [{"address": a, "pct_votes": round(100 * voters[a] / V, 1), "rate": round(100 * r, 1)}
                     for a, r in sorted(off, key=lambda ar: -voters[ar[0]])
                     if a not in fixed and voters[a] >= 0.01 * V
                     and not any(t["voters"] >= 3 and abs(100 * r - t["rate"]) <= 1 for t in tiers)][:5],
        "transfers_only": transfers_only,
        "ratio_p10_p90": [round(100 * weighted_quantile(measured, q), 1) for q in (0.1, 0.9)]
                         if measured else None,
        "per_run_effective_pct": [
            round(100 * sum(amt * to_voters[a] / paid[a] for a, amt in r["pays"].items()
                            if a != addr and paid[a]) / pr["forged"], 1) if pr["forged"] else None
            for r, pr in zip(runs_window, forged["per_run"])][-7:],
        "vendor": runs_window[-1]["txs"][0]["vendor"][:80],
    })
    res["status"], res["flags"] = classify(res, med_gap)
    return res


def classify(res, med_gap):
    flags = []
    s = res["schedule"]
    private = res["voters"] <= PRIVATE_MAX_VOTERS or res["transfers_only"] or med_gap < FREQUENT_H
    if res["cap"]:
        who = "largest voter" if res["cap"]["single"] else f"top {res['cap']['voters']} voters"
        flags.append(f"maximum weight: {who} paid as if holding ~{res['cap']['votes_ark']:,} ARK"
                     + (" (or a lower rate for that voter)" if res["cap"]["single"] else ""))
    if res["minimum"]:
        m = res["minimum"]
        at = f"~{m['ark']:g} ARK minimum: " if m.get("ark") else ""
        flags.append(f"minimum weight: {at}{m['voters']} voters below {m['between_ark'][0]:g}-"
                     f"{m['between_ark'][1]:g} ARK not paid ({m['pct_votes']}% of votes)")
    for o in res["over_rate"]:
        fx = f", fixed {o['fixed_ark_per_run']:g} ARK/run" if o["fixed_ark_per_run"] else ""
        flags.append(f"voter {o['address'][:8]}.. ({o['pct_votes']}% of votes) paid {o['rate']}%{fx}: "
                     f"the part above the share counts as operator")
    if res.get("fees_kept"):
        flags.append("shares block rewards only (keeps the fees)")
    if res.get("own_votes"):
        ov = res["own_votes"]
        flags.append(f"operator's own votes: {len(ov['voters'])} voter(s) with {ov['pct_votes']}% of votes, "
                     f"paid to {ov['to'][0][:8]}.. with the operator cut and left out of the voters' split")
    for rd in res["redirects"]:
        extra = f" + {rd['with_operator_cut_pct']}% operator cut" if rd["with_operator_cut_pct"] else ""
        part = (f" ({rd['partial']} also get a token amount at their own address: redirect or "
                f"operator-owned votes)") if rd["partial"] else ""
        flags.append(f"redirect: {len(rd['voters'])} voter(s) with {rd['pct_votes']}% of votes "
                     f"paid to {rd['to'][:8]}..{extra}{part}")
    for t in [t for t in res["tiers"] if t["pct_votes"] >= 0.5]:
        flags.append(f"tier: {t['voters']} voters ({t['pct_votes']}% of votes) get {t['rate']}%")
    for fx in res["fixed"]:
        flags.append(f"fixed: voter {fx['address'][:8]}.. ({fx['pct_votes']}% of votes) "
                     f"gets {fx['ark_per_run']:g} ARK per run")
    for o in res["off_rate"]:
        flags.append(f"voter {o['address'][:8]}.. ({o['pct_votes']}% of votes) gets {o['rate']}%")
    if res["excluded"]["pct_votes"] >= 2:
        flags.append(f"{res['excluded']['count']} voters ({res['excluded']['pct_votes']}% of votes) "
                     f"unpaid: self-vote, blacklist or new")
    if s["irregularity"] and s["irregularity"] > 0.5:
        flags.append("irregular schedule")
    if med_gap < FREQUENT_H:
        flags.append(f"pays every {med_gap:.1f} h: public pools pay daily or a few times a day")
    if res["transfers_only"]:
        flags.append("pays voters with single transfers, not multipayments: not a public pool")
    if res["voters"] <= PRIVATE_MAX_VOTERS:
        flags.append(f"fewer than {PRIVATE_MAX_VOTERS + 1} voters: a private pool (closed group "
                     f"or the operator's own wallets)")

    if res["voters_paid"] == 0 or not res["voters_measured"] or \
            (res["voters_paid"] < 3 and not private):
        return "not sharing", flags
    if private:                         # never shown, not even as gone dark
        return "private", flags
    stale_after = max(48, 3 * med_gap)
    if s["last_payout_h_ago"] > stale_after:
        return "stopped", flags
    if res["confidence"] is not None and res["confidence"] < 0.5:
        return "irregular", flags
    return "sharing", flags


# --------------------------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------------------------

SHARING = ("sharing", "stopped", "irregular", "private")


def split_payouts(txs, voters):
    """Multipayment payers: runs come from multipayments; single transfers are operator income.
    -> (txs to build runs from, single transfers set aside, transfers_only)"""
    mps = [t for t in txs if t["multi"]]
    if mps:
        return mps, [t for t in txs if t not in mps], False
    return txs, [], True


def evaluate_payer(c, delegate, voters, payer, txs, now, reward, shift=0, votes=None):
    run_txs, singles, transfers_only = split_payouts(txs, voters)
    picked = pick_window(group_runs(run_txs), now)
    if not picked:
        return None
    brun, win = picked
    side = defaultdict(int)
    for t in singles:
        if brun["ts"] < t["ts"] <= win[-1]["last"]:
            for a, amt in t["payments"]:
                if a != delegate["address"]:
                    side[a] += amt
    forged = fetch_forged(c, delegate["publicKey"], reward,
                          [brun["ts"] - shift] + [r["ts"] - shift for r in win])
    pk, t0, t1 = delegate["publicKey"], brun["ts"] - shift, win[-1]["ts"] - shift
    votes = votes or {}
    left = [v for v, (ts, vs) in votes.items() if ts > t0 and "-" + pk in vs and "+" + pk not in vs]
    left_bal = {}
    for i in range(0, len(left), 50):
        try:
            d = c.get(f"/wallets?address={','.join(left[i:i + 50])}&limit=50")
            left_bal.update({w["address"]: int(w["balance"]) for w in d["data"]})
        except ApiError:
            pass
    v_win, changes = window_votes(int(delegate["votes"]), voters, votes, pk, t0, t1, left_bal)
    # votes while each interval was forged (shifted by the payout delay). Pools pay by true block
    # weight: each block pays b / (votes at that block), so an interval in which the votes changed
    # is owed on the block-weighted average of 1 / votes, not 1 / the average of votes (cams: a 411k
    # joiner a third into a day read that day at 100.9% instead of 98.5%). v_runs[j + 1] is owed
    # for interval j.
    events = []                                      # (ts, change in votes from then on)
    for w, (ts, vs) in votes.items():
        if "+" + pk in vs and w in voters:
            events.append((ts, voters[w]))           # joined at ts
        elif "-" + pk in vs and w in left_bal:
            events.append((ts, -left_bal[w]))        # left at ts
    events.sort()

    def votes_at(t):
        return int(delegate["votes"]) - sum(d for ts, d in events if ts > t)

    run_ts = [brun["ts"]] + [r["ts"] for r in win]
    v_runs = [int(delegate["votes"])]
    for a, b in zip(run_ts, run_ts[1:]):
        a, b = a - shift, b - shift
        cuts = [a] + [ts for ts, _ in events if a < ts < b] + [b]
        inv = sum((t1 - t0) / max(votes_at(t0), 1) for t0, t1 in zip(cuts, cuts[1:])) / max(1, b - a)
        v_runs.append(max(int(1 / inv), 1) if inv > 0 else int(delegate["votes"]))
    res = analyze(delegate, voters, win, brun, forged, now, payer=payer, side=dict(side),
                  transfers_only=transfers_only, v_window=v_win,
                  joined={ch["voter"] for ch in changes if "joined" in ch}, v_runs=v_runs)
    res["vote_changes"] = changes
    res["votes_window"] = v_win / SATOSHI
    return res


def payout_wallet_candidates(c, delegate, voters, own_txs, now):
    addr = delegate["address"]
    cands = []
    totals = defaultdict(int)
    for t in own_txs:
        for a, amt in t["payments"]:
            if a != addr:
                totals[a] += amt
    if totals:
        a, amt = max(totals.items(), key=lambda kv: kv[1])
        if amt >= 0.5 * sum(totals.values()):
            cands.append(("forwarded", a))
    senders = defaultdict(set)
    for v in [a for a in sorted(voters, key=lambda a: -voters[a]) if a != addr][:3]:
        try:
            d = c.get(f"/wallets/{v}/transactions/received?orderBy=timestamp:desc&limit=50")
        except ApiError:
            continue
        for t in d["data"]:
            if t["timestamp"]["unix"] >= now - 7 * 86400 and t["sender"] not in (addr, v):
                senders[t["sender"]].add(v)
    for s, vs in sorted(senders.items(), key=lambda kv: -len(kv[1])):
        if len(vs) >= 2 and s not in [x for _, x in cands]:
            cands.append(("pays voters", s))
    return cands[:2]


def with_delay(c, delegate, voters, payer, txs, now, reward, res, votes):
    """Measure the payout delay from new voters; re-analyse with intervals shifted by it."""
    pk = "+" + delegate["publicKey"]
    cands = sorted(((ts, v) for v, (ts, vs) in votes.items()
                    if pk in vs and v in voters and now - ts >= DELAY_MIN_DAYS * 86400
                    and v != delegate["address"]), reverse=True)
    # prefer voters big enough to clear a minimum
    lo = res["minimum"]["between_ark"][1] * SATOSHI if res.get("minimum") else 0
    cands = [(ts, v) for ts, v in cands if voters[v] >= lo][:DELAY_SAMPLES]
    samples = [(ts, v, fetch_first_payouts(c, v, payer, ts)) for ts, v in cands]
    hours = res["window"]["hours"] or 1
    rate = res["forged"]["ark"] * SATOSHI / (hours * 3600)
    est = res["share_raw_pct"] / 100 if res.get("share_raw_pct") else None
    found = estimate_delay(samples, est, rate, int(delegate["votes"]), voters)
    paid = [f for f in found if f["paid"]]
    delay = {"samples": found, "new_voters_checked": len(found),
             "delay_h": round(statistics.median(f["delay_h"] for f in paid), 1) if paid else None,
             "first_payout_h": round(statistics.median(f["first_payout_h"] for f in paid), 1) if paid else None}
    if delay["delay_h"] and delay["delay_h"] >= 1:
        again = evaluate_payer(c, delegate, voters, payer, txs, now, reward,
                               shift=int(delay["delay_h"] * 3600), votes=votes)
        if again and again["status"] in SHARING:
            again["flags"] += [f for f in res["flags"] if f.startswith("pays from a separate wallet")]
            res = again
    res["delay"] = delay
    if delay["delay_h"] is not None:
        res["flags"].append(f"payout delay ~{delay['delay_h']:g} h; new voters' first payout after "
                            f"~{delay['first_payout_h']:g} h ({len(paid)} new voter(s))")
    elif found:
        res["flags"].append(f"{len(found)} new voter(s) since {DELAY_MIN_DAYS}+ days not paid yet")
    return res


def analyze_delegate(c, delegate, now, reward, votes=None):
    addr = delegate["address"]
    voters = fetch_voters(c, addr)
    txs, newest = fetch_sent(c, addr, now)
    votes = votes or {}
    res = evaluate_payer(c, delegate, voters, addr, txs, now, reward, votes=votes)
    if res and res["status"] in SHARING:
        return with_delay(c, delegate, voters, addr, txs, now, reward, res, votes or {})
    for how, cand in payout_wallet_candidates(c, delegate, voters, txs, now):
        ctxs, _ = fetch_sent(c, cand, now)
        alt = evaluate_payer(c, delegate, voters, cand, ctxs, now, reward, votes=votes)
        if alt and alt["status"] in SHARING:
            alt["flags"].append(f"pays from a separate wallet {cand} ({how})")
            return with_delay(c, delegate, voters, cand, ctxs, now, reward, alt, votes or {})
    if res:
        return res
    if newest is None:
        for typ in (6, 0):
            d = c.get(f"/wallets/{addr}/transactions/sent?typeGroup=1&type={typ}&orderBy=timestamp:desc&limit=1")
            if d["data"]:
                newest = max(newest or 0, d["data"][0]["timestamp"]["unix"])
    days = (now - newest) / 86400 if newest else None
    return {"username": delegate["username"], "address": addr, "rank": delegate["rank"],
            "votes": int(delegate["votes"]) / SATOSHI, "voters": len(voters),
            "status": "not sharing", "share_pct": None,
            "flags": [f"last payout {days:.0f} days ago" if days else "never paid out"]
            + ([f"fewer than {PRIVATE_MAX_VOTERS + 1} voters"] if len(voters) <= PRIVATE_MAX_VOTERS else []),
            "schedule": {"last_payout_h_ago": round(days * 24, 1) if days else None}}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--limit", type=int, default=51, help="how many active delegates (by rank)")
    ap.add_argument("--only", help="comma-separated usernames")
    ap.add_argument("--json", help="write full results here")
    ap.add_argument("--page", help="write the explorer page's compact JSON here")
    ap.add_argument("--min-sharing", type=int, default=5,
                    help="exit 2 without writing --page if fewer sharing delegates are found "
                         "(an API outage must not replace good data with an empty list)")
    args = ap.parse_args()

    c = Client(verbose=True)
    now = int(time.time())
    reward = int(c.get("/node/configuration")["data"]["constants"]["reward"])
    delegates = c.get(f"/delegates?limit={min(args.limit, 100)}&isResigned=false")["data"]
    delegates = [d for d in delegates if d.get("rank") and d["rank"] <= args.limit]
    if args.only:
        names = set(args.only.split(","))
        delegates = [d for d in delegates if d["username"] in names]

    votes = fetch_recent_votes(c, now)
    results = []
    for d in delegates:
        t0 = time.time()
        try:
            r = analyze_delegate(c, d, now, reward, votes)
        except ApiError as e:
            r = {"username": d["username"], "rank": d["rank"], "status": "error", "flags": [str(e)]}
        results.append(r)
        print(fmt(r), f"({time.time() - t0:.1f}s)", flush=True)
    print(f"\n{c.requests} requests", file=sys.stderr)
    if args.json:
        with open(args.json, "w") as f:
            json.dump({"generated": now, "results": results}, f, indent=1)
    if args.page:
        page = page_json(results, now, reward)
        n = sum(1 for d in page["delegates"] if d["status"] == "sharing")
        if n < args.min_sharing:
            print(f"only {n} sharing delegates found; not writing {args.page}", file=sys.stderr)
            sys.exit(2)
        with open(args.page, "w") as f:
            json.dump(page, f, separators=(",", ":"))
        print(f"wrote {args.page}: {len(page['delegates'])} delegates", file=sys.stderr)


PAGE_STATUSES = ("sharing", "irregular", "stopped")
PAGE_MIN_SHARE = 50         # the page lists public pools that share at least this much (rounded share)
PAGE_MAX_INTERVAL_H = 26    # ...and pay at least daily (24 h plus some slack for timing drift)


def page_json(results, now, reward):
    """What the explorer's shares page needs: public sharing delegates that share at least
    PAGE_MIN_SHARE and pay at least daily, plus such delegates that stopped paying within the
    lookback (gone dark).
    Private, low-share and never-sharing delegates are left out."""
    out = []
    for r in results:
        if r.get("status") not in PAGE_STATUSES or (r.get("share_pct") or 0) < PAGE_MIN_SHARE:
            continue
        if r["schedule"]["median_interval_h"] > PAGE_MAX_INTERVAL_H:
            continue
        s, w = r["schedule"], r["window"]
        hours = w["hours"] or 1
        delay = r.get("delay") or {}
        out.append({
            "rank": r["rank"], "username": r["username"], "address": r["address"],
            "payer": r["payer"] if r["payer"] != r["address"] else None,
            "status": r["status"],
            "share": r["share_pct"], "shareRaw": r["share_raw_pct"], "confidence": r["confidence"],
            "effective": r["effective_pct"], "operator": r["operator_pct"], "kept": r["kept_pct"],
            "votes": r["votes"], "votesWindow": r.get("votes_window"), "voters": r["voters"], "votersPaid": r["voters_paid"],
            "forgedPerDay": round(r["forged"]["ark"] / hours * 24, 2),
            "intervalH": s["median_interval_h"], "payoutsPerDay": s["payouts_per_day"],
            "lastPayout": now - int(s["last_payout_h_ago"] * 3600),
            "delayH": delay.get("delay_h"), "firstPayoutH": delay.get("first_payout_h"),
            "capArk": r["cap"]["votes_ark"] if r.get("cap") else None,
            "minArk": (r["minimum"].get("ark") or r["minimum"]["between_ark"][1]) if r.get("minimum") else None,
            "perRun": r.get("per_run_effective_pct", []),
            "window": {"from": w["from"], "to": w["to"], "runs": w["runs"]},
            "operators": r.get("operators", [])[:3],
            "flags": r.get("flags", []),
            "vendor": r.get("vendor", ""),
        })
    return {"generated": now, "rewardPerBlock": reward / SATOSHI, "delegates": out}


def fmt(r):
    s = r.get("schedule", {})
    share = f"{r['share_pct']:3d}% ({r['share_raw_pct']:5.2f})" if r.get("share_pct") is not None else "  -          "
    return (f"{r['rank']:>2} {r['username'][:16]:16} {r['status']:11} share={share} "
            f"conf={r.get('confidence', '-')!s:4} eff={r.get('effective_pct', '-')!s:5} "
            f"op={r.get('operator_pct', '-')!s:5} oth={r.get('other_pct', '-')!s:4} "
            f"kept={r.get('kept_pct', '-')!s:5} voters={r.get('voters_paid', '-')}/{r.get('voters', '-')} "
            f"every={s.get('median_interval_h', '-')}h last={s.get('last_payout_h_ago', '-')}h | "
            f"{'; '.join(r.get('flags', []))}")


if __name__ == "__main__":
    main()
