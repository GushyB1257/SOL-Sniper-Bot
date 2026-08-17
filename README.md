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

**Closing a position sells that position, not the wallet.** The three bots
share one wallet and one balance per mint, so they routinely hold the same
token at once — the sniper buys a launch at creation, the screener buys it
again when it crosses the filter, the copy trader buys it because a tracked
wallet did. A "close" that sold the whole mint balance emptied the other two,
which then failed with *no balance to sell* and were booked at **-100% on a
token that had just been sold at a profit**. `closeAll` now means *exit this
position*: never more than its own quantity, and the on-chain `100%` shortcut
is used only when this position really is the entire holding. Reconciliation
against the chain only ever revises a position DOWN for the same reason — the
per-mint balance is larger than one position's share whenever another bot is in
the same token.

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

Rule 2 is recorded as **`dead_entry`** at the first checkpoint and
**`checkpoint_cut`** at any later one, because those are two different questions
under two different parameters: the first asks whether the entry ever started
(`RATCHET_FIRST_CHECKPOINT_SECONDS`), the second whether something that *was*
working has stopped (`CHECKPOINT_SECONDS`). They used to share the label
`time_stop` with `TIME_STOP_SECONDS` in ladder mode and `SCALP_TIME_STOP_SECONDS`
in scalp mode — three parameters, three exit modes, defaults an order of
magnitude apart, one label. Any read of "how are the timed exits doing" was a
read of all of them blended, and the auto-tuner cannot attribute what it cannot
distinguish; it noticed the collision itself, from hold times that made no sense
against `TIME_STOP_SECONDS`. The evidence it is given now names the parameter
behind each exit reason.

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

**What it can touch is fixed in code**, in `src/tuner/limits.ts`, not in
config — it cannot be widened from `.env`, from the dashboard, or by the tuner
itself. It covers **115 parameters** — everything the config schema has except a short,
documented exclusion list. Every entry filter and flow signal, the whole safety
battery and the provenance checks, all three exit machineries, the momentum and
watchlist gates, copy-trade behaviour, execution and RPC settings, the
analyst's model and budget, and the risk limits. A test walks every key in the
schema and fails unless it is tunable, locked, or explicitly excluded, so
"everything is reachable" is checked rather than claimed.

That last group deserves plain words. **The tuner can change how much money is
at stake per trade and how much you can lose in a day** — `BUY_AMOUNT_SOL`,
`MAX_CONCURRENT_POSITIONS`, `DAILY_LOSS_LIMIT_SOL`, `HOURLY_SPEND_CAP_SOL`, the
loss-streak breaker, the wallet reserve, both slippage settings and the stop
loss. In paper mode that is free. In live mode it is not, and the bounds are
the only thing between a bad inference and a bad afternoon. Seventeen
parameters carry a risk flag that reaches the prompt, the log, and a red
**RISK** tag on the dashboard, so a change to one is never quiet. Position size
is capped at 2 SOL and may move at most 25% per round — 0.25 can reach 0.31
next round, not 5.

Four things stay out, each for a reason that is not a matter of taste:

| Excluded | Why |
|---|---|
| `AUTO_TUNE_ENABLED`, `TUNER_*` | They **are** the enforcement. A system that can relax its own step cap or minimum sample has neither — and they are read mid-experiment to decide baselines. |
| `PROGRAM_FEE_PCT`, `ROUTER_FEE_PCT`, `SOL_USD_FALLBACK` | Measurements of the world, not choices. Changing them does not make trading cheaper, it makes the breakeven wrong — and the bot then holds losers below true breakeven. |
| `BOT_*_ENABLED` | Controls, not parameters. Turning a bot off stops the data it learns from; turning one on spends money on a strategy you switched off. |
| `COPY_WALLETS` | Your list of people to follow — an input. Nothing should quietly drop a wallet from it. |
| `DISCOVERY_SOURCE` | Read once at construction. Changing it does nothing until a restart, so the tuner would spend a measurement window on a change with no effect and then draw a conclusion from the noise. |

Mode, executor, the wallet key, RPC URLs, the dashboard and the PumpPortal
endpoints are refused a layer lower by the settings validator regardless of
what any list says. That last pair matters more than it looks: the trade
endpoint returns the transaction bytes we sign, so repointing it is repointing
what gets signed.

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

