# GushyB's SOL Moneymaker

An AI-driven Solana memecoin trader. It watches every pump.fun launch, tracks
which ones develop real buying interest, and has **Claude judge the survivors**
the way a human trader sifting the board would — then sizes, executes, and
manages the position with deterministic risk controls underneath.

Runs in **paper mode by default**. It will not touch real money until you
explicitly change two settings.

## Three bots, three tabs

The dashboard runs three independent strategies side by side. Each has its own
positions, P&L, journal and risk limits — sharing them would mean one strategy's
losing streak trips the breaker on the others, and a single blended number that
cannot answer *which of these actually works*. The wallet and the executor are
shared, because there is only one wallet.

| Tab | What it does |
|---|---|
| **Screener** | Applies a volume / market-cap / socials filter to every launch and enters the instant one matches |
| **Sniper** | The original creation-time sniper: full safety battery, buys at launch |
| **Copy trader** | Mirrors wallets you nominate — buys when they buy, sells the same fraction when they sell |

Start, stop and pause each one from its tab. **Every setting is editable from
the page** — filters, sizing, exits, risk limits, tracked wallets — and applies
live, with no restart and no editing `.env`. Values are validated by exactly the
same code the process boots with, so a bad number is rejected whole with the
message you would have seen at startup, and the running config is untouched.
Saved settings live in `data/settings.json` and layer over `.env`.

Two things are deliberately **not** editable from the browser: `MODE`,
`EXECUTOR`, the wallet key and the RPC URLs. Whether the bot is spending real
money should require touching the machine.

Each tab shows a **RUNNING / PAUSED / STOPPED** pill; the button next to it says
only what pressing it will do. You cannot stop the last running bot — the
attempt is refused with a message next to the button. Stopping a bot leaves its open positions managed and
closable; only new entries stop.

---

## The copy trader

Give it wallets; it mirrors them.

**Buys are filtered, sells are not.** Not every buy is a position — wallets
routinely make dust purchases purely to push a token up a screener's volume
ranking, and a copy trader that follows those ends up holding things the wallet
never committed to. `COPY_MIN_BUY_SOL` (default 0.5) is the filter that matters,
and it is enforced on the **SOL value** of their buy, priced through the bonding
curve, rather than on a token count that means nothing across different
supplies. Sells have no filter at all and mirror the **fraction**: they dump 40%
of their bag, you sell 40% of yours. Any filter on the sell side is a way to
still be holding after the person you are following has left.

**It reads balances, not trades.** The obvious implementation subscribes to
their trades. This polls their token accounts instead, for two reasons: the
feed we would subscribe to has already been observed to stop delivering
silently, and a balance tells you the truth *right now* whereas a trade stream
only tells you what happened while you were listening. A missed message costs a
trade; a missed poll costs one interval. Reading balances also hands you the
number that matters most for mirroring an exit — the fraction of their holding
they just sold — which would otherwise have to be reconstructed from partial
fills.

The cost is latency: you react a poll interval late (2s by default) rather than
in the same block. For following a wallet's position that is fine. For racing
them into a launch it is not, and this does not pretend otherwise.

**A price you cannot read is not a rug.** Once a token graduates off the
bonding curve its price comes from a Jupiter quote, and a quote endpoint being
unreachable used to look identical to a token having no liquidity: the position
was declared rugged, the sell then failed for want of a price, and it was booked
at -100% — on tokens the wallet being copied sold without trouble. Several quote
hosts are now tried, a sell is retried `EXIT_MAX_ATTEMPTS` times with a backoff
before anything is written off, an unreadable price is tolerated for
`PRICE_STALE_SECONDS` (10 minutes) rather than two, and when it is finally given
up the reason is `unpriceable` rather than `rug_detected` — with the deployer's
reputation left alone, since our outage says nothing about who launched it.

**Every wallet carries its own P&L.** Each row of the tracked-wallets card
shows what copying that wallet has actually made — realised from its closed
trades plus mark-to-market on the ones still open, with the win count
underneath. Open positions are included deliberately: a wallet whose last three
calls are all still running is not a wallet with no results, and waiting for
them to close would leave the card reading zero for hours. This is the number
that tells you which wallets to keep.

