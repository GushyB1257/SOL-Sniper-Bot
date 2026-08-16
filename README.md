# SOL Trader Bot

An AI-driven Solana memecoin trader. It watches every pump.fun launch, tracks
which ones develop real buying interest, and has **Claude judge the survivors**
the way a human trader sifting the board would — then sizes, executes, and
manages the position with deterministic risk controls underneath.

Runs in **paper mode by default**. It will not touch real money until you
explicitly change two settings.

Two strategies ship in the box:

| `STRATEGY` | What it does |
|---|---|
| `ai` (default) | Watchlist → traction gate → Claude entry decision → laddered exit with Claude re-reviewing the thesis |
| `rules` | The original deterministic sniper: buys at creation on hard filters |

---

## Why AI, and where it actually helps

Sniping at creation is a **latency race** — won in microseconds by co-located
infrastructure. An LLM call takes 1–3 seconds, so putting Claude in that path
makes it strictly worse, not better. Same for MEV and on-chain arbitrage: those
are won inside a single block by custom Rust bidding in Jito auctions. AI is
categorically the wrong tool there, and no amount of prompt engineering fixes an
arithmetic gap of that size.

**What this bot does instead is the game the clock doesn't decide.** The wallets
that grind memecoins profitably aren't racing block times — they're looking at
tokens that are already minutes old, with real trades and real holders, judging
whether interest is organic and building or manufactured and about to be dumped.
That is a judgment problem playing out over minutes, where a two-second
inference delay costs nothing.

**The edge is coverage and consistency, not superhuman insight.** A human can
watch maybe 20–50 tokens a day carefully. This screens thousands, applies the
same criteria to every one, and never gets tired, tilted, or FOMO'd. That is a
real edge and it is the realistic one — "the AI knows which coin will moon" is
not on offer.

**Claude does not learn from your trades.** The model is frozen; there is no
weight update from API use. The bot accumulates a track record and feeds
deployer reputation back as context, but that is retrieval, not training.

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
you even consider going live.** Paper mode tracks real prices on real launches,
so the answer it gives is meaningful — but it assumes every buy landed and every
sell found a bid, so it is a ceiling. If the profit factor is below 1.0 there,
live will be worse, and that result is decisive.

Start with **[QUICKSTART.md](QUICKSTART.md)** if you have not run a Node project
before.

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

### AI strategy (`STRATEGY=ai`, the default)

A funnel, because analyst calls cost real money and most tokens don't deserve one:

```
 every launch ─► watchlist ─► traction gate ─► Claude ─► risk ─► executor
  ~1000s/day     free, tracks   free, cheap     paid,     sizing   paper or
                 buy/sell flow  thresholds      ~5-30/day          on-chain
                                                   │                   │
                                    Claude re-reviews open positions   │
                                    against their own thesis ──────────┤
                                                                       │
      mechanical stops / ladder / time stop run underneath, always ────┤
                                                                       │
                              dashboard ◄────────────────────────────────
                         localhost:4321, live P&L + AI spend
```

**1. Watchlist.** Every launch is tracked, none are bought at creation. The bot
subscribes to each token's trades and accumulates: unique buyers vs sellers, buy
vs sell volume, the buyer arrival rate across two 60-second windows, price path,
curve progress, and whether the deployer has sold.

**2. Traction gate (free).** Only tokens meeting *all* of these reach Claude:
old enough to have a signal but not so old the move has happened; ≥25 unique
buyers; ≥3 SOL of buy volume; buyers still arriving in the last 60s; deployer
hasn't sold; sellers not outnumbering buyers. This is the main cost lever — it
turns thousands of launches a day into a handful of API calls.

**3. Claude decides.** The analyst gets a plain evidence pack — flow, price
structure, curve position, deployer history — and returns a structured decision:
buy or pass, a confidence score that sizes the position, a one-sentence thesis,
named risks, a target, and the level at which its thesis is disproven. Output is
constrained by a JSON schema, so a malformed decision can't reach the sizing
logic at all.

**4. Claude manages.** Every 90s each open position is re-judged *against its own
thesis*: hold, trim, or exit. Not "is it up" — the ladder handles price levels —
but "is the reason I bought this still true".

**5. Deterministic floor.** The mechanical stop loss, ladder, trailing stop and
time stop run underneath the model at all times. The analyst may cut sooner than
the configured stop; it can **never widen it**. A model that talks itself into
holding a rug is the exact failure this design has to survive, so that authority
stays in code — and there's a test asserting it.