**How often it runs, and how you can tell.** Reviews are triggered by **trade
count, not by a clock** — 40 trades is 40 trades whether they took two minutes
or two days, and gating on time just wastes data when a bot is trading fast. A
bot is reviewed as soon as it has `TUNER_MIN_TRADES` closed trades since its
last change, then again once it has that many more to judge the change by.

**The loop does not pause to breathe.** A pass that settles an experiment goes
straight on to propose the next one, using the very trades that just decided it
— those are the freshest evidence there is, and stopping to re-read them later
gains nothing. So the cycle is: change, measure, decide, change again, with the
measuring being the only wait. The risk of proposing straight after a revert —
re-applying the thing just rejected — is handled where it belongs: every settled
verdict goes into the prompt, and `wasReverted` refuses the exact value
mechanically whatever the model says.

The bar the next change has to beat comes from the verdict, not from the window
just measured. Keep a change and the bar is what it scored. **Revert one and the
bar is the earlier measurement**, because that is the configuration now running
— carrying the rejected number forward would leave a bar the next change clears
by doing nothing, and the tuner would start keeping noise on the strength of it.

`TUNER_INTERVAL_MINUTES` (default 5) is a **floor, not a schedule**: the minimum
gap between changes to the same bot, and the only thing bounding API spend. It
is per bot, so the sniper closing trades in seconds never waits on the copy
trader closing one an hour. It is read from the ledger rather than a timer, so
restarting the bot does not earn a free review.

It is measured from when the last change was **made**, so the time spent
measuring counts toward it rather than being added to it. That matters: the
measurement window is already a wait, and restarting the clock when the evidence
finally arrives means waiting twice for one experiment — idling at the exact
moment there is most reason to act. Set it to 1 to let the loop run purely at
trade speed.

If your bots trade fast, **raise `TUNER_MIN_TRADES` rather than lowering the
gap**. Trades are the currency of statistical confidence and they cost you
nothing but time: 150 trades per decision is a far better read than 40, and at
40 trades every couple of minutes it barely slows anything down.

Because "nothing happened" and "it is broken" look identical from outside, each
bot's page carries an **Auto-tune card** showing exactly where that bot is:

- `Gathering — 18 of 40 trades before the next change`, with a progress bar
- `Measuring the last change — 12 of 40 trades needed to judge it`
- `Enough data — a change is due on the next look`
- `Ready — holding off until the minimum gap passes, in 6 min`
- when the next review is due, counted down in the card heading
- the last few changes to *that bot*: `SCREEN_MIN_VOLUME_USD 3000 → 3900`, the
  old value struck through, tagged running / kept / reverted, with the model's
  reason on hover

The **Auto-tune tab** is the full trail for the bot you are looking at: every
change, the reason given, whether the proposal had to be clamped by the limits,
and the verdict once measured. Same data in `data/tuning.json`, readable
without the bot running.

At the default 6-hour interval this costs a few cents a day in API credit.

### What it reads about a coin

Beyond venue, age, market cap, volume, socials and the safety battery, the
screener now reads nine more signals — all computed from state it already
collects, so none of them costs an RPC call. Every one defaults to **off**.

| Signal | What a volume filter cannot tell you |
|---|---|
| Seconds since last trade | Whether the token is still moving or stopped an hour ago. Volume with no flow behind it looks identical on a volume threshold. |
| Drawdown from peak | Whether you are buying the move or its second half. |
| Buyer acceleration | Buyers in the last 60s over the 60s before — a wave still building versus one that already broke. |
| Net SOL flow | 2:1 is the same ratio on 0.2 SOL and on 20. The difference is the trade. |
| Average buy size | A floor filters dust participation; a ceiling catches one whale posing as a crowd. |
| Largest single buy | Someone taking real size is a different signal from fifty people nibbling. |
| Repeat buyers | Wallets that came back for a second buy. Conviction, not a glance. |
| Curve progress | How close to graduating — a genuine regime marker. |
| **Tracked wallets holding** | Whether one of the wallets your copy bot follows is already in it. The copy bot reads those balances every second anyway, so this is free — and it is the one signal here that nobody screening the same public data has. |