**Name the wallets.** A wallet is 44 characters of base58 and nothing in it
tells you who it is. Append `=Name` to any entry in `COPY_WALLETS` —
`9xQe…4Rt=Insider, 4Kp8…zzQ=Whale` — and that name appears on every open
position and closed trade copied from it, alongside the tracked-wallets card.
The journal stores the **address**, not the name, and resolves it when the page
renders, so renaming a wallet relabels its entire history rather than only the
trades that follow. Names are editable from the dashboard like every other
setting.

**How late you actually are.** Balance polling means you cannot be in the same
block as the wallet you follow — by the time their buy shows up in a balance,
it has already moved the price. That part is structural and no amount of tuning
removes it. What was removed is everything else:

| Where the time went | Now |
|---|---|
| Wallets polled one after another | All at once — the last wallet in the list is no longer N round trips late |
| Both token programs read in sequence | In parallel |
| Sells queued behind an in-flight buy | Sells bypass the entry queue entirely |
| A balance read before every buy | Cached for 5s, so the risk check is free |
| A blockhash fetched between building and sending | Refreshed in the background and already in memory |
| Two pre-trade reads in sequence per trade | Issued together |
| Default poll interval 2s | 1s |

The queue change is the one that matters most. Buys are serialised because they
contend for the position cap and the hourly spend cap, and two clearing the same
limit at once would overspend. A sell contends for nothing, so making it wait
behind a slow entry only means being late out of a position the wallet has
already left.

The mechanical exits are **disabled** for copied positions. A ratchet or a stop
firing underneath one would exit on your schedule while the wallet you are
copying is still holding, which is the one thing a copy trader must never do.
The only exit of its own is `COPY_MAX_HOLD_SECONDS`, a backstop for a wallet
that goes quiet holding a dead token.

---

Four entry modes ship in the box for the screener bot, set by `ENTRY_MODE`:

| `ENTRY_MODE` | What it does | Model in the entry path? |
|---|---|---|
| `screener` (default) | Applies a screener filter — venue, market cap, volume, socials — to every launch continuously, and enters the instant one matches | No |
| `fast` | Deterministic momentum trigger on the trade stream | No |
| `ai` | Claude reads an evidence pack and decides | Yes |
| `rules` | The original sniper: buys at creation on hard filters | No |

The first two are reflexes and fire in microseconds. The third is judgment and
takes seconds. Which one you want depends entirely on how fast the thing you are
trading moves — see below.

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

## The screener strategy (default)

This is the filter a human sits and watches, applied automatically to every
launch on the network at once:

```
only pump standard coins  ·  ≥ $3k volume  ·  ≥ $6k market cap  ·  ≥ 1 social
```

Tokens crossing that filter tend to do one of three things: pop for a few
seconds and crash, stall and then crash, or bond. The strategy is built around
that shape rather than around predicting which is which. **Be in at the
crossing; be out before the crash.** Nothing here forecasts anything — it is a
stopwatch on a condition.

**Where the numbers come from.** Market cap and volume are read straight off
each token's **bonding curve over your own RPC**, not from a third-party feed.
That matters for one specific reason: a trade stream can only tell you about
trades that happened after you subscribed, so a token you meet mid-move reports
zero volume forever. The curve carries its whole history — `realSolReserves` is
the SOL deposited since launch — so the first read of a token is already correct.
One `getMultipleAccounts` covers 100 tokens, which makes watching a few hundred
young launches about two requests a second.

PumpPortal's trade feed still runs alongside it and contributes buyer counts and
deployer-sold detection; whichever source saw more volume wins. Set
`SCREEN_DATA_SOURCE=feed` to turn the chain reads off, or `curve` to drop the
feed's contribution.

**Why it is fast.** The check is a pure function over state the bot already has,
so it runs on the *same websocket event that moved the numbers*, not on a timer
that would sample the condition after it had passed. No model, no network call,
no I/O — microseconds per trade event. The one thing it cannot answer locally is
socials, which needs an HTTP fetch, so that check is deliberately **last**: only
tokens that already cleared every other filter ever cost a request.

**Two optional tighteners**, both **off** by default, because they are not part
of the filter and a bot that refuses to buy something that matched is
indistinguishable from a broken one. Turn them on once the report shows those
entries losing money:

- `SCREEN_MIN_BUYERS` — one wallet can manufacture the volume and market cap the
  other filters look at. Distinct buyers is what makes those numbers mean
  something.
- `SCREEN_MAX_MCAP_USD` — above a ceiling the move being screened for has
  already happened, and buying there means buying from whoever caught it.

**Two things that will make it look broken when it isn't:**

