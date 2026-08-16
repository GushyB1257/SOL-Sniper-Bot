# Quickstart

Step by step, assuming you have never run a Node project before.

**Nothing in Part 1 or 2 can spend money.** Paper mode has no wallet key and
never signs a transaction. You could not lose funds in paper mode if you tried.

---

## Part 1 — Get it running (about 15 minutes)

### Step 1: Install Node.js

You need **Node 20.10 or newer**.

- **Windows / macOS**: download the LTS installer from
  [nodejs.org](https://nodejs.org) and run it.
- **Linux**: `sudo apt install nodejs npm` (or use
  [nvm](https://github.com/nvm-sh/nvm)).

Then open a terminal (macOS: Terminal; Windows: PowerShell) and check:

```bash
node --version
```

You want `v20.10.0` or higher. If you see "command not found", the installer
did not finish — restart your terminal first, then reinstall if needed.

### Step 2: Download the code

```bash
git clone https://github.com/GushyB1257/SOL-Sniper-Bot.git
cd SOL-Sniper-Bot
git checkout claude/sol-sniper-bot-axiom-5771ee
```

Every command from here runs **inside the `SOL-Sniper-Bot` folder**. If a
command errors with "no such file", you are probably in the wrong directory —
run `pwd` (macOS/Linux) or `cd` (Windows) to check.

### Step 3: Install the dependencies

```bash
npm install
```

Takes a minute. `npm warn deprecated` messages are normal and harmless.

### Step 4: Create your settings file

```bash
cp .env.example .env
```

Windows PowerShell: `Copy-Item .env.example .env`

This makes `.env`, your personal settings. It is gitignored, so it never gets
committed. The defaults are already set up for safe paper trading.

### Step 5: Get a free RPC endpoint

An RPC endpoint is your connection to the Solana blockchain. **Paper mode needs
one too** — that is how it reads real prices.

The default in the file is Solana's public endpoint. It is heavily rate-limited
and will drop requests, which for paper trading means missed price updates and
misleading results. A free tier from a real provider is much better:

1. Sign up at [helius.dev](https://helius.dev) (free tier is plenty for paper).
2. Copy your RPC URL — it looks like
   `https://mainnet.helius-rpc.com/?api-key=abc123...`
3. Open `.env` in any text editor (Notepad, TextEdit, VS Code) and set:

```ini
RPC_HTTP_URL=https://mainnet.helius-rpc.com/?api-key=your-key-here
RPC_WS_URL=wss://mainnet.helius-rpc.com/?api-key=your-key-here
```

Note `https` for the first and `wss` for the second.

### Step 6: Check everything works

```bash
npm run doctor
```

You want green ticks. It verifies your config parses, measures your RPC latency,
and checks the exit ladder arithmetic makes sense. A warning about RPC latency
is fine for paper trading. Errors are not — fix them before continuing.

### Step 7: Start it

```bash
npm run sniper
```

You will see a banner with your settings, then it starts watching for launches.

**Leave this terminal window open.** Closing it stops the bot.

### Step 8: Open the dashboard

Go to **http://127.0.0.1:4321** in your browser.

Empty at first. As launches come in you will see them screened and rejected in
the **Activity** tab — most get rejected, which is the filters working. When one
matches, a position appears and you can watch it work in real time.

The **Why entries were skipped** panel is the one to watch early on. It shows
which filter is turning tokens away, so if nothing is trading you can see the
reason immediately instead of guessing.

To stop the bot: click the terminal and press **Ctrl-C**.

### What it is actually looking for

The default strategy is a screener, not a predictor. It applies one filter to
every launch on the network continuously:

```
only pump standard coins  ·  ≥ $3k volume  ·  ≥ $6k market cap  ·  ≥ 1 social
```

and buys the moment a token matches. Tokens crossing that filter tend to pop for
a few seconds and then either crash, stall and crash, or bond. The bot is not
trying to tell those apart — it is trying to be in at the crossing and out
before the crash, over and over. Every one of those numbers is adjustable in
`.env`, and Step 10 is about finding better ones from your own data.

---

## Part 2 — Find out if it is actually profitable

This is the part that matters, and the part most people skip.

### What paper mode does and does not prove

Paper mode is a **forward test**, not a guess. Real launches, real safety
checks, and **real prices read live from each token's bonding curve**. If a
token you paper-bought rugs, your paper position rugs with it. Fills use the
exact constant-product maths the pump.fun program runs, so slippage and price
impact are modelled properly.

Three things it cannot know, and **all three flatter the results**:

1. **Whether your buy would have landed.** Sniping is a race decided by latency
   and priority fees. Paper mode assumes you got the price you saw. In reality
   you are often beaten to it.
2. **Whether anyone would have bought your exit.** Sells are priced off the
   curve, which always quotes. In a real rug, the bid disappears — a stop loss
   fills far worse than modelled, or does not fill at all.
3. **Your own market impact.** Your real buy would have moved the price.

So: **paper results are a ceiling, not an estimate.** Live will be worse. How
much worse depends on your latency and priority fees.

That asymmetry is exactly what makes the test useful. A losing paper result is
decisive — live cannot rescue it.

### Step 9: Let it run

Leave it running. Longer is better. Realistically:

| Runtime | What you get |
|---|---|
| A few hours | Confirms the plumbing works. Tells you nothing about profitability. |
| 2–3 days | An early read. Provisional. |
| 1–2 weeks | Enough to make a real decision. |

You need **trades**, not hours. Most launches get filtered out, but the screener
is far more permissive than the old strategy — expect entries through the day
rather than a handful. If you are getting none at all after an hour, check the
**Why entries were skipped** panel; one filter will be doing all the rejecting.

**To gather data faster in paper mode**, raise these in `.env` — there is no
real capital at risk, so the limits exist only to slow down data collection:

```ini
MAX_CONCURRENT_POSITIONS=12
HOURLY_SPEND_CAP_SOL=20
DAILY_LOSS_LIMIT_SOL=10
```

**Put them back to the defaults before you ever go live.**

If your computer sleeps, the bot stops. On a laptop, disable sleep, or run it on
a cheap VPS if you want continuous data.

### Step 10: Read the result

```bash
npm run report
```

Or use the dashboard, which shows the same numbers live.

**Ignore net P&L.** With a small sample it is dominated by whether you happened
to catch one big winner. Look at these instead:

**Profit factor** — gross wins ÷ gross losses. The single most important number.

| Value | Meaning |
|---|---|
| Below 1.0 | Losing money. Live will be worse. Do not fund it. |
| 1.0 – 1.3 | Marginal. Will not survive real-world slippage and missed fills. |
| Above 1.5 | Genuinely promising — on paper. |

**Exits by reason** — which rule is closing your positions, and what each one
earned:

| Mostly | What it means | Try |
|---|---|---|
| `time_stop` | You are buying tokens that go nowhere | Tighten `SCREEN_MIN_VOLUME_USD`, narrow `SCREEN_MAX_AGE_SECONDS` |
| `stop_loss` | You are buying the top of the pop | Lower `SCREEN_MAX_MCAP_USD` |
| `trailing_stop` with positive P&L | Working as designed — the give-back floor is banking gains | Nothing |
| `ladder` | Hitting the full target | Consider raising `SCALP_TARGET_NET_PCT` |

**The entry breakdowns** — the report splits your closed trades by entry market
cap, entry volume, age at entry, socials and hold time. This is the tuning loop:
find the bucket that is both large and losing money, and move that threshold.
For example, if `18k+` market caps are consistently negative while `8-12k` is
positive, lower `SCREEN_MAX_MCAP_USD`. Buckets marked `(thin)` have under 10
trades and mean nothing yet.

**Sample size** — the report tells you directly whether you have enough data.
Under ~30 trades it will refuse to draw a conclusion, and it is right to.

### Step 10b: Change one thing at a time

Adjust a single threshold, then delete `data/state.json` so the old trades do
not contaminate the new read, and run again. Changing three settings at once
tells you nothing about which one helped.

The settings worth trying first, roughly in order of how much they move the
result:

1. `SCALP_GIVEBACK_PCT` — 30 banks sooner and more often, 60 lets winners run.
2. `SCREEN_MAX_AGE_SECONDS=60` — only trade the first minute after launch.
3. `SCREEN_MAX_MCAP_USD` — lower stops you buying the top of the move.
4. `SCALP_TIME_STOP_SECONDS` — how long a flat position keeps its slot.

### Step 11: Decide

- **Profit factor below 1.0** → it does not work as configured. Tune the
  filters and ladder, then re-test from scratch. Do not fund it.
- **Marginal (1.0–1.3)** → not enough edge to survive going live. Keep tuning.
- **Comfortably above 1.5 over 100+ trades** → you have a paper result worth
  testing with a small amount of real money. Continue to Part 3.

There is no shame in the answer being "this does not work." That is a result
worth having, and it cost you nothing.

---

## Part 3 — Going live (only if Part 2 justified it)

**Read this whole section before doing any of it.**

### Step 12: Make a burner wallet

```bash
npm run wallet
```

This prints a brand-new keypair. **Never use a wallet that holds anything
else.** The private key goes in a plaintext file on a machine running networked
code — treat it as already compromised.

Copy the private key into `.env`:

```ini
WALLET_PRIVATE_KEY=<the private key it printed>
```

### Step 13: Fund it with an amount you are prepared to lose outright

Not "would rather not lose". **Lose.** Assume the entire balance goes to zero
and decide whether you would be fine. Send SOL to the public key it printed.

### Step 14: Switch to live

In `.env`:

```ini
MODE=live
EXECUTOR=onchain
```

**Do not shrink `BUY_AMOUNT_SOL` to feel safer.** This is the one place where
the instinct is actively wrong. The priority fee is a fixed cost per
transaction, so cutting the position size raises the move every trade needs
just to break even:

| `BUY_AMOUNT_SOL` | Round-trip breakeven move |
|---|---|
| 0.05 | 6.3% |
| 0.10 | 4.6% |
| 0.25 | 3.7% |
| 0.50 | 3.2% |

At 0.01 SOL the breakeven move is over 19% and the strategy cannot work at all.
Control your risk with `MAX_CONCURRENT_POSITIONS` and `DAILY_LOSS_LIMIT_SOL`,
which cap total exposure without breaking the arithmetic of each trade. Run
`npm run doctor` — it prints the exact numbers for your settings.

Sane live limits to start with:

```ini
BUY_AMOUNT_SOL=0.25
MAX_CONCURRENT_POSITIONS=3
HOURLY_SPEND_CAP_SOL=1.5
DAILY_LOSS_LIMIT_SOL=1
```

### Step 15: Pre-flight, then go

```bash
npm run doctor
```

It will refuse to bless a live config on the public RPC endpoint, and the config
loader rejects `MODE=live` with a missing key. Fix anything it flags.

```bash
npm run sniper
```

The banner will say **LIVE — REAL FUNDS** and the dashboard badge turns red.

### Step 16: Compare live against paper

After 20–30 live trades, run `npm run report` and compare with your paper
numbers. The gap between them is your real-world execution cost — missed races
and worse fills. If live profit factor is far below paper, that gap is the
problem, and the fix is latency and priority fees, not strategy tweaks.

---

## Controls and safety

| Action | How |
|---|---|
| Stop new entries immediately | Click **Kill switch** on the dashboard, or `touch STOP` |
| Resume | Click it again, or `rm STOP` |
| Force-sell one position | **Sell** button on that row |
| Stop the bot | **Ctrl-C** in the terminal |

**Ctrl-C does not sell your positions.** They are saved to `data/state.json` and
resumed when you restart. Dumping everything into a thin market because you
restarted is usually worse than holding. If you want out, sell from the
dashboard first, then stop.

The bot also stops itself: after hitting the daily loss limit, or after
`MAX_CONSECUTIVE_LOSSES` in a row (30-minute cooldown).

---

## Troubleshooting

**`command not found: npm`** — Node is not installed or not on your PATH.
Restart your terminal, then redo Step 1.

**`Invalid configuration:`** — the message names the exact setting. Common
causes: a missing RPC URL, or an exit ladder that sells more than 100%.

**Dashboard will not load** — check the bot is still running in the terminal.
If the port is taken, change `DASHBOARD_PORT` in `.env` and restart.

**No launches appearing** — check the Activity tab for connection errors. If the
websocket is failing, set `DISCOVERY_SOURCE=rpc` in `.env` to use your own RPC
instead of the public feed.

**Everything gets rejected** — that is the normal case; most launches are junk.
If literally nothing passes over several hours, lower `MIN_SAFETY_SCORE` to 60
or set `REQUIRE_SOCIALS=false` to loosen up.

**`no bonding curve on chain`** — the token was not readable when the buy was
attempted, usually a slow RPC. Frequent occurrences mean you need a better
endpoint.