The sniper gains four **provenance** checks, which ask where a launch came from
rather than what it looks like. **All four are on by default.** Three cost an
RPC call on the entry path, so the sniper now spends about seven per candidate
rather than four — set any of them to 0 (or `false`) to switch one off, which
stops the call rather than just ignoring the answer.

| Check | Why |
|---|---|
| `MIN_HOLDERS` | Distinct holders. Free — reuses the read the concentration check already makes. |
| `REJECT_IF_DEPLOYER_EXITED` | `MAX_DEV_BUY_PCT` asks what the deployer took at creation. This asks whether they are **still in it**, which no check reading only the creation transaction can see. |
| `MIN_CREATOR_AGE_MINUTES` | Catches a *funded* throwaway wallet, which a balance check alone does not. |
| `MAX_LAUNCH_BUNDLE_TXS` | Organic interest arrives across slots; a bundle lands together — the signature of a launch whose first buyers are the deployer's own wallets. |

The shipped defaults are deliberately mild, because the real hazard in turning
these on is rejecting *everything*, which looks exactly like the bot being
broken: 2 holders (the sniper buys at creation, where the only holders are the
curve and the deployer), a 30-minute wallet age, and 6 transactions in the
creation slot. A test asserts an ordinary fresh launch passes all four on those
defaults.

All thirteen are tunable, so the auto-tuner can find thresholds for them from
your own trade history rather than you guessing.

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

Both sources fill in the launch's **name, symbol and metadata URI**. PumpPortal
sends them; the `rpc` source decodes them out of the create instruction's Borsh
arguments, using the transaction it already fetched to find the mint. It used to
omit all three, which was not a cosmetic gap: `metadata_sanity` failed for having
no name (−35) and `socials` failed for having no URI (−20), so every launch off
that feed scored 45 against a threshold of 70 and the sniper could never buy
anything at all.

#### Venues

PumpPortal no longer carries only pump.fun. Its feed now includes Mayhem, Bags,
Bonk, Moonshot and the rest, each identified by a `pool` field — and anything
unrecognised used to be relabelled `pump`, because that was a safe assumption
back when pump.fun was the only thing on the wire. It stopped being safe, and it
was not a neutral default: `pump` is the value that *disables* checks. A Mayhem
launch wearing it matched the screener's venue filter, had
`holder_concentration` waive itself on the grounds that bonding-curve
concentration means nothing, had `dev_buy_share` measure the deployer's stake
against pump.fun's fixed 1B supply, and had the executor ask PumpPortal to build
a pump.fun swap for a token that is not on pump.fun.

An unrecognised venue is now called `unknown`, logged once by name so you can see
which launchpads your feed is carrying, and refused. There is deliberately no
setting that admits `unknown` — a venue we could not identify is not one we
trade. A launch with **no** `pool` field at all still reads as `pump`, since
that is what the feed's own history says it means.

Each bot has its own allow-list, all defaulting to pump.fun only
(`SNIPE_ALLOWED_POOLS`, `SCREEN_ALLOWED_POOLS`, `COPY_ALLOWED_POOLS`). The
sniper's is new — it previously had no venue gate at all and took whatever the
feed handed it.

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

That cuts both ways, so the two mint reads have to be right about *when* they
look. Discovery detects launches at `processed` commitment — seeing the create
before it is confirmed is the entire point of it — so reading the mint back at
`confirmed` asked the node about an account it had not admitted to yet. It
answered "no such account", the check failed closed, and the buy was vetoed:

```
REJECT … freeze_authority(check errored: mint account not found or not an SPL mint)
```

The inversion is what made it expensive: the *faster* a launch was seen, the more
certain its rejection, so the filter was strictest on exactly the launches worth
having. `fetchMintInfo` now reads at `processed`, and looks a second time 300ms
later before treating "missing" as an answer, since a feed running off someone
else's node can be a slot ahead of yours. Reading early costs nothing in accuracy
here — pump.fun revokes both authorities inside the create transaction and they
can never come back.