- **It only sees launches from the moment it starts.** The feed carries new
  tokens; a coin already trading when you started the bot was never on its
  watchlist and cannot be bought. Give it a few minutes before comparing
  against a screener you already had open.
- **A match is not always a buy.** Position cap, hourly spend cap, daily loss
  limit and the loss-streak breaker all sit downstream of the filter. Every one
  of those now prints `SKIP <symbol> — matched the filter but <reason>` at
  warning level, and the dashboard shows the last one, so the gap between
  *matched* and *bought* is never silent.

The terminal prints a `SCREEN` summary every minute — how many checks ran, which
filters are doing the rejecting, how many matched, how many were bought — and a
`CHAIN` line for how many curves were read. If either source is dead, the
summary names it rather than saying nothing is happening.

### The exit: a deadline, not a stop loss

A stop loss sells at the worst possible moment — the bottom of a wick — and on
a token that then recovers, that is the most expensive trade available. So
`EXIT_MODE=ratchet` (the default) has **no stop loss at all**. It replaces the
price question with a time question:

> Every 60 seconds, is this higher than it was at the last check?

Four rules, first match wins:

| | Rule | What it does |
|---|---|---|
| 1 | **Recover** | The moment it doubles, sell exactly enough to return the stake. Not on the timer — a 2x can happen inside one window and giving it back is the failure this design exists to avoid. |
| 2 | **Prove it** | At a checkpoint, before recovery: below the fee breakeven, it has not worked. Sell all. |
| 3 | **Stall** | At a checkpoint, either phase: not higher than last time, the move is over. Sell all. |
| 4 | **Skim** | At a checkpoint, after recovery and still climbing: trim 25% and let the rest run. |

A token that dumps 70% and recovers inside the window is **held**. A token that
dumps and stays down is sold at the checkpoint, not at the bottom of the wick.

The recovery quantity is solved from the fee model rather than eyeballed as
"sell half at 2x" — half leaves the stake short by the fees on both legs, so the
position is not actually de-risked and the moonbag is quietly funded out of
capital. Past that point the trade cannot lose money.

**The cost, stated plainly.** Nothing sells on price, so the most a losing trade
can cost is the **entire position**. A rug completes in seconds, well inside one
checkpoint. What pays for that is the recovery rule — but only on trades that
actually double, and most will not. `DAILY_LOSS_LIMIT_SOL` is what bounds a bad
day; `npm run doctor` prints how many total losses that allows. Set
`RATCHET_STOP_LOSS_PCT` to put a stop back if the paper results say you want one.

**Position size is the parameter people get wrong.** The priority fee is fixed
per transaction, so it is a far larger share of a small position. At 0.05 SOL
the round-trip breakeven move is **6.3%** — a "quick 5% scalp" at that size is a
guaranteed loss however well it is timed. At 0.25 SOL it is **3.7%**. That is
why `BUY_AMOUNT_SOL` defaults to 0.25. `npm run doctor` prints the arithmetic
for whatever you set, including the win rate your target and stop require.

### Auto-tuning (`AUTO_TUNE_ENABLED=true`)

The loop above, run by Claude on a schedule, so the bots improve the longer you
run them without you feeding data back by hand.

Off by default: it spends API credit on a timer and it edits the settings you
are trading on.

**What it can touch is fixed in code**, in `src/tuner/limits.ts`, not in config:

| Can change | Never changes |
|---|---|
| Entry filters (volume, mcap, age, socials, buyers) | Position size |
| Safety score threshold | Concurrent positions |
| Exit timing (checkpoints, recovery, give-back, trimming) | Daily loss limit, hourly spend cap |
| Copy-trade filters and sell multiplier | Loss-streak breaker, wallet reserve |
| | Slippage, stop loss, mode, executor |

Position size is on the right-hand side even though it is one of the strongest
levers on profitability, because *"the analysis said to bet more"* is the
failure mode that ends accounts. If the tuner concludes size is the problem it
writes a note for you to read, and you type the number in yourself.

**How it avoids fooling itself.** The naive version of this feature — feed the
journal to a model every few minutes and apply whatever comes back — does not
learn anything. It changes something, the next batch of trades reflects a blend
of every setting tried so far, nothing can be attributed to anything, and the
parameters random-walk while the log fills with confident explanations. So:

- **One experiment at a time per bot.** A change is made, then held still.
- **Every change is measured.** Expectancy over the trades that follow is
  compared against the window before it. A change that does not beat its
  baseline is **reverted automatically** — a neutral result reverts too, because
  the previous setting is the one with more evidence behind it.
