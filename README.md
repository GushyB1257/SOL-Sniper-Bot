# SOL Sniper Bot

A Solana memecoin sniper: watches for new launches, filters out the obvious
scams, buys the survivors, and exits on a ladder that banks the stake early
while leaving a moonbag running.

Runs in **paper mode by default**. It will not touch real money until you
explicitly change two settings.

---

## Read this before anything else

You asked for this because you have seen people making money doing it. Some
are. Here is what is also true, and you should decide with both halves in view.

**The edge you are competing against is infrastructure, not code.** Profitable
snipers run co-located validators or paid Jito/geyser streams, submit bundles
with priority tips, and see launches in single-digit milliseconds. If you are
polling a shared public feed from a laptop, you are consistently arriving after
the people whose exit you are buying. This bot is written to be as fast as its
architecture allows, and that still may not be fast enough. That is a hardware
and spend question, not something more code fixes.

**Most new launches go to zero, and that is the normal case, not the failure
case.** Public analyses of pump.fun consistently put the share of tokens that
never reach a real market in the high nineties. The strategy here is built
around that: it assumes most positions lose, and tries to make the winners pay
for them. Whether that arithmetic closes depends on your fill quality, which
depends on the paragraph above.

**Survivorship bias is doing a lot of work in what you have seen.** People post
the 40x. Nobody posts the 200 consecutive stop-outs. The screenshots are real
and the average is still negative.

**The filters raise the bar; they do not make it safe.** Everything in
`src/safety/` catches a category of scam that is common and mechanical. None of
it catches a patient scammer who launches a clean token, lets it run, and dumps
on day two. Treat a passing safety score as "not obviously a trap", never as
"this is a good trade".

What this repo genuinely gives you: a correct, tested, well-instrumented
implementation of the strategy, with the risk controls that stop a bad night
from becoming a catastrophic one, and a paper mode that lets you find out what
your results actually look like before any money is involved.

**Run it in paper mode for at least a few days and read `npm run report` before
you even consider going live.** If the profit factor is below 1.0 on paper, it
will be worse live — paper mode cannot simulate losing the race or getting no
bid on the way out.

---

## About Axiom

Axiom.trade has **no public trading API**. The "Axiom API" packages on GitHub
and PyPI are reverse-engineered wrappers around the private endpoints their web
frontend calls, authenticated by replaying a browser session.

Building on that would mean automating a platform whose terms do not allow it
(with your funded account as the collateral), depending on undocumented
endpoints that can change without warning — and for a sniper the failure mode
is not an error page, it is an open position you cannot sell — and getting
nothing in return, because Axiom routes to the same pump.fun, PumpSwap and
Raydium pools this bot already trades against directly.

So the bot trades **on-chain, directly**. Same liquidity, lower latency, no
intermediary, no account to lose. `src/execution/axiom.ts` exists as a
documented seam: if Axiom ever ships a real API, implement five methods and set
`EXECUTOR=axiom`. Nothing else changes.

---

## How it works

```
 discovery ──► safety engine ──► risk manager ──► executor ──► position manager
 new launch    11 checks,         limits and       buy/sell      ladder, stops,
 in <1s        parallel, scored   breakers         on-chain      trade journal
```

### 1. Discovery (`src/discovery/`)

| Source | How | Latency |
|---|---|---|
| `pumpportal` | Free public websocket of new pump.fun launches | Shared with every other bot using it |
| `rpc` | `logsSubscribe` on the pump.fun program via your own node | As fast as your RPC; nobody else on your socket |

Use `rpc` with a paid node if you are serious. Anything older than
`MAX_CANDIDATE_AGE_MS` (default 5s) is dropped — sniping a 30-second-old token
is not sniping.

### 2. Safety engine (`src/safety/`)

Eleven checks run **in parallel**, each with its own timeout, so the whole
battery finishes inside the entry window. Four are fatal vetoes; the rest
deduct from a 100-point score that must clear `MIN_SAFETY_SCORE`.

| Check | Severity | What it catches |
|---|---|---|
| `freeze_authority` | fatal | Deployer can freeze your account — buy but never sell. The cleanest honeypot. |
| `mint_authority` | fatal | Deployer can print supply and dilute you to zero. |
| `dev_buy_share` | fatal | Deployer sniped >8% of supply in the create tx. Everyone after them is exit liquidity by construction. |
| `deployer_history` | fatal | This wallet's previous launches rugged. Learned locally as the bot runs. |
| `deployer_balance` | major | Minting from a dust wallet — the signature of high-volume spam. |
| `deployer_spam` | major | Same wallet minted 5+ tokens in 24h. |
| `metadata_sanity` | major | Cyrillic/full-width homoglyphs or zero-width padding in the ticker — impersonation. |
| `socials` | major | No resolvable metadata, or no Twitter/Telegram/site. |
| `duplicate_name` | major | Third-plus launch of the same ticker this hour — copycat wave. |
| `curve_sanity` | major | Bonding curve already well past its starting reserves, i.e. we are late. |
| `holder_concentration` | major | Top 10 wallets hold >65% (post-graduation only). |

Fatal checks are **fail-closed**: if the check errors, that counts as a failure.
"I could not tell" must not read as "it is fine". Scored checks fail open so one
flaky RPC call does not halt all trading.

The metadata fetcher only resolves URIs on an allowlist of IPFS/Arweave hosts —
the URI comes from the attacker, and an unrestricted fetch is an SSRF hole and a
free way to stall every snipe.

### 3. Risk manager (`src/risk/`)

The layer that decides whether to trade *at all*, regardless of how good the
token looks. The failure mode of a sniper is not one bad trade, it is forty bad
trades in an hour while you are asleep.