The same check also decodes the mint itself rather than asking the node for
`jsonParsed`. That encoding depends on the endpoint recognising the program,
which not every endpoint does for Token-2022; when it does not, the account
arrives as raw base64 and the old code called a perfectly ordinary mint "not an
SPL mint" and vetoed it. Unpacking the 82-byte layout locally works on any
endpoint, covers both token programs, and puts less on the wire — which matters
when `getAccountInfo` is the busiest call the bot makes.

The metadata fetcher only resolves URIs on an allowlist of IPFS/Arweave hosts —
the URI comes from the attacker, and an unrestricted fetch is an SSRF hole and a
free way to stall every snipe. Redirects are followed by hand with the allowlist
re-checked at every hop, because IPFS gateways routinely 301 to a subdomain form:
refusing outright loses most tokens' metadata, and letting `fetch` follow them
hands the deployer the arbitrary-host request the allowlist exists to prevent.

`socials` distinguishes **"there is nothing there"** from **"we could not
look"**. A launch that declares no URI, or points at a host we will not fetch
from, has told us something about itself and is penalised. A gateway that
rate-limits us has told us something about our own afternoon, and is not — that
would make the filter stricter the worse your connectivity is, the same
inversion as reading a mint before the node has it. Public IPFS gateways
rate-limit constantly, so this is the common case rather than the rare one. The
cost is that a deployer parking metadata on a permanently-failing gateway dodges
the requirement; the alternative penalises every honest launch whenever ipfs.io
is having a bad hour.

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
| Only standard pump.fun launches | Default. `SNIPE_ALLOWED_POOLS=pump` and `SCREEN_ALLOWED_POOLS=pump` |

Ratchet exits (`EXIT_MODE=ratchet`):

| Want | Change |
|---|---|
| De-risk sooner, smaller moonbag | Lower `RECOVER_AT_GAIN_PCT` (60–80) |
| Turn capital over faster | Lower `CHECKPOINT_SECONDS` (30–45) |
| Cut drifters faster | Raise `RATCHET_MIN_PROGRESS_PCT` (3–5) |
| Hold a bigger runner | Lower `MOONBAG_TRIM_PCT` |
| Bound the downside again | Set `RATCHET_STOP_LOSS_PCT` (50–70 keeps the recovery upside) |
| Cut dead entries faster | Lower `RATCHET_FIRST_CHECKPOINT_SECONDS` (20–30) |
| Keep more of a move you already had | Lower `RATCHET_GIVEBACK_PCT` (20–30) |
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

Five things now handle it, in order of where they act:

1. **The cheap checks decide first.** The battery runs in two phases: everything
   that can be settled from the launch itself, the config or the local store
   (`duplicate_name`, `deployer_spam`, `dev_buy_share`, `deployer_history`,
   `curve_sanity`, `metadata_sanity`) runs before anything that costs a request.
   If those alone already put the score below `MIN_SAFETY_SCORE`, the launch is
   rejected without a single RPC call. Nothing is skipped that could have changed
   the answer — the remaining checks can only subtract from the score — and at
   peak most launches are copycat waves or serial-launcher spam that the free
   checks condemn anyway. The log says `[free checks only, no RPC spent]` when
   this happens.
2. Every RPC call passes through one throttle — a token bucket for sustained
   rate and a semaphore for burst (`RPC_MAX_CONCURRENT`). One caller cannot
   starve another.
3. **The rate is learned, not configured.** `RPC_MAX_REQUESTS_PER_SEC` is a
   ceiling. The bucket opens at half of it and then runs
   additive-increase/multiplicative-decrease: every 429 cuts the rate by 30%
   (once per burst, not once per response), and a quiet 20 seconds starts it
   creeping back up 1/s at a time. Nobody knows what their endpoint actually
   grants — the tier is undocumented, shared across three bots, and moves with
   load — and a fixed rate set above the real one does not fail gracefully,
   because each 429 costs a request slot on the way to being retried and the
   overshoot feeds itself. Hover the RPC chip to see the rate it has settled on.
4. A 429 or a 5xx is retried with exponential backoff and jitter
   (`RPC_MAX_RETRIES`), honouring `Retry-After` when the provider sends one.
   Jitter matters: without it every queued caller retries on the same beat and
   recreates the burst. web3.js's own 429 retry is switched off
   (`disableRetryOnRateLimit`) — two retry loops stacked on top of each other
   multiply rather than add, and its fixed 500ms delay ignores `Retry-After` and
   tells the throttle nothing.