- **Nothing moves under `TUNER_MIN_TRADES`** (default 40) closed trades. Below
  that, memecoin P&L is one or two outliers and any change can be justified
  from the noise.
- **A reverted change cannot be proposed again.** The model is told what has
  been tried and what happened; the code enforces it regardless.
- **Hard ranges and a per-round step cap** on every parameter, tighter than the
  config schema allows. This is what stops a series of individually reasonable
  rounds walking a setting somewhere no single round would have proposed.
- **Every change is applied through the same validation** a human typing in the
  dashboard goes through. A patch that would produce an invalid config is
  refused whole.

The **Auto-tune tab** is the audit trail: every change, the reason the model
gave, whether the proposal had to be clamped, and the verdict when it was
measured. Same data in `data/tuning.json`, readable without the bot running.

At the default 6-hour interval this costs a few cents a day in API credit.

### Tuning it with data instead of opinion

Every threshold is adjustable and every default is a guess until you have paper
trades behind it. Two instruments make the loop empirical:

- **The dashboard** shows why entries were *skipped*, broken down by which
  filter turned them away. If one line dominates, that is the threshold holding
  you back — and if nothing is trading, this tells you why in one glance.
- **`npm run report`** breaks closed trades down by entry market cap, entry
  volume, age at entry, socials and hold time. Move the threshold whose worst
  bucket is both large and losing money. It covers **all three bots** — pass a
  name (`npm run report sniper`) for one of them.
- **The fee section of that report** answers the question the blended P&L
  cannot: whether the entries are bad or the *sizing* is. It prints what the
  trades made before fees and after them. Positive before, negative after, means
  the picks were fine and the round-trip cost ate them — a size or hold-time
  problem, not a filter problem. Negative before fees means the entries lost
  money before a single fee was charged, and no amount of sizing fixes that.
- **The win rate you need vs. the one you have.** From the average winner and
  average loser it computes the break-even hit rate for that pair. If your
  actual rate is below it, the *shape* of the strategy is wrong — winners must
  run further or losers must be cut sooner — and moving entry filters will not
  close the gap.

Under ~30 trades, none of it means anything; the report says so rather than
letting a lucky run look like an edge.

## How it works

### AI mode (`ENTRY_MODE=ai`)

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
- **Open positions** — age, cost, **the market cap you bought at next to the
  market cap now**, entry → current price, gain, P&L, how much of the position
  is left, **ladder progress as pips** (filled rungs, plus an amber
  pip once the moonbag is armed), distance to the nearest active stop, and the
  safety score it was bought on. Click a mint to copy it.
- **Risk meters** — daily loss, hourly spend, position count and loss streak,
  each against its configured limit, going amber at 75% and red at the cap.
- **Trades / Config / Activity** tabs — the journal, every setting the bot is
  running with, and a live log including the reason each launch was rejected.
  Trades are shown **per token, not per leg**: a token bought, partly sold and
  bought again produces several journal rows, and read individually each one
  carries its own full cost against partial proceeds, so a token that made money
  overall reads as a string of losses. The row sums them — cost in, proceeds
  out, percentage from the totals — with a `×N` chip when more than one closed
  position was folded in, and the individual exit reasons on hover. Click a mint
  to copy it.
- **Exits by reason** — which exit rule is actually closing your positions and
  what each one earned. The single most useful chart for tuning the exit.
- **Why entries were skipped** — in screener mode, every filter check that came
  back negative, broken down by the filter responsible. If nothing is trading,
  this says which threshold to move, in one glance rather than a log trawl.
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

Screener entries:

| Want | Change |
|---|---|
| More trades | Lower `SCREEN_MIN_VOLUME_USD`, raise `SCREEN_MAX_MCAP_USD`, set `SCREEN_MIN_SOCIALS=0` |
| Fewer, cleaner trades | Raise `SCREEN_MIN_VOLUME_USD` and `SCREEN_MIN_BUYERS` |
| Catch the move earlier | Narrow the window: `SCREEN_MAX_AGE_SECONDS=60`, lower `SCREEN_MIN_MCAP_USD` |
| Stop buying tops | Lower `SCREEN_MAX_MCAP_USD` |
| Include migrated coins | `SCREEN_ALLOWED_POOLS=pump,pump-amm` |

Ratchet exits (`EXIT_MODE=ratchet`):