- Max concurrent positions (default 3)
- Daily realised-loss limit (default 0.5 SOL) — stops entries for the UTC day
- Consecutive-loss circuit breaker (default 4) with a 30-minute cooldown
- Rolling hourly spend cap (default 0.5 SOL)
- Wallet reserve floor so you always keep gas
- **Kill switch**: `touch STOP` in the repo root halts all new entries
  immediately. Existing positions continue to be managed.

### 4. Exit strategy (`src/strategy/exit-planner.ts`)

This is the "sell as it goes up, keep a bit in case it moons" part, and it is a
pure function with no I/O, so the whole policy is unit-tested.

Default ladder (`EXIT_LADDER=60:40,150:30,400:20`):

| Trigger | Action | Cumulative |
|---|---|---|
| +60% | sell 40% of the position | 64% of stake back |
| +150% | sell 30% | 139% — **stake fully recovered, playing with house money** |
| +400% | sell 20% | 239% |
| — | **10% moonbag rides** with a 70% trailing stop | |

Protecting it:

- **Hard stop loss** at −35%.
- **Trailing stop** at 45% off peak, armed once the first rung fills.
- **Moonbag trailing stop** at 70% off peak — a deliberately loose leash, this
  is the lottery ticket.
- **Time stop**: flat (<+10%) after 180s and the position is closed. A launch
  that has not moved in three minutes has failed, and holding only exposes you
  to the eventual dev dump.
- **Max hold** of 24h for the moonbag. Eventually it is just a dead bag.
- A gap-up that clears several rungs at once is batched into **one** sell, not
  three transactions.

The integration test in `test/lifecycle.test.ts` demonstrates the payoff shape:
a token that runs to 6x and then round-trips almost all the way back still
books **+177%**, because the ladder banked it on the way up.

### 5. Execution (`src/execution/`)

`onchain` builds the swap via PumpPortal's `trade-local` endpoint, then **signs
locally and broadcasts through your own RPC**. The key never leaves your
machine.

Because you are signing bytes someone else built, every transaction is validated
before signing: it must involve your wallet, reference the expected mint, use no
address-lookup tables, and invoke only programs on a known allowlist
(System / ComputeBudget / Token / ATA / pump.fun / PumpSwap / Raydium).
Anything else is refused rather than signed.

Fills are settled against **actual balance deltas**, not the quote — a sell that
lands but does not move the balance is reported as a probable honeypot rather
than booked as a success.

---

## Setup

```bash
git clone <this repo>
cd SOL-Sniper-Bot
npm install
cp .env.example .env
```

Every setting is documented inline in `.env.example`.

### Paper mode (start here)

```bash
npm run doctor     # validates config, RPC latency, ladder arithmetic
npm run sniper     # runs the strategy against live launches, zero transactions
npm run report     # trade journal: win rate, profit factor, exits by reason
```

Paper mode simulates fills against the same constant-product curve pump.fun
uses, so slippage and price impact behave realistically. It **cannot** simulate
whether your transaction would have landed first, or whether there would have
been a bid when you sold. Read paper results as a generous upper bound.

### Going live

Only after paper results justify it.

```bash
npm run wallet     # generate a dedicated burner keypair
```

Fund the burner with an amount you are fully prepared to lose. This key lives in
a plaintext `.env` on a machine running networked code — treat it as already
compromised and keep the balance at the size of your intended float. Never use a
wallet holding anything else.

Then in `.env`:

```ini
MODE=live
EXECUTOR=onchain
WALLET_PRIVATE_KEY=<burner key>
RPC_HTTP_URL=<paid node — Helius, QuickNode, Triton>
RPC_WS_URL=<paid node websocket>
```

`npm run doctor` refuses to bless a live config on the public RPC endpoint, and
the config loader rejects `MODE=live` with a paper executor or a missing key.

Start with `BUY_AMOUNT_SOL` far smaller than you think you want.

---

## Tuning

| Want | Change |
|---|---|
| Take profit sooner | Lower the first rung: `EXIT_LADDER=40:50,120:30,300:15` |
| Bigger moonbag | Reduce the rung percentages — the remainder is the moonbag |
| Survive more chop | Raise `STOP_LOSS_PCT` and `TRAILING_STOP_PCT` |
| Fewer, higher-conviction entries | Raise `MIN_SAFETY_SCORE` to 85, lower `MAX_DEV_BUY_PCT` to 5 |
| More entries (riskier) | Lower `MIN_SAFETY_SCORE`, set `REQUIRE_SOCIALS=false` |
| Land more snipes | Raise `PRIORITY_FEE_SOL`; get a faster RPC |

The config loader rejects incoherent settings at boot rather than letting them
silently mis-size a position: non-ascending rungs, ladders selling >100%,
ladders leaving no moonbag, or a trailing stop tighter than the hard stop.

## Operating

- `touch STOP` — halt new entries immediately.
- **Ctrl-C does not liquidate.** Open positions are persisted to
  `data/state.json` and resumed on the next start. Dumping everything into a
  thin book because the process restarted is usually worse than holding.
- Crashes flush state before exiting; a corrupt state file aborts startup rather
  than silently starting fresh and orphaning tokens you still hold.

## Development

```bash
npm test           # 53 tests
npm run typecheck
npm run build
```

The exit policy (`src/strategy/exit-planner.ts`) is pure — no chain, no clock,
no I/O — so ladder, stop, trailing and time-stop behaviour are all tested
directly. `test/lifecycle.test.ts` drives complete positions through the paper
executor end to end.

## Legal

For educational purposes. You are responsible for compliance with the laws and
tax rules in your jurisdiction, and for the terms of any service you point it
at. No warranty. You will probably lose money.