5. The sniper evaluates at most `SNIPER_MAX_CONCURRENT_CHECKS` launches at once
   and **drops** the rest rather than queueing them. A launch that had to wait
   in line is one you are too late to buy anyway.

**Check timeouts allow for the queue.** A deadline measured from the moment a
check starts is really two budgets added together: the work, and however long
the throttle made it wait. Under load the second dominates, and a 1500ms check
needing 300ms of work dies having never issued its request — which is where
`mint_authority timed out after 1500ms` came from, and because that check fails
closed, it read as a rejected launch. Each check's `timeoutMs` is now a budget
for its own work; the engine adds current backpressure on top for the ones that
make requests.

**Find out which subsystem is spending the quota before turning anything down.**
Every RPC call is counted by its JSON-RPC method, and the method maps straight
onto a subsystem — so the log and the dashboard chip name the biggest spender
instead of leaving you to guess:

| Busiest method | That is | Turn down |
|---|---|---|
| `getTokenAccountsByOwner`, `getParsedTokenAccountsByOwner` | Copy trader reading tracked wallets | `COPY_POLL_INTERVAL_MS` (2000 is plenty), or track fewer wallets |
| `getMultipleAccounts` | Screener polling bonding curves | `SCREEN_POLL_MAX_TOKENS`, or raise `SCREEN_POLL_INTERVAL_MS` |
| `getSignaturesForAddress` | Sniper provenance checks | `MIN_CREATOR_AGE_MINUTES=0` and `MAX_LAUNCH_BUNDLE_TXS=0` |
| `getBalance` | Deployer-balance check, one per launch | `MIN_DEPLOYER_BALANCE_SOL=0`, or `SNIPER_MAX_CONCURRENT_CHECKS` |
| `getAccountInfo`, `getTokenLargestAccounts` | Sniper safety battery reading mints | `SNIPER_MAX_CONCURRENT_CHECKS` |
| `sendTransaction`, `getSignatureStatuses` | Trade execution | Nothing. This is the one thing worth spending quota on |

The chip shows the *share* of requests rate limited rather than a raw count, so
a number that climbs while the percentage stays flat is a bot that has simply
been running a long time.

Lowering `RPC_MAX_REQUESTS_PER_SEC` is **not** the fix it used to be — the
throttle already backs itself off, and lowering the ceiling only caps how fast
the bot can ever go once the endpoint recovers. If the chip stays high, the
number to look at is the settled rate in its tooltip: a rate sitting near the
floor means a free public endpoint that will rate-limit this workload whatever
the settings say, and a paid endpoint is the real fix.

**Why throttling is faster than not throttling.** It looks like a self-imposed
tax: why wait when you could fire and let the failures sort themselves out? The
arithmetic says otherwise. A queued request waits one slot in the bucket —
50ms at a 20/s cap — and then makes its round trip. A rejected one pays the
round trip, gets nothing, waits a backoff of 250ms to 4s (or whatever
`Retry-After` says, often a full second), and pays the round trip again. Three
to ten times worse, and providers escalate against repeat offenders, so it
degrades rather than settling.

The deeper problem is *where* the delay lands. Queueing spreads a small,
predictable wait across every call. Rejection lands a large one at random —
possibly on your sell. The provider will serve N requests a second whatever you
do; all you control is whether the excess is queued cheaply or rejected
expensively.

**The trade path skips the queue.** Fairness is the wrong policy: a sell queued
behind eighty curve reads is a worse price, while a curve read queued behind a
sell costs nothing. Buys and sells run inside `withRpcPriority`, which puts them
at the front of both the concurrency queue and the rate bucket — the bucket lets
them borrow against the limit and works the debt off afterwards, so background
polling absorbs the wait instead. The borrow is bounded, so a burst of exits
cannot overshoot the provider's cap outright. The flag propagates through every
`await` underneath, so the balance reads, blockhash, send and confirmation of a
sell all inherit it without any plumbing.

This is why raising your poll intervals costs you less than it sounds: the calls
that decide your P&L are no longer behind the ones that do not.

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
npm test           # 420 tests
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
