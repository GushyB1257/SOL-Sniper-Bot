/**
 * The dashboard page, inlined as a string.
 *
 * Kept as a TS module rather than a static asset so `npm run build` stays a
 * plain `tsc` invocation with no asset-copy step to get wrong. Nothing here
 * loads from the network — no CDN, no fonts, no images — so the page works
 * offline and the CSP can deny every external origin.
 *
 * Client script deliberately avoids backticks and template placeholders so it
 * can live inside this template literal without escaping.
 */
export function renderPage(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>SOL Sniper — Dashboard</title>
<style>
/* ---- Palette -----------------------------------------------------------
   Light values on :root; dark redefined under both the OS media query and an
   explicit [data-theme="dark"] stamp so the toggle wins in both directions. */
:root {
  color-scheme: light;
  --plane:      #f9f9f7;
  --surface:    #fcfcfb;
  --ink:        #0b0b0b;
  --ink-2:      #52514e;
  --muted:      #898781;
  --grid:       #e1e0d9;
  --baseline:   #c3c2b7;
  --border:     rgba(11,11,11,0.10);
  --series:     #2a78d6;
  --series-dim: #cde2fb;
  --good:       #0ca30c;
  --warning:    #fab219;
  --serious:    #ec835a;
  --critical:   #d03b3b;
  /* Profit / loss polarity. Green-red is the trading convention but fails
     colorblind separation, so the sign is always printed alongside and the
     CVD toggle swaps positive to the validated blue-red diverging pair. */
  --pos:        #0ca30c;
  --neg:        #d03b3b;
  --pos-wash:   rgba(12,163,12,0.10);
  --neg-wash:   rgba(208,59,59,0.10);
  --shadow:     0 1px 2px rgba(11,11,11,0.05);
}
:root[data-cvd="on"] { --pos: #2a78d6; --pos-wash: rgba(42,120,214,0.10); }

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --plane:      #0d0d0d;
    --surface:    #1a1a19;
    --ink:        #ffffff;
    --ink-2:      #c3c2b7;
    --muted:      #898781;
    --grid:       #2c2c2a;
    --baseline:   #383835;
    --border:     rgba(255,255,255,0.10);
    --series:     #3987e5;
    --series-dim: #184f95;
    --pos:        #0ca30c;
    --neg:        #d03b3b;
    --shadow:     0 1px 2px rgba(0,0,0,0.4);
  }
  :root:not([data-theme="light"])[data-cvd="on"] { --pos: #3987e5; --pos-wash: rgba(57,135,229,0.12); }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --plane:      #0d0d0d;
  --surface:    #1a1a19;
  --ink:        #ffffff;
  --ink-2:      #c3c2b7;
  --muted:      #898781;
  --grid:       #2c2c2a;
  --baseline:   #383835;
  --border:     rgba(255,255,255,0.10);
  --series:     #3987e5;
  --series-dim: #184f95;
  --pos:        #0ca30c;
  --neg:        #d03b3b;
  --shadow:     0 1px 2px rgba(0,0,0,0.4);
}
:root[data-theme="dark"][data-cvd="on"] { --pos: #3987e5; --pos-wash: rgba(57,135,229,0.12); }

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--plane);
  color: var(--ink);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1400px; margin: 0 auto; padding: 20px 24px 64px; }

/* ---- Top bar ---- */
.top {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 14px 18px; margin-bottom: 20px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; box-shadow: var(--shadow);
}
.brand { font-weight: 650; letter-spacing: -0.01em; margin-right: 4px; }
.spacer { flex: 1 1 auto; }
.badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 9px; border-radius: 999px;
  font-size: 11.5px; font-weight: 600; letter-spacing: 0.02em;
  border: 1px solid var(--border); color: var(--ink-2);
}
.badge.live   { color: #fff; background: var(--critical); border-color: transparent; }
.badge.paper  { color: var(--ink-2); background: transparent; }
.meta { color: var(--muted); font-size: 12.5px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.on  { background: var(--good); }
.dot.off { background: var(--critical); }

button {
  font: inherit; font-size: 12.5px; font-weight: 550;
  color: var(--ink-2); background: var(--surface);
  border: 1px solid var(--border); border-radius: 7px;
  padding: 5px 11px; cursor: pointer;
}
button:hover { background: var(--plane); color: var(--ink); }
button:focus-visible { outline: 2px solid var(--series); outline-offset: 2px; }
/* Destructive but secondary: the data should be the loud thing on the page,
   not a column of red blocks. Fills in only on hover. */
button.danger { color: var(--critical); border-color: var(--critical); background: transparent; padding: 3px 10px; }
button.danger:hover { color: #fff; background: var(--critical); }
button.armed  { color: #0b0b0b; background: var(--warning); border-color: transparent; }

/* ---- Cards & grid ---- */
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 16px 18px; box-shadow: var(--shadow);
}
.grid { display: grid; gap: 14px; margin-bottom: 14px; }
.g-hero { grid-template-columns: minmax(260px, 1fr) 2fr; }
.g-kpi  { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.g-half { grid-template-columns: 1.6fr 1fr; }
@media (max-width: 900px) {
  .g-hero, .g-half { grid-template-columns: 1fr; }
}

h2 {
  font-size: 12px; font-weight: 650; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--muted);
  margin: 0 0 12px;
}
.sub { font-size: 12px; color: var(--muted); font-weight: 400; text-transform: none; letter-spacing: 0; }

/* ---- Hero figure & stat tiles ---- */
.hero-val {
  font-size: 46px; line-height: 1.05; font-weight: 680;
  letter-spacing: -0.02em; margin: 2px 0 6px;
}
.tile-val {
  font-size: 24px; line-height: 1.2; font-weight: 640;
  letter-spacing: -0.01em; margin: 2px 0 2px;
}
.tile-note { font-size: 12px; color: var(--muted); }

/* Supporting figures under the hero number. */
.hero-stats { margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--grid); }
.hs-row { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; font-size: 12.5px; }
.hs-lab { color: var(--ink-2); }
.hs-val { font-variant-numeric: tabular-nums; color: var(--ink); }

/* Keep long histories from stretching the page past its neighbour column. */
.panel-scroll { max-height: 520px; overflow-y: auto; overflow-x: auto; }
.panel-scroll thead th { position: sticky; top: 0; background: var(--surface); z-index: 1; }
.pos { color: var(--pos); }
.neg { color: var(--neg); }
.num { font-variant-numeric: tabular-nums; }

/* ---- Meters (ratio against a limit) ---- */
.meter + .meter { margin-top: 14px; }
.meter-head { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; margin-bottom: 6px; }
.meter-head .lab { color: var(--ink-2); }
.meter-head .val { color: var(--ink); font-variant-numeric: tabular-nums; }
.track { height: 8px; border-radius: 999px; background: var(--grid); overflow: hidden; }
.fill  { height: 100%; border-radius: 999px; background: var(--series); transition: width .3s ease; }
.fill.warn { background: var(--warning); }
.fill.crit { background: var(--critical); }

/* ---- Tables ---- */
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left; font-size: 11px; font-weight: 620; text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--muted);
  padding: 0 10px 8px; white-space: nowrap;
  border-bottom: 1px solid var(--grid);
}
td { padding: 9px 10px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--plane); }
th.r, td.r { text-align: right; }
.mono { font-variant-numeric: tabular-nums; }
.sym { font-weight: 620; }
.mint {
  font-size: 11px; color: var(--muted); cursor: pointer;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.mint:hover { color: var(--series); }
.empty { color: var(--muted); padding: 28px 10px; text-align: center; font-size: 13px; }

/* ---- Ladder pips ---- */
.pips { display: inline-flex; gap: 3px; align-items: center; }
.pip {
  width: 20px; height: 8px; border-radius: 3px;
  background: transparent; border: 1px solid var(--baseline);
}
.pip.filled { background: var(--series); border-color: var(--series); }
.pip.moon   { background: var(--warning); border-color: var(--warning); }

/* ---- Horizontal bar rows (exit reasons) ---- */
.bar-row { display: grid; grid-template-columns: 116px 1fr 62px; gap: 10px; align-items: center; margin-bottom: 9px; }
.bar-lab { font-size: 12.5px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; }
.bar-track { height: 100%; }
/* 4px rounded data-end, square at the baseline. Capped thickness. */
.bar { height: 18px; max-height: 24px; border-radius: 0 4px 4px 0; background: var(--series); min-width: 2px; }
.bar-val { font-size: 12.5px; text-align: right; font-variant-numeric: tabular-nums; color: var(--ink-2); }

/* ---- Chart ---- */
.chart-holder { position: relative; }
svg { display: block; width: 100%; height: auto; overflow: visible; }
.tip {
  position: absolute; pointer-events: none; opacity: 0;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 7px; padding: 7px 10px; font-size: 12px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.12); transition: opacity .12s;
  white-space: nowrap; z-index: 10;
}
.tip .t-sym { font-weight: 620; }
.tip .t-row { color: var(--ink-2); font-variant-numeric: tabular-nums; }