### Cost control

Claude Opus 5 is the default. Two hard guards, both enforced before any call:

- `AI_MAX_CALLS_PER_HOUR` (default 60) — rolling hourly cap
- `AI_DAILY_BUDGET_USD` (default $10) — stops calling once estimated spend passes it

The long system prompt carries a cache breakpoint, so after the first call it
bills at roughly a tenth of the input price. The dashboard shows live spend,
cost per call, and cache hit volume.

**Paper mode still calls the API.** No SOL is spent, but tokens are — budget
accordingly.

### `rules` strategy

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

Price comes from one place for both real and paper trading
(`src/execution/pricing.ts`): while a token is on the bonding curve, its price
is a pure function of the curve's reserves, so a single account read gives an
exact price with no oracle and no third party. After graduation the reserves
freeze and it falls back to a Jupiter quote. Paper and live differ only in
whether a transaction is actually signed and sent.


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

### 6. Dashboard (`src/server/`)

A local web UI at **http://127.0.0.1:4321**, started automatically with the bot.
Live over a websocket, ~1s refresh, with polling fallback if the socket drops.

- **Net P&L** hero figure — realised plus open, marked to market — with return
  on capital deployed, best/worst trade and average winner/loser.
- **Equity curve** — cumulative realised P&L per closed trade, with a hover
  crosshair and tooltip. Zero baseline drawn, since the value crosses it.
- **KPI row** — win rate, profit factor, today's P&L against the daily limit,
  open positions, wallet balance, launches seen/screened/rejected.
- **Open positions** — age, cost, entry → current price, gain, P&L, how much of
  the position is left, **ladder progress as pips** (filled rungs, plus an amber
  pip once the moonbag is armed), distance to the nearest active stop, and the
  safety score it was bought on. Click a mint to copy it.
- **Risk meters** — daily loss, hourly spend, position count and loss streak,
  each against its configured limit, going amber at 75% and red at the cap.
- **Trades / Config / Activity** tabs — full journal, every setting the bot is
  running with, and a live log including the reason each launch was rejected.
- **Exits by reason** — which exit rule is actually closing your positions and
  what each one earned. The single most useful chart for tuning the ladder.
- **Kill switch** and per-position **force sell**, both behind a confirmation.

Colour is not the only channel: every P&L figure carries an explicit `+`/`−`
sign, so the numbers read correctly for colourblind viewers. A **CVD** button
additionally swaps profit-green for a blue that clears colourblind separation
against the loss red (validated: ΔE 23.8 protan / 25.7 deutan, versus 4.1 for
green-red). Light and dark themes both ship, following your OS by default.

#### Dashboard security

The UI can liquidate positions, so it is locked down accordingly:

- Binds to **loopback only**. Leave `DASHBOARD_HOST=127.0.0.1`; if you need it
  from another machine, forward it over SSH (`ssh -L 4321:127.0.0.1:4321 …`)
  rather than binding publicly.
- Writes (kill switch, force sell) require a **per-run token** generated at
  startup and embedded in the served page, so another site open in your browser
  cannot forge one.
- `Host` is checked against loopback names to defeat **DNS rebinding**, and
  `Origin` is checked to defeat **CSRF**.
- **Secrets never reach the browser**: the private key is excluded by name and
  RPC URLs are redacted, since they routinely carry a paid API key in the query
  string or subdomain.
- A strict CSP denies every external origin; the page loads no fonts, scripts,
  or images from the network.

Set `DASHBOARD_ENABLED=false` to turn it off. If the port is busy the bot logs
the error and keeps trading — the dashboard never blocks execution.

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
                   # → dashboard at http://127.0.0.1:4321
npm run report     # same numbers in the terminal, if you prefer
```

Paper mode is a **forward test, not a simulation**. Real launches, real safety
checks, and real prices read live from each token's own bonding curve on every
tick — if a token you paper-bought rugs, your paper position rugs with it. Fills
use the same constant-product maths the pump.fun program runs, against the
reserves that actually existed at that moment, so slippage and price impact are
modelled properly.

Three things it cannot know, and **all three flatter the result**: whether your
buy would have won the race, whether anyone would have bought your exit (the
curve always quotes; a real rug has no bid), and your own market impact. So
paper is a **ceiling**, not an estimate — which is what makes a losing paper
result decisive.

**New to this? Follow [QUICKSTART.md](QUICKSTART.md)** — step by step from
installing Node through to deciding whether the results justify real money.

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
npm test           # 120 tests
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