| Want | Change |
|---|---|
| De-risk sooner, smaller moonbag | Lower `RECOVER_AT_GAIN_PCT` (60–80) |
| Turn capital over faster | Lower `CHECKPOINT_SECONDS` (30–45) |
| Cut drifters faster | Raise `RATCHET_MIN_PROGRESS_PCT` (3–5) |
| Hold a bigger runner | Lower `MOONBAG_TRIM_PCT` |
| Bound the downside again | Set `RATCHET_STOP_LOSS_PCT` (50–70 keeps the recovery upside) |
| Cut dead entries faster | Lower `RATCHET_FIRST_CHECKPOINT_SECONDS` (20–30) |
| Keep more of a move you already had | Lower `RATCHET_GIVEBACK_PCT` (25–35) |
| Let a runner breathe | Raise `RATCHET_GIVEBACK_PCT` (55–70), or 0 to disable |

**The give-back rule is not a stop loss.** It measures how much of the *gain
above entry* a position has handed back, so a position that is down has no gain
to give back and it can never fire. It exists because the checkpoint only looks
up once a window: without it, a position could run to +90%, round-trip the whole
move, and still be holding when the window finally closed. That was the single
largest leak in the design.

### If you are getting 429 errors

The sniper is the usual cause. It runs the safety battery on every launch off
the feed — four RPC calls apiece — and pump.fun deploys several tokens a second
at peak, which is enough on its own to rate-limit a consumer endpoint. The 429s
then land on position pricing and *sells*, not just on the checks that caused
them, which is how a rate limit turns into a position you cannot exit.

Three things now handle it, in order of where they act:

1. Every RPC call passes through one throttle — a token bucket for sustained
   rate (`RPC_MAX_REQUESTS_PER_SEC`) and a semaphore for burst
   (`RPC_MAX_CONCURRENT`). One caller cannot starve another.
2. A 429 or a 5xx is retried with exponential backoff and jitter
   (`RPC_MAX_RETRIES`), honouring `Retry-After` when the provider sends one.
   Jitter matters: without it every queued caller retries on the same beat and
   recreates the burst.
3. The sniper evaluates at most `SNIPER_MAX_CONCURRENT_CHECKS` launches at once
   and **drops** the rest rather than queueing them. A launch that had to wait
   in line is one you are too late to buy anyway.

If the dashboard still shows the amber **RPC throttled** chip climbing, lower
`RPC_MAX_REQUESTS_PER_SEC` to your provider's documented limit — 10 on most free
tiers. A free public endpoint will rate-limit this workload no matter what the
settings say; a paid endpoint is the real fix.

Scalp exits (`EXIT_MODE=scalp`):

| Want | Change |
|---|---|
| Bank profits sooner | Lower `SCALP_GIVEBACK_PCT` (30) and `SCALP_TARGET_NET_PCT` |
| Let winners run | Raise `SCALP_GIVEBACK_PCT` (60) and `SCALP_RUNNER_PCT` |
| Turn capital over faster | Lower `SCALP_TIME_STOP_SECONDS` |
| Make small targets viable | Raise `BUY_AMOUNT_SOL`; lower `PRIORITY_FEE_SOL` |

Ladder exits (`EXIT_MODE=ladder`):

| Want | Change |
|---|---|
| Take profit sooner | Lower the first rung: `EXIT_LADDER=40:50,120:30,300:15` |
| Bigger moonbag | Reduce the rung percentages — the remainder is the moonbag |
| Survive more chop | Raise `STOP_LOSS_PCT` and `TRAILING_STOP_PCT` |
| Land more snipes | Raise `PRIORITY_FEE_SOL`; get a faster RPC |

The config loader rejects incoherent settings at boot rather than letting them
silently mis-size a position: non-ascending rungs, ladders selling >100%,
ladders leaving no moonbag, a trailing stop tighter than the hard stop, an
unknown venue in `SCREEN_ALLOWED_POOLS`, a screener band nothing can pass, a
moonbag trim of 100%, or `ENTRY_MODE=screener` paired with `EXIT_MODE=ladder`.

## Operating

- `touch STOP` — halt new entries immediately.
- **Ctrl-C does not liquidate.** Open positions are persisted to
  `data/state.json` and resumed on the next start. Dumping everything into a
  thin book because the process restarted is usually worse than holding.
- Crashes flush state before exiting; a corrupt state file aborts startup rather
  than silently starting fresh and orphaning tokens you still hold.

## Development

```bash
npm test           # 361 tests
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