/* ---- Tabs ---- */
.tabs { display: flex; gap: 4px; margin-bottom: 12px; flex-wrap: wrap; }
.tab {
  font-size: 12.5px; font-weight: 550; padding: 5px 11px;
  border-radius: 7px; border: 1px solid transparent;
  background: transparent; color: var(--muted); cursor: pointer;
}
.tab:hover { color: var(--ink); }
.tab[aria-selected="true"] { color: var(--ink); background: var(--plane); border-color: var(--border); }

/* ---- Config & log ---- */
.cfg-group { margin-bottom: 18px; }
.cfg-group h3 {
  font-size: 11px; font-weight: 620; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--muted); margin: 0 0 6px; padding-bottom: 5px; border-bottom: 1px solid var(--grid);
}
.cfg-row { display: flex; justify-content: space-between; gap: 16px; padding: 4px 0; font-size: 12.5px; }
.cfg-key { color: var(--ink-2); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.cfg-val { color: var(--ink); text-align: right; font-variant-numeric: tabular-nums; word-break: break-word; }
.log { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 1.75; max-height: 460px; overflow-y: auto; }
.log-line { display: flex; gap: 10px; }
.log-ts { color: var(--muted); flex: none; }
.log-scope { color: var(--muted); flex: none; min-width: 120px; }
.log-msg { color: var(--ink-2); word-break: break-word; }
.lvl-warn  .log-msg { color: var(--serious); }
.lvl-error .log-msg { color: var(--critical); }

.banner {
  padding: 10px 14px; border-radius: 8px; margin-bottom: 14px;
  font-size: 13px; display: flex; align-items: center; gap: 9px;
  border: 1px solid var(--border);
}
.banner.warn { background: var(--neg-wash); color: var(--ink); }

/* ---- Bot switcher ---- */
.botbar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.botbtn {
  display: flex; align-items: center; gap: 9px;
  padding: 10px 14px; border-radius: 10px; cursor: pointer;
  background: var(--surface); border: 1px solid var(--border);
  box-shadow: var(--shadow); font-size: 13px; font-weight: 550; color: var(--ink-2);
}
.botbtn:hover { color: var(--ink); }
.botbtn[aria-selected="true"] { color: var(--ink); border-color: var(--series); }
.botbtn .bname { font-weight: 620; }
.botbtn .bpnl { font-variant-numeric: tabular-nums; font-weight: 500; }
.botctl { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.botctl .state { font-size: 12.5px; color: var(--muted); }
/* The status is a label, not a button. Reading the state off an action button
   ("Stop X" — so is it running or not?) is a coin flip, so it gets its own
   pill and the button only ever says what pressing it will do. */
.status {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 5px 12px; border-radius: 999px;
  font-size: 12px; font-weight: 650; letter-spacing: 0.04em;
  border: 1px solid var(--border);
}
.status.run  { color: var(--good); background: var(--pos-wash); border-color: transparent; }
.status.stop { color: var(--muted); }
.status.hold { color: #0b0b0b; background: var(--warning); border-color: transparent; }

/* ---- Settings form ---- */
.set-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px 18px; }
.set-field { display: flex; flex-direction: column; gap: 4px; }
.set-field label { font-size: 12px; color: var(--ink-2); font-weight: 550; }
.set-field .help { font-size: 11.5px; color: var(--muted); line-height: 1.4; }
.set-field input, .set-field select {
  font: inherit; font-size: 13px; padding: 6px 9px;
  color: var(--ink); background: var(--plane);
  border: 1px solid var(--border); border-radius: 7px; width: 100%;
}
.set-field input:focus, .set-field select:focus { outline: 2px solid var(--series); outline-offset: 1px; }
.set-field.changed input, .set-field.changed select { border-color: var(--warning); }
.set-actions {
  display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--grid);
}
.set-msg { font-size: 12.5px; }
.set-msg.ok { color: var(--good); }
.set-msg.err { color: var(--critical); }
button.primary { color: #fff; background: var(--series); border-color: transparent; font-weight: 600; }
button.primary:hover { filter: brightness(1.08); color: #fff; }
.wallet-row { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; font-size: 12.5px; border-bottom: 1px solid var(--grid); }
.wallet-row:last-child { border-bottom: none; }
.wallet-addr { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: var(--ink-2); }
.hidden { display: none !important; }
.vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
</head>
<body>
<div class="wrap">

  <div class="top">
    <span class="brand">SOL Sniper</span>
    <span class="badge" id="modeBadge">—</span>
    <span class="meta" id="topMeta"></span>
    <span class="spacer"></span>
    <span class="dot" id="connDot" title="connection"></span>
    <span class="meta" id="connText">connecting…</span>
    <button id="cvdBtn" title="Swap profit green for a colorblind-safe blue">CVD</button>
    <button id="themeBtn" title="Toggle light/dark">Theme</button>
    <button id="killBtn">Kill switch</button>
  </div>

  <div class="botbar" id="botBar" role="tablist"></div>

  <div class="botctl">
    <span class="status" id="botStatus">—</span>
    <button id="botToggle">—</button>
    <button id="botPause">—</button>
    <span class="state" id="botState"></span>
    <span class="set-msg" id="botMsg"></span>
  </div>

  <div id="banners"></div>

  <div class="grid g-hero">
    <div class="card">
      <h2>Net P&amp;L <span class="sub">realised + open</span></h2>
      <div class="hero-val num" id="heroPnl">—</div>
      <div class="tile-note" id="heroSub">waiting for data</div>
      <div class="hero-stats" id="heroStats"></div>
    </div>
    <div class="card chart-holder">
      <h2>Equity curve <span class="sub" id="eqSub">cumulative realised P&amp;L per closed trade</span></h2>
      <div id="eqChart"></div>
      <div class="tip" id="eqTip"></div>
    </div>
  </div>

  <div class="grid g-kpi">
    <div class="card"><h2>Win rate</h2><div class="tile-val num" id="kWin">—</div><div class="tile-note" id="kWinSub">—</div></div>
    <div class="card"><h2>Profit factor</h2><div class="tile-val num" id="kPf">—</div><div class="tile-note">gross wins ÷ losses</div></div>
    <div class="card"><h2>Today</h2><div class="tile-val num" id="kToday">—</div><div class="tile-note" id="kTodaySub">—</div></div>
    <div class="card"><h2>Open</h2><div class="tile-val num" id="kOpen">—</div><div class="tile-note" id="kOpenSub">—</div></div>
    <div class="card"><h2>Wallet</h2><div class="tile-val num" id="kWallet">—</div><div class="tile-note" id="kWalletSub">—</div></div>
    <div class="card"><h2>Seen</h2><div class="tile-val num" id="kSeen">—</div><div class="tile-note" id="kSeenSub">—</div></div>
  </div>

  <div class="grid g-half hidden" id="copyRow">
    <div class="card">
      <h2>Tracked wallets</h2>
      <div id="copyWallets"></div>
    </div>
    <div class="card">
      <h2>Why buys were skipped <span class="sub">per wallet trade seen</span></h2>
      <div id="copySkips"></div>
    </div>
  </div>

  <div class="grid g-half hidden" id="aiRow">
    <div class="card">
      <h2>Funnel <span class="sub" id="aiModel"></span></h2>
      <div id="aiStats"></div>
    </div>
    <div class="card">
      <h2 id="aiRightTitle">AI spend <span class="sub">estimated, at list prices</span></h2>
      <div id="aiSpend"></div>
    </div>
  </div>

  <div class="grid g-half">
    <div class="card">
      <h2>Open positions</h2>
      <div class="scroll"><table>
        <thead><tr>
          <th>Token</th><th class="r">Age</th><th class="r">Cost</th>
          <th class="r">MCap in → now</th>
          <th class="r">Entry → Now</th><th class="r">Gain</th><th class="r">P&amp;L</th>
          <th class="r">Left</th><th>State</th><th class="r" id="thStopCol">To stop</th><th class="r">Safety</th><th></th>
        </tr></thead>
        <tbody id="posBody"></tbody>
      </table></div>
    </div>
    <div class="card">
      <h2>Risk limits</h2>
      <div id="meters"></div>
    </div>
  </div>

  <div class="grid g-half">
    <div class="card">
      <div class="tabs" role="tablist">
        <button class="tab" role="tab" data-tab="trades" aria-selected="true">Trades</button>
        <button class="tab" role="tab" data-tab="settings" aria-selected="false">Settings</button>
        <button class="tab" role="tab" data-tab="config" aria-selected="false">All config</button>
        <button class="tab" role="tab" data-tab="log" aria-selected="false">Activity</button>
      </div>
      <div id="tab-trades">
        <div class="scroll panel-scroll"><table>
          <thead><tr>
            <th>Token</th><th class="r">Cost</th><th class="r">Proceeds</th>
            <th class="r">P&amp;L</th><th class="r">%</th><th class="r">Held</th><th>Exit</th><th class="r">Safety</th>
          </tr></thead>
          <tbody id="tradeBody"></tbody>
        </table></div>
      </div>
      <div id="tab-settings" class="hidden">
        <div id="setForm"></div>
        <div class="set-actions">
          <button class="primary" id="setSave">Save changes</button>
          <button id="setRevert">Revert</button>
          <button id="setReset" class="danger">Reset all to .env</button>
          <span class="set-msg" id="setMsg"></span>
        </div>
      </div>
      <div id="tab-config" class="hidden"></div>
      <div id="tab-log" class="hidden"><div class="log" id="logBody"></div></div>
    </div>
    <div class="card">
      <h2>Exits by reason <span class="sub">why positions closed</span></h2>
      <div id="reasons"></div>
    </div>
  </div>

</div>

<script>
(function () {
  'use strict';
  var TOKEN = ${JSON.stringify(token)};
  var snap = null;

  // ---- helpers ---------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function signed(n, dp) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    dp = dp === undefined ? 4 : dp;
    return (n >= 0 ? '+' : '\\u2212') + Math.abs(n).toFixed(dp);
  }
  function plain(n, dp) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return n.toFixed(dp === undefined ? 4 : dp);
  }
  function signClass(n) { return n > 0 ? 'pos' : (n < 0 ? 'neg' : ''); }
  function dur(s) {
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
  }
  function price(p) {
    if (!isFinite(p) || p <= 0) return '—';
    return p < 0.0001 ? p.toExponential(2) : p.toFixed(6);
  }
  function usdShort(n) {
    if (n === null || n === undefined || !isFinite(n) || n <= 0) return '\u2014';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'k';
    return '$' + Math.round(n);
  }
  function clock(ts) {
    var d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' +
           String(d.getMinutes()).padStart(2, '0') + ':' +
           String(d.getSeconds()).padStart(2, '0');
  }
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sniper-Token': TOKEN },
      body: JSON.stringify(body || {})
    });
  }

  // ---- equity curve ----------------------------------------------------
  // Single series, so no legend: the heading names what is plotted. Zero
  // baseline is drawn because the value crosses it. Endpoint is the only
  // direct label; the trades table is the table view of the same data.
  var eqPts = [];
  function drawEquity(equity) {
    var host = $('eqChart');
    host.innerHTML = '';
    eqPts = [];

    if (!equity || equity.length === 0) {
      var e = el('div', 'empty', 'No closed trades yet — the curve starts after the first exit.');
      host.appendChild(e);
      return;
    }

    var W = 720, H = 190, PL = 8, PR = 54, PT = 12, PB = 20;
    var vals = equity.map(function (d) { return d.cum; });
    var lo = Math.min(0, Math.min.apply(null, vals));
    var hi = Math.max(0, Math.max.apply(null, vals));
    if (hi === lo) { hi = lo + 0.001; }
    var pad = (hi - lo) * 0.12;
    lo -= pad; hi += pad;

    var n = equity.length;
    function X(i) { return PL + (n === 1 ? 0 : (i / (n - 1)) * (W - PL - PR)); }
    function Y(v) { return PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB); }

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    var last = equity[n - 1].cum;
    svg.setAttribute('aria-label',
      'Cumulative realised profit and loss across ' + n + ' closed trades, ending at ' +
      signed(last, 4) + ' SOL. Full values are listed in the trades table.');

    function mk(tag, attrs) {
      var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (var k in attrs) { if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, attrs[k]); }
      return node;
    }

    // Area wash under the line, at ~10% opacity.
    var zeroY = Y(0);
    var dArea = 'M ' + X(0) + ' ' + zeroY;
    for (var i = 0; i < n; i++) dArea += ' L ' + X(i) + ' ' + Y(equity[i].cum);
    dArea += ' L ' + X(n - 1) + ' ' + zeroY + ' Z';
    svg.appendChild(mk('path', { d: dArea, fill: 'var(--series)', 'fill-opacity': '0.10' }));

    // Zero baseline — the reference the value is read against.
    svg.appendChild(mk('line', {
      x1: PL, y1: zeroY, x2: W - PR, y2: zeroY,
      stroke: 'var(--baseline)', 'stroke-width': '1'
    }));

    var dLine = '';
    for (var j = 0; j < n; j++) dLine += (j === 0 ? 'M ' : ' L ') + X(j) + ' ' + Y(equity[j].cum);
    svg.appendChild(mk('path', {
      d: dLine, fill: 'none', stroke: 'var(--series)',
      'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
    }));

    // Endpoint marker: 2px surface ring keeps it legible over the line.
    var ex = X(n - 1), ey = Y(last);
    svg.appendChild(mk('circle', {
      cx: ex, cy: ey, r: '4.5',
      fill: 'var(--series)', stroke: 'var(--surface)', 'stroke-width': '2'
    }));
    var lab = mk('text', {
      x: ex + 9, y: ey + 4, fill: 'var(--ink)',
      'font-size': '12.5', 'font-weight': '620',
      'font-family': 'system-ui, -apple-system, sans-serif'
    });
    lab.textContent = signed(last, 3);
    svg.appendChild(lab);

    var cross = mk('line', {
      y1: PT, y2: H - PB, stroke: 'var(--baseline)', 'stroke-width': '1', opacity: '0'
    });
    svg.appendChild(cross);
    var hoverDot = mk('circle', {
      r: '4.5', fill: 'var(--series)', stroke: 'var(--surface)', 'stroke-width': '2', opacity: '0'
    });
    svg.appendChild(hoverDot);

    for (var k = 0; k < n; k++) eqPts.push({ x: X(k), y: Y(equity[k].cum), d: equity[k] });

    var tip = $('eqTip');
    svg.addEventListener('mousemove', function (ev) {
      var box = svg.getBoundingClientRect();
      var vx = ((ev.clientX - box.left) / box.width) * W;
      var best = null, bd = Infinity;
      for (var m = 0; m < eqPts.length; m++) {
        var dd = Math.abs(eqPts[m].x - vx);
        if (dd < bd) { bd = dd; best = eqPts[m]; }
      }
      if (!best) return;
      cross.setAttribute('x1', best.x); cross.setAttribute('x2', best.x);
      cross.setAttribute('opacity', '1');
      hoverDot.setAttribute('cx', best.x); hoverDot.setAttribute('cy', best.y);
      hoverDot.setAttribute('opacity', '1');

      tip.innerHTML = '';
      tip.appendChild(el('div', 't-sym', best.d.symbol));
      tip.appendChild(el('div', 't-row', 'trade P&L  ' + signed(best.d.pnl, 4) + ' SOL'));
      tip.appendChild(el('div', 't-row', 'cumulative ' + signed(best.d.cum, 4) + ' SOL'));
      tip.appendChild(el('div', 't-row', new Date(best.d.t).toLocaleString()));
      tip.style.opacity = '1';
      var px = (best.x / W) * box.width;
      var host2 = host.getBoundingClientRect();
      var top = box.top - host2.top + (best.y / H) * box.height;
      tip.style.left = Math.min(Math.max(px + 14, 0), box.width - 170) + 'px';
      tip.style.top = Math.max(top - 40, 0) + 'px';
    });
    svg.addEventListener('mouseleave', function () {
      tip.style.opacity = '0';
      cross.setAttribute('opacity', '0');
      hoverDot.setAttribute('opacity', '0');
    });

    host.appendChild(svg);
  }

  // ---- meters ----------------------------------------------------------
  function meter(label, valueText, ratio, note) {
    var wrap = el('div', 'meter');
    var head = el('div', 'meter-head');
    head.appendChild(el('span', 'lab', label));
    head.appendChild(el('span', 'val', valueText));
    wrap.appendChild(head);
    var track = el('div', 'track');
    var fill = el('div', 'fill');
    var r = Math.max(0, Math.min(1, ratio));
    fill.style.width = (r * 100).toFixed(1) + '%';
    if (r >= 1) fill.className = 'fill crit';
    else if (r >= 0.75) fill.className = 'fill warn';
    track.appendChild(fill);
    wrap.appendChild(track);
    if (note) { var nn = el('div', 'tile-note', note); nn.style.marginTop = '4px'; wrap.appendChild(nn); }
    return wrap;
  }

  function renderMeters(r) {
    var host = $('meters');
    host.innerHTML = '';
    var lossUsed = Math.max(0, -r.todayPnlSol);
    host.appendChild(meter(
      'Daily loss', plain(lossUsed, 3) + ' / ' + plain(r.dailyLossLimitSol, 2) + ' SOL',
      r.dailyLossLimitSol > 0 ? lossUsed / r.dailyLossLimitSol : 0,
      lossUsed >= r.dailyLossLimitSol ? 'Limit reached — no new entries today.' : null));
    host.appendChild(meter(
      'Hourly spend', plain(r.spendLastHourSol, 3) + ' / ' + plain(r.hourlySpendCapSol, 2) + ' SOL',
      r.hourlySpendCapSol > 0 ? r.spendLastHourSol / r.hourlySpendCapSol : 0, null));
    host.appendChild(meter(
      'Open positions', r.openPositions + ' / ' + r.maxConcurrentPositions,
      r.maxConcurrentPositions > 0 ? r.openPositions / r.maxConcurrentPositions : 0, null));
    host.appendChild(meter(
      'Loss streak', r.consecutiveLosses + ' / ' + r.maxConsecutiveLosses,
      r.maxConsecutiveLosses > 0 ? r.consecutiveLosses / r.maxConsecutiveLosses : 0,
      r.breakerActive ? 'Breaker active until ' + new Date(r.breakerUntil).toLocaleTimeString() : null));
  }

  // ---- positions -------------------------------------------------------
  function renderPositions(list) {
    var body = $('posBody');
    body.innerHTML = '';
    // Header follows the exit mode, so the column never lies about what the
    // number underneath it means.
    var th = $('thStopCol');
    if (th) {
      th.textContent =
        list && list.length && list[0].nextCheckpointSeconds !== null ? 'Checkpoint' : 'To stop';
    }
    if (!list || list.length === 0) {
      var tr = el('tr');
      var td = el('td', 'empty', 'No open positions.');
      td.colSpan = 12;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    list.forEach(function (p) {
      var tr = el('tr');

      var tdTok = el('td');
      var sym = el('div', 'sym', p.symbol);
      tdTok.appendChild(sym);
      var mint = el('div', 'mint', p.mint.slice(0, 10) + '…');
      mint.title = 'Click to copy ' + p.mint;
      mint.addEventListener('click', function () {
        navigator.clipboard.writeText(p.mint).then(function () {
          mint.textContent = 'copied';
          setTimeout(function () { mint.textContent = p.mint.slice(0, 10) + '\\u2026'; }, 900);
        });
      });
      tdTok.appendChild(mint);
      if (p.copiedFrom) {
        var src = el('div', 'mint', 'copy ' + p.copiedFrom.slice(0, 8) + '\u2026');
        src.title = 'Mirroring ' + p.copiedFrom;
        tdTok.appendChild(src);
      }
      if (p.notes && p.notes.length) tdTok.title = p.notes.join('\\n');
      tr.appendChild(tdTok);

      tr.appendChild(el('td', 'r mono', dur(p.ageSeconds)));
      tr.appendChild(el('td', 'r mono', plain(p.costSol, 4)));

      // The cap you bought at, next to the cap now. That pair is the whole
      // story of a memecoin position, and the entry number cannot be
      // reconstructed later once tokens have been sold.
      var tdM = el('td', 'r mono');
      if (p.entryMarketCapUsd) {
        tdM.appendChild(el('span', null, usdShort(p.entryMarketCapUsd)));
        if (p.marketCapUsd) {
          tdM.appendChild(el('span', signClass(p.marketCapUsd - p.entryMarketCapUsd),
            ' \u2192 ' + usdShort(p.marketCapUsd)));
        }
        tdM.title = 'Bought at ' + usdShort(p.entryMarketCapUsd) + ' market cap';
      } else {
        tdM.textContent = '\u2014';
      }
      tr.appendChild(tdM);

      tr.appendChild(el('td', 'r mono', price(p.entryPrice) + ' → ' + price(p.lastPrice)));

      var tdG = el('td', 'r mono ' + signClass(p.gainPct), signed(p.gainPct, 1) + '%');
      tr.appendChild(tdG);
      var tdP = el('td', 'r mono ' + signClass(p.pnlSol), signed(p.pnlSol, 4));
      tr.appendChild(tdP);
      tr.appendChild(el('td', 'r mono', p.remainingPct.toFixed(0) + '%'));

      var tdL = el('td');
      if (p.nextCheckpointSeconds !== null) {
        // Ratchet mode: the ladder is meaningless here, and the only thing that
        // matters is whether this beats its last checkpoint before the clock
        // runs out. Show that, not a stop that does not exist.
        var state = el('div', 'mono' + (p.costRecovered ? ' pos' : ''),
          p.costRecovered ? 'FREE RIDE' : 'proving');
        state.title = p.costRecovered
          ? 'Stake already recovered — everything still held is profit'
          : 'Stake still at risk; must clear fees by the next checkpoint';
        tdL.appendChild(state);
      } else {
        var pips = el('div', 'pips');
        p.ladder.forEach(function (t) {
          var pip = el('span', 'pip' + (t.filled ? ' filled' : ''));
          pip.title = '+' + t.gainPct + '% → sell ' + t.sellPctOfOriginal + '%' + (t.filled ? ' (filled)' : '');
          pips.appendChild(pip);
        });
        if (p.moonbagArmed) {
          var moon = el('span', 'pip moon');
          moon.title = 'Moonbag armed — ladder complete, remainder riding a trailing stop';
          pips.appendChild(moon);
        }
        tdL.appendChild(pips);
      }
      tr.appendChild(tdL);

      if (p.nextCheckpointSeconds !== null) {
        var need = p.checkpointPrice > 0 ? ((p.lastPrice / p.checkpointPrice) - 1) * 100 : 0;
        var tdC = el('td', 'r mono ' + (need > 0 ? 'pos' : 'neg'),
          Math.ceil(p.nextCheckpointSeconds) + 's / ' + signed(need, 1) + '%');
        tdC.title = need > 0
          ? 'Ahead of the last checkpoint — survives when the clock runs out'
          : 'Behind the last checkpoint — closes when the clock runs out';
        tr.appendChild(tdC);
      } else {
        tr.appendChild(el('td', 'r mono', signed(p.distanceToStopPct, 1) + '%'));
      }
      tr.appendChild(el('td', 'r mono', p.safetyScore));

      var tdA = el('td', 'r');
      var btn = el('button', 'danger', 'Sell');
      btn.title = 'Force-sell the whole position now';
      btn.addEventListener('click', function () {
        if (!window.confirm('Sell all of ' + p.symbol + ' now?')) return;
        btn.disabled = true;
        btn.textContent = '…';
        post('/api/positions/close', { id: p.id }).catch(function () {
          btn.disabled = false;
          btn.textContent = 'Sell';
        });
      });
      tdA.appendChild(btn);
      tr.appendChild(tdA);

      body.appendChild(tr);
    });
  }

  // ---- trades ----------------------------------------------------------
  function renderTrades(list) {
    var body = $('tradeBody');
    body.innerHTML = '';
    if (!list || list.length === 0) {
      var tr = el('tr');
      var td = el('td', 'empty', 'No closed trades yet.');
      td.colSpan = 8;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    list.forEach(function (t) {
      var row = el('tr');
      var tdTok = el('td');
      tdTok.appendChild(el('div', 'sym', t.symbol || t.mint.slice(0, 6)));
      tdTok.appendChild(el('div', 'mint', new Date(t.closedAt).toLocaleTimeString()));
      row.appendChild(tdTok);
      row.appendChild(el('td', 'r mono', plain(t.costSol, 4)));
      row.appendChild(el('td', 'r mono', plain(t.proceedsSol, 4)));
      row.appendChild(el('td', 'r mono ' + signClass(t.pnlSol), signed(t.pnlSol, 4)));
      row.appendChild(el('td', 'r mono ' + signClass(t.pnlSol), signed(t.pnlPct, 1) + '%'));
      row.appendChild(el('td', 'r mono', dur(t.holdSeconds)));
      var reason = el('td', null, (t.closeReason || '').split(':')[0]);
      reason.title = t.closeReason || '';
      row.appendChild(reason);
      row.appendChild(el('td', 'r mono', t.safetyScore));
      body.appendChild(row);
    });
  }

  // ---- exit reasons (horizontal bars, single hue) -----------------------
  function renderReasons(list) {
    var host = $('reasons');
    host.innerHTML = '';
    if (!list || list.length === 0) {
      host.appendChild(el('div', 'empty', 'Nothing has closed yet.'));
      return;
    }
    var max = list.reduce(function (m, r) { return Math.max(m, r.count); }, 1);
    list.forEach(function (r) {
      var row = el('div', 'bar-row');
      var lab = el('div', 'bar-lab', r.reason.replace(/_/g, ' '));
      lab.title = r.reason;
      row.appendChild(lab);
      var track = el('div', 'bar-track');
      var bar = el('div', 'bar');
      bar.style.width = Math.max(2, (r.count / max) * 100) + '%';
      bar.title = r.count + ' exits, ' + signed(r.pnlSol, 4) + ' SOL';
      track.appendChild(bar);
      row.appendChild(track);
      // Value at the tip, plus the P&L that reason produced.
      var v = el('div', 'bar-val');
      v.appendChild(el('span', null, r.count));
      var pnl = el('span', signClass(r.pnlSol));
      pnl.textContent = ' ' + signed(r.pnlSol, 2);
      pnl.style.fontSize = '11px';
      v.appendChild(pnl);
      row.appendChild(v);
      host.appendChild(row);
    });
  }

  // ---- config & log ----------------------------------------------------
  function renderConfig(rows) {
    var host = $('tab-config');
    host.innerHTML = '';
    var groups = {};
    var order = [];
    rows.forEach(function (r) {
      if (!groups[r.group]) { groups[r.group] = []; order.push(r.group); }
      groups[r.group].push(r);
    });
    order.forEach(function (g) {
      var box = el('div', 'cfg-group');
      box.appendChild(el('h3', null, g));
      groups[g].forEach(function (r) {
        var row = el('div', 'cfg-row');
        row.appendChild(el('span', 'cfg-key', r.key));
        row.appendChild(el('span', 'cfg-val', r.value));
        box.appendChild(row);
      });
      host.appendChild(box);
    });
    var note = el('div', 'tile-note',
      'Read-only. Edit .env and restart to change these. Private key is never sent to this page and RPC credentials are redacted.');
    host.appendChild(note);
  }

  function renderLog(lines) {
    var host = $('logBody');
    host.innerHTML = '';
    if (!lines || lines.length === 0) { host.appendChild(el('div', 'empty', 'No activity yet.')); return; }
    lines.forEach(function (l) {
      var row = el('div', 'log-line lvl-' + l.level);
      row.appendChild(el('span', 'log-ts', clock(l.ts)));
      row.appendChild(el('span', 'log-scope', l.scope));
      row.appendChild(el('span', 'log-msg', l.msg));
      host.appendChild(row);
    });
  }

  // ---- banners ---------------------------------------------------------
  function renderBanners(s, bot) {
    var host = $('banners');
    host.innerHTML = '';
    function add(text) {
      var n = el('div', 'banner warn');
      n.appendChild(el('span', null, text));
      host.appendChild(n);
    }
    // The kill switch is global; everything else is this bot's own limit, so
    // the wording says which so a paused screener is not read as a dead bot.
    if (s.killSwitch) add('Kill switch engaged — no new entries on ANY bot. Open positions are still managed.');
    if (!bot.enabled) add(bot.name + ' is stopped. Open positions are still managed and can be closed here.');
    else if (bot.paused) add(bot.name + ' is paused — no new entries.');
    // The case that reads as a broken bot: it IS running, it just has nothing
    // to follow, so the tab looks identical to one that never started.
    else if (bot.copy && bot.copy.tracking === 0) {
      add(bot.name + ' is RUNNING but has no wallets to track, so it will never trade. ' +
          'Add addresses under Settings on this tab.');
    } else if (bot.copy && bot.copy.polls === 0) {
      add(bot.name + ' is running but has not completed a wallet read yet — ' +
          'if this persists, your RPC is not answering.');
    }
    if (bot.risk.breakerActive) {
      add(bot.name + ': circuit breaker active until ' +
          new Date(bot.risk.breakerUntil).toLocaleTimeString() +
          ' after ' + bot.risk.maxConsecutiveLosses + ' consecutive losses.');
    }
    if (-bot.risk.todayPnlSol >= bot.risk.dailyLossLimitSol && bot.risk.dailyLossLimitSol > 0) {
      add(bot.name + ': daily loss limit reached (' + plain(bot.risk.todayPnlSol, 3) +
          ' SOL). No new entries until UTC midnight.');
    }
  }

  // ---- AI analyst ------------------------------------------------------
  function renderAi(ai) {
    var row = $('aiRow');
    if (!ai || !ai.enabled) { row.classList.add('hidden'); return; }
    row.classList.remove('hidden');
    var screening = ai.entryMode === 'screener';
    $('aiModel').textContent = screening
      ? 'screener · SOL $' + ai.solUsd.toFixed(0) + (ai.solPriceLive ? '' : ' (fallback)')
      : ai.model;

    var stats = $('aiStats');
    stats.innerHTML = '';
    function srow(label, text, cls) {
      var r = el('div', 'hs-row');
      r.appendChild(el('span', 'hs-lab', label));
      r.appendChild(el('span', 'hs-val ' + (cls || ''), text));
      stats.appendChild(r);
    }
    srow('Tokens on watchlist', ai.watching);
    if (screening) {
      srow('Matched the filter', ai.screenMatched, ai.screenMatched > 0 ? 'pos' : '');
      srow('Metadata fetched', ai.socialsFetched);
      if (ai.blockedByRisk > 0) srow('Blocked by a risk limit', ai.blockedByRisk, 'neg');
      if (ai.buyFailed > 0) srow('Buy failed', ai.buyFailed, 'neg');
    } else {
      srow('Sent to analyst', ai.evaluated);
      srow('Passed', ai.passed);
    }
    srow('Bought', ai.bought, ai.bought > 0 ? 'pos' : '');
    // A match that never became a position is the single most confusing thing
    // this bot can do, so the reason gets its own line rather than a log entry.
    if (screening && ai.lastBlockReason) {
      var why = el('div', 'tile-note');
      why.textContent = 'Last match not taken: ' + ai.lastBlockReason;
      stats.appendChild(why);
    }
    if (ai.reviews > 0) srow('Position reviews', ai.reviews);
    if (ai.refusals > 0) srow('Refusals', ai.refusals, 'neg');
    if (ai.errors > 0) srow('API errors', ai.errors, 'neg');
    if (ai.budgetBlocked > 0) srow('Blocked by budget', ai.budgetBlocked, 'neg');

    var spend = $('aiSpend');
    spend.innerHTML = '';

    // In screener mode the analyst is usually off, so the right-hand card
    // shows the thing actually worth watching: which filter is turning tokens
    // away. That breakdown is what tells you which threshold to move.
    if (screening && ai.calls === 0) {
      $('aiRightTitle').innerHTML =
        'Why entries were skipped <span class="sub">per filter check — move the one that dominates</span>';
      var names = {
        pool: 'Wrong venue', deployer_sold: 'Deployer sold', too_young: 'Too young',
        too_old: 'Too old', mcap_low: 'Market cap below floor', mcap_high: 'Market cap above ceiling',
        volume: 'Not enough volume', buyers: 'Too few buyers', socials: 'No socials', other: 'Other'
      };
      var keys = Object.keys(ai.screenRejects || {});
      if (keys.length === 0) {
        spend.appendChild(el('div', 'tile-note', 'No trades screened yet.'));
      } else {
        var total = 0;
        keys.forEach(function (k) { total += ai.screenRejects[k]; });
        keys.sort(function (a, b) { return ai.screenRejects[b] - ai.screenRejects[a]; });
        keys.forEach(function (k) {
          var n = ai.screenRejects[k];
          spend.appendChild(meter(names[k] || k,
            n.toLocaleString() + ' (' + Math.round((n / total) * 100) + '%)',
            total > 0 ? n / total : 0, null));
        });
      }
      return;
    }

    $('aiRightTitle').innerHTML = 'AI spend <span class="sub">estimated, at list prices</span>';
    var used = ai.estimatedCostUsd;
    var cap = ai.dailyBudgetUsd;
    spend.appendChild(meter('Daily AI budget', '$' + used.toFixed(3) + ' / $' + cap.toFixed(2),
      cap > 0 ? used / cap : 0,
      used >= cap ? 'Budget reached — analyst paused until tomorrow.' : null));

    var sub = el('div', 'hero-stats');
    spend.appendChild(sub);
    function trow(label, text) {
      var r = el('div', 'hs-row');
      r.appendChild(el('span', 'hs-lab', label));
      r.appendChild(el('span', 'hs-val', text));
      sub.appendChild(r);
    }
    trow('API calls', ai.calls);
    trow('Cost per call', ai.calls > 0 ? '$' + (used / ai.calls).toFixed(4) : '—');
    trow('Input tokens', ai.inputTokens.toLocaleString());
    trow('Output tokens', ai.outputTokens.toLocaleString());
    trow('Served from cache', ai.cacheReadTokens.toLocaleString());
  }

  // ---- bot switching ---------------------------------------------------
  var activeBot = null;
  try { activeBot = localStorage.getItem('sniper-bot'); } catch (e) {}

  function currentBot(s) {
    var found = null;
    for (var i = 0; i < s.bots.length; i++) if (s.bots[i].id === activeBot) found = s.bots[i];
    return found || s.bots[0];
  }

  function renderBotBar(s, active) {
    var bar = $('botBar');
    bar.innerHTML = '';
    s.bots.forEach(function (b) {
      var btn = el('div', 'botbtn');
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(b.id === active.id));

      var dot = el('span', 'dot' + (b.running ? (b.paused ? '' : ' on') : ' off'));
      dot.title = b.running ? (b.paused ? 'paused' : 'running') : 'stopped';
      btn.appendChild(dot);
      btn.appendChild(el('span', 'bname', b.name));
      btn.appendChild(el('span', 'bpnl ' + signClass(b.pnl.netSol),
        b.pnl.trades || b.risk.openPositions ? signed(b.pnl.netSol, 3) : '—'));

      btn.addEventListener('click', function () {
        activeBot = b.id;
        settingsBuiltFor = null; // different tab, different field set
        try { localStorage.setItem('sniper-bot', b.id); } catch (e) {}
        // Settings are per-tab, so a pending edit belongs to the tab it was
        // typed on. Dropping it on switch is safer than carrying it across.
        pendingSettings = {};
        if (snap) render(snap);
      });
      bar.appendChild(btn);
    });
  }

  var lastBotState = '';
  function renderBotControls(b) {
    var state = b.id + ':' + b.enabled + ':' + b.paused;
    if (state !== lastBotState) {
      lastBotState = state;
      var m = $('botMsg');
      if (m) { m.textContent = ''; m.className = 'set-msg'; }
    }
    var status = $('botStatus');
    status.textContent = !b.enabled ? 'STOPPED' : b.paused ? 'PAUSED' : 'RUNNING';
    status.className = 'status ' + (!b.enabled ? 'stop' : b.paused ? 'hold' : 'run');

    var toggle = $('botToggle');
    toggle.textContent = b.enabled ? 'Stop' : 'Start';
    toggle.className = b.enabled ? '' : 'primary';
    toggle.title = b.enabled
      ? 'Stop ' + b.name + '. Open positions keep being managed.'
      : 'Start ' + b.name;

    var pause = $('botPause');
    pause.textContent = b.paused ? 'Resume entries' : 'Pause entries';
    pause.className = b.paused ? 'armed' : '';
    pause.disabled = !b.enabled;

    $('botState').textContent = !b.enabled
      ? b.name + ' is not running. Open positions are still managed and can be closed here.'
      : b.paused
        ? 'No new entries. Existing positions are still managed.'
        : b.name + ' is live.';
  }

  // ---- settings --------------------------------------------------------
  var pendingSettings = {};

  var settingsBuiltFor = null;

  /**
   * The form is BUILT once per tab and only refreshed after that.
   *
   * It used to be rebuilt from scratch on every snapshot push — once a second —
   * which destroyed and recreated every input node. Clicking into a box and
   * typing meant losing focus a fraction of a second later, so a field could
   * not be filled in at all. Nothing here may replace a node the user might be
   * interacting with.
   */
  function renderSettings(s, botId) {
    var host = $('setForm');
    var fields = s.settings.fields.filter(function (f) {
      return f.bot === botId || f.bot === 'shared';
    });

    if (settingsBuiltFor === botId) {
      refreshSettings(s, fields);
      return;
    }
    settingsBuiltFor = botId;
    host.innerHTML = '';

    var groups = {}, order = [];
    fields.forEach(function (f) {
      var g = (f.bot === 'shared' ? 'Shared · ' : '') + f.group;
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(f);
    });

    order.forEach(function (g) {
      var box = el('div', 'cfg-group');
      box.appendChild(el('h3', null, g));
      var grid = el('div', 'set-grid');
      groups[g].forEach(function (f) {
        grid.appendChild(settingField(f, s.settings.values[f.key]));
      });
      box.appendChild(grid);
      host.appendChild(box);
    });
  }

  /**
   * Pushes new server values into the existing inputs, leaving alone anything
   * the user is touching: the focused field, and any field with an unsaved
   * edit. Without both guards a live refresh either steals the caret or
   * silently reverts what was just typed.
   */
  function refreshSettings(s, fields) {
    fields.forEach(function (f) {
      var input = $('set-' + f.key);
      if (!input) return;
      if (input === document.activeElement) return;
      if (Object.prototype.hasOwnProperty.call(pendingSettings, f.key)) return;

      var value = s.settings.values[f.key];
      if (input.value !== value) input.value = value;
      input.dataset.serverValue = value;
      input.parentNode.className = 'set-field';
    });
  }

  function settingField(f, value) {
    var wrap = el('div', 'set-field');
    if (Object.prototype.hasOwnProperty.call(pendingSettings, f.key)) wrap.className += ' changed';

    var lab = el('label', null, f.label);
    lab.htmlFor = 'set-' + f.key;
    wrap.appendChild(lab);

    var input;
    if (f.kind === 'enum') {
      input = document.createElement('select');
      (f.options || []).forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o; opt.textContent = o;
        input.appendChild(opt);
      });
    } else if (f.kind === 'boolean') {
      input = document.createElement('select');
      ['true', 'false'].forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o; opt.textContent = o === 'true' ? 'on' : 'off';
        input.appendChild(opt);
      });
    } else {
      input = document.createElement('input');
      input.type = f.kind === 'number' ? 'number' : 'text';
      if (f.min !== undefined) input.min = f.min;
      if (f.max !== undefined) input.max = f.max;
      if (f.step !== undefined) input.step = f.step;
      if (f.placeholder) input.placeholder = f.placeholder;
    }
    input.id = 'set-' + f.key;
    // A pending edit wins over the server value, so a live refresh cannot
    // overwrite what is being typed.
    input.value = Object.prototype.hasOwnProperty.call(pendingSettings, f.key)
      ? pendingSettings[f.key]
      : value;
    input.dataset.serverValue = value;
    input.addEventListener('input', function () {
      // Compared against the CURRENT server value, not the one captured when
      // this node was built — those diverge as soon as anything else saves.
      if (input.value === input.dataset.serverValue) delete pendingSettings[f.key];
      else pendingSettings[f.key] = input.value;
      wrap.className = 'set-field' + (pendingSettings[f.key] !== undefined ? ' changed' : '');
    });
    wrap.appendChild(input);

    if (f.help) wrap.appendChild(el('div', 'help', f.help));
    return wrap;
  }

  function setMsg(text, cls) {
    var m = $('setMsg');
    m.textContent = text;
    m.className = 'set-msg ' + (cls || '');
  }

  // ---- copy panel ------------------------------------------------------
  var COPY_SKIP_LABELS = {
    too_small: 'Buy too small (volume bump)',
    too_large: 'Buy too large',
    already_held: 'Already holding it',
    already_traded: 'Already traded once',
    no_curve: 'No readable curve',
    graduated: 'Already graduated',
    no_price: 'Could not price it',
    risk: 'Blocked by a risk limit',
    busy: 'Another entry in flight',
    buy_failed: 'Buy failed',
    zero_size: 'Sizing produced nothing'
  };

  function renderCopy(c) {
    var row = $('copyRow');
    if (!c) { row.classList.add('hidden'); return; }
    row.classList.remove('hidden');

    var host = $('copyWallets');
    host.innerHTML = '';
    if (!c.wallets.length) {
      host.appendChild(el('div', 'tile-note',
        'No wallets configured. Add them under Settings on this tab.'));
    } else {
      c.wallets.forEach(function (w) {
        var r = el('div', 'wallet-row');
        var a = el('span', 'wallet-addr', w.address.slice(0, 6) + '\u2026' + w.address.slice(-4));
        a.title = w.address;
        r.appendChild(a);
        r.appendChild(el('span', 'mono', w.holdings + ' token' + (w.holdings === 1 ? '' : 's')));
        host.appendChild(r);
      });
    }
    var sub = el('div', 'hero-stats');
    host.appendChild(sub);
    function srow(label, text, cls) {
      var r = el('div', 'hs-row');
      r.appendChild(el('span', 'hs-lab', label));
      r.appendChild(el('span', 'hs-val ' + (cls || ''), text));
      sub.appendChild(r);
    }
    srow('Wallets watched', c.primed + ' / ' + c.tracking,
      c.tracking > 0 && c.primed === c.tracking ? 'pos' : c.tracking > 0 ? 'neg' : '');
    srow('Wallet reads', c.polls.toLocaleString());
    srow('Trades observed', c.tradesSeen);
    srow('Copied in', c.bought, c.bought > 0 ? 'pos' : '');
    srow('Mirrored out', c.sold);
    if (c.errors > 0) srow('RPC errors', c.errors, 'neg');

    var skips = $('copySkips');
    skips.innerHTML = '';
    var keys = Object.keys(c.skips || {});
    if (!keys.length) {
      skips.appendChild(el('div', 'tile-note',
        c.tracking ? 'Nothing skipped yet.' : 'Not tracking any wallets.'));
      return;
    }
    var total = 0;
    keys.forEach(function (k) { total += c.skips[k]; });
    keys.sort(function (a, b) { return c.skips[b] - c.skips[a]; });
    keys.forEach(function (k) {
      var n = c.skips[k];
      skips.appendChild(meter(COPY_SKIP_LABELS[k] || k,
        n.toLocaleString() + ' (' + Math.round((n / total) * 100) + '%)',
        total > 0 ? n / total : 0, null));
    });
  }

  // ---- main render -----------------------------------------------------
  function render(s) {
    snap = s;
    if (!s.bots || !s.bots.length) return;
    var b = currentBot(s);
    activeBot = b.id;
    renderBotBar(s, b);
    renderBotControls(b);
    renderSettings(s, b.id);
    renderCopy(b.copy);

    var badge = $('modeBadge');
    badge.textContent = s.mode === 'live' ? 'LIVE — REAL FUNDS' : 'PAPER';
    badge.className = 'badge ' + (s.mode === 'live' ? 'live' : 'paper');

    $('topMeta').textContent =
      s.executor + ' · ' + s.discovery + ' · up ' + dur(s.uptimeSeconds) +
      ' · SOL $' + (s.solUsd ? s.solUsd.toFixed(2) : '?') + (s.solPriceLive ? '' : ' (fallback)');

    var hero = $('heroPnl');
    hero.textContent = signed(b.pnl.netSol, 4) + ' SOL';
    hero.className = 'hero-val num ' + signClass(b.pnl.netSol);
    $('heroSub').textContent =
      'realised ' + signed(b.pnl.realizedSol, 4) + ' · open ' + signed(b.pnl.unrealizedSol, 4) +
      ' · ' + b.pnl.trades + ' closed trades';

    var hs = $('heroStats');
    hs.innerHTML = '';
    function hrow(label, text, cls) {
      var r = el('div', 'hs-row');
      r.appendChild(el('span', 'hs-lab', label));
      r.appendChild(el('span', 'hs-val ' + (cls || ''), text));
      hs.appendChild(r);
    }
    hrow('Return on capital deployed',
      b.pnl.trades ? signed(b.pnl.returnPct, 1) + '%' : '—', signClass(b.pnl.returnPct));
    hrow('Total deployed', plain(b.pnl.deployedSol, 4) + ' SOL');
    hrow('Best trade', b.pnl.trades ? signed(b.pnl.bestSol, 4) : '—', signClass(b.pnl.bestSol));
    hrow('Worst trade', b.pnl.trades ? signed(b.pnl.worstSol, 4) : '—', signClass(b.pnl.worstSol));
    hrow('Average winner', b.pnl.wins ? signed(b.pnl.avgWinSol, 4) : '—', 'pos');
    hrow('Average loser', b.pnl.losses ? signed(b.pnl.avgLossSol, 4) : '—', 'neg');

    $('kWin').textContent = b.pnl.trades ? b.pnl.winRatePct.toFixed(0) + '%' : '—';
    $('kWinSub').textContent = b.pnl.wins + 'W / ' + b.pnl.losses + 'L';

    var pf = $('kPf');
    if (b.pnl.profitFactor === null) { pf.textContent = '∞'; pf.className = 'tile-val num pos'; }
    else if (!b.pnl.trades) { pf.textContent = '—'; pf.className = 'tile-val num'; }
    else {
      pf.textContent = b.pnl.profitFactor.toFixed(2);
      pf.className = 'tile-val num ' + (b.pnl.profitFactor >= 1 ? 'pos' : 'neg');
    }

    var today = $('kToday');
    today.textContent = signed(b.pnl.todaySol, 4);
    today.className = 'tile-val num ' + signClass(b.pnl.todaySol);
    $('kTodaySub').textContent = 'limit ' + plain(b.risk.dailyLossLimitSol, 2) + ' SOL';

    $('kOpen').textContent = b.risk.openPositions + ' / ' + b.risk.maxConcurrentPositions;
    $('kOpenSub').textContent = b.stats.bought + ' bought this session';

    $('kWallet').textContent = b.risk.walletBalanceSol === null ? '—' : plain(b.risk.walletBalanceSol, 3);
    $('kWalletSub').textContent = s.mode === 'paper' ? 'simulated' : 'reserve ' + plain(b.risk.minWalletReserveSol, 2);

    $('kSeen').textContent = b.stats.seen;
    $('kSeenSub').textContent = b.stats.evaluated + ' screened · ' + b.stats.rejected + ' rejected';

    renderAi(b.ai);
    renderBanners(s, b);
    drawEquity(b.equity);
    renderMeters(b.risk);
    renderPositions(b.positions);
    renderTrades(b.journal);
    renderReasons(b.exitReasons);
    renderConfig(s.config);
    renderLog(s.log);

    var kill = $('killBtn');
    kill.textContent = s.killSwitch ? 'Release kill switch' : 'Kill switch';
    kill.className = s.killSwitch ? 'armed' : '';
  }

  // ---- controls --------------------------------------------------------
  // Failures here go next to the button that was pressed. They used to be
  // written into the Settings tab's message line, which is a different tab —
  // so a rejected Start looked exactly like a button that did nothing.
  function botMsg(text, cls) {
    var m = $('botMsg');
    m.textContent = text || '';
    m.className = 'set-msg ' + (cls || '');
  }

  function botAction(path, body, verb) {
    botMsg(verb + '\u2026', '');
    return post(path, body)
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        botMsg(res.ok ? '' : (res.body && res.body.error) || (verb + ' failed'), res.ok ? '' : 'err');
      })
      .catch(function () { botMsg(verb + ' failed — no response from the bot', 'err'); });
  }

  $('botToggle').addEventListener('click', function () {
    if (!snap) return;
    var b = currentBot(snap);
    var next = !b.enabled;
    if (!next && !window.confirm('Stop ' + b.name + '? Open positions keep being managed.')) return;
    botMsg('', '');
    botAction('/api/bots/toggle', { id: b.id, enabled: next }, next ? 'Starting' : 'Stopping');
  });

  $('botPause').addEventListener('click', function () {
    if (!snap) return;
    var b = currentBot(snap);
    botAction('/api/bots/pause', { id: b.id, paused: !b.paused }, b.paused ? 'Resuming' : 'Pausing');
  });

  $('setSave').addEventListener('click', function () {
    var keys = Object.keys(pendingSettings);
    if (!keys.length) { setMsg('Nothing changed.', ''); return; }
    setMsg('Saving\u2026', '');
    post('/api/settings', { patch: pendingSettings })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (!res.ok) { setMsg(res.body.error || 'Rejected', 'err'); return; }
        pendingSettings = {};
        settingsBuiltFor = null; // rebuild so every field shows the accepted value
        setMsg('Applied ' + res.body.changed.length + ' change(s) — live now, no restart.', 'ok');
      })
      .catch(function () { setMsg('Request failed', 'err'); });
  });

  $('setRevert').addEventListener('click', function () {
    pendingSettings = {};
    settingsBuiltFor = null;
    setMsg('Reverted to the running values.', '');
    if (snap) render(snap);
  });

  $('setReset').addEventListener('click', function () {
    if (!window.confirm('Discard every saved setting and go back to what .env says?')) return;
    post('/api/settings/reset')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        pendingSettings = {};
        settingsBuiltFor = null;
        setMsg(j && j.error ? j.error : 'Reset to .env.', j && j.error ? 'err' : 'ok');
      });
  });

  $('killBtn').addEventListener('click', function () {
    if (!snap) return;
    var next = !snap.killSwitch;
    if (next && !window.confirm('Engage the kill switch? No new positions will be opened.')) return;
    post('/api/kill-switch', { enabled: next });
  });

  $('themeBtn').addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'dark' ? 'light' : (cur === 'light' ? 'dark' : 'dark');
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('sniper-theme', next); } catch (e) {}
  });

  $('cvdBtn').addEventListener('click', function () {
    var on = document.documentElement.getAttribute('data-cvd') === 'on';
    document.documentElement.setAttribute('data-cvd', on ? 'off' : 'on');
    try { localStorage.setItem('sniper-cvd', on ? 'off' : 'on'); } catch (e) {}
  });

  try {
    var t = localStorage.getItem('sniper-theme');
    if (t) document.documentElement.setAttribute('data-theme', t);
    var c = localStorage.getItem('sniper-cvd');
    if (c) document.documentElement.setAttribute('data-cvd', c);
  } catch (e) {}

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
    tab.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t2) {
        t2.setAttribute('aria-selected', String(t2 === tab));
        var panel = $('tab-' + t2.dataset.tab);
        if (panel) panel.classList.toggle('hidden', t2 !== tab);
      });
    });
  });

  // ---- transport -------------------------------------------------------
  var ws = null, pollTimer = null, retry = 0;

  function setConn(state, text) {
    $('connDot').className = 'dot ' + state;
    $('connText').textContent = text;
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      fetch('/api/snapshot').then(function (r) { return r.json(); }).then(render).catch(function () {});
    }, 2000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    try { ws = new WebSocket(proto + location.host); } catch (e) { startPolling(); return; }

    ws.onopen = function () { retry = 0; stopPolling(); setConn('on', 'live'); };
    ws.onmessage = function (ev) {
      try { render(JSON.parse(ev.data)); } catch (e) {}
    };
    ws.onclose = function () {
      setConn('off', 'reconnecting…');
      startPolling();
      retry += 1;
      setTimeout(connect, Math.min(10000, 500 * Math.pow(2, Math.min(retry, 5))));
    };
    ws.onerror = function () { if (ws) ws.close(); };
  }

  fetch('/api/snapshot').then(function (r) { return r.json(); }).then(render).catch(function () {});
  connect();
})();
</script>
</body>
</html>`;
}
