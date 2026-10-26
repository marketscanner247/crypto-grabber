// Crypto Grabber → Telegram alerts.
// Runs the site's own scan in a headless browser, then messages Telegram when
//   • a setup that meets every check appears and is waiting for its entry ("Setup ready"), and
//   • its recommended entry triggers ("Enter now").
// It remembers what it already sent in bot/state.json, so each alert goes out once.
//
// Environment:
//   TELEGRAM_TOKEN, TELEGRAM_CHAT_ID  from @BotFather / @userinfobot (GitHub secrets). Without them it only prints.
//   ALERT_MIN   all  = only setups that meet every check (default)
//               risk = setups that meet every check, plus high-risk ones scoring 50+ (marked ⚠️)
//               take = every check, or a score of 70+
//               any  = every signal (handy to confirm alerts work)
//   ALERT_TFS   timeframes to scan, default "4h" (the only timeframe that held up in the 120-day backtest)
//   TZ_NAME     time zone for times in messages, default America/Toronto
//   SITE_URL    link added to messages (defaults to the GitHub Pages address of this repo)
//   TEST=true   also send a "connected" test message
//   BRIEF=true  send the daily BTC, ETH and alts briefs now (otherwise once a day, on the first run after 9:30 am New York time)
//   SCORECARD=true  send the weekly scorecard now (otherwise once a week, on the first run after 6 pm New York time on Sunday)
//   BROWSER_CHANNEL=chrome  use the installed Google Chrome instead of Playwright's Chromium
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, ".."), STATE = path.join(__dirname, "state.json");
const TOKEN = process.env.TELEGRAM_TOKEN || "", CHAT = process.env.TELEGRAM_CHAT_ID || "";
const MIN = (process.env.ALERT_MIN || "all").toLowerCase();
const TFS = (process.env.ALERT_TFS || "4h").split(",").map(s => s.trim()).filter(Boolean);
const TZ = process.env.TZ_NAME || "America/Toronto";
const repo = process.env.GITHUB_REPOSITORY || "";
const SITE = process.env.SITE_URL || (repo ? `https://${repo.split("/")[0].toLowerCase()}.github.io/${repo.split("/")[1]}/` : "");
const TEST = String(process.env.TEST || "").toLowerCase() === "true";
const BRIEF = String(process.env.BRIEF || "").toLowerCase() === "true";
const SCORECARD = String(process.env.SCORECARD || "").toLowerCase() === "true";
const DAILY = String(process.env.DAILY || "").toLowerCase() === "true";   // send today's scoreboard now (otherwise just after midnight, for the day that ended)
const SIZE = 1000, FEE = 0.001;
const RISK = +process.env.RISK_USD || 10;              // $ lost if the stop is hit: sets the position size shown in alerts
const MAX_OPEN = +process.env.MAX_OPEN || 3;           // no new "Enter now" while this many alerted trades are open
const MAX_DAILY_STOPS = +process.env.MAX_DAILY_STOPS || 3;   // no new entries for the rest of the day after this many stops
// The 120-day backtest lost money on counter-trend setups in every version, so they are not alerted unless asked for.
const ALLOW_COUNTER = String(process.env.ALLOW_COUNTER || "").toLowerCase() === "true";   // scorecard: $1,000 per trade; fee estimate 0.1% per side
// New York clock (handles daylight saving)
function nyNow(t) {
  const p = {}; for (const x of new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, wd: p.weekday };
}

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = v => v == null ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const when = t => new Date(t).toLocaleString("en-CA", { timeZone: TZ, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });

async function send(html) {
  if (!TOKEN || !CHAT) { console.log("\n[dry run, no Telegram secrets]\n" + html.replace(/<[^>]+>/g, "")); return true; }
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT, text: html, parse_mode: "HTML", disable_web_page_preview: true })
      });
      const j = await r.json();
      if (j.ok) return true;
      console.error("Telegram said:", j.description);
      if (r.status === 429) await new Promise(res => setTimeout(res, ((j.parameters && j.parameters.retry_after) || 3) * 1000));
      else return false;
    } catch (e) { console.error("Telegram send failed:", e.message); await new Promise(res => setTimeout(res, 2000)); }
  }
  return false;
}

// Tiny static server so the page runs from http://localhost (same as a website)
function serve() {
  const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
    const f = path.join(ROOT, path.normalize(p));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r(srv)));
}

const risky = s => !s.all;
function head(s, kind) {
  const icon = risky(s) ? "⚠️" : kind === "enter" ? (s.dir === "long" ? "🟢" : "🔴") : kind === "ready" ? "🟡" : "⚪";
  const title = (risky(s) ? "HIGH RISK · " : "") + (kind === "enter" ? `ENTER ${s.dir.toUpperCase()} NOW` : kind === "ready" ? `SETUP READY · ${s.dir}` : "UPDATE");
  return `${icon} <b>${title} · ${esc(s.sym)} ${esc(s.tf)}</b>\n${esc(s.label)} · ${esc(s.style)} · score ${s.score} · ${s.all ? "✓ all 5 checks" : `${s.checks} checks`}`;
}
const riskNote = s => risky(s) ? `⚠️ Enter at your own risk. Missing: ${esc(s.missing.slice(0, 3).join("; "))}.\nIf you take it: half size, take profit at Target 1.\n` : "";
function plan(s) {
  const w = s.dir === "long" ? "Buy" : "Sell";
  if (s.confirm) {   // top-down entry: zone on the setup's timeframe, entry on a lower-timeframe CHoCH
    const up = s.dir === "long", rr = s.rr1Now ?? s.rr1;
    const ent = s.entryNow ? `${s.splitLimit ? `${w} HALF now at <b>${esc(s.entryNow)}</b> (${esc(s.confirm)} CHoCH ${up ? "up" : "down"})\nSecond half: limit ${w.toLowerCase()} at <b>${esc(s.splitLimit)}</b> (retest; cancel it if Target 1 comes first)` : `${w} at <b>${esc(s.entryNow)}</b> (${esc(s.confirm)} CHoCH ${up ? "up" : "down"}${s.strongIn ? ", strong candle: full size" : ""})`}\nStop: <b>${esc(s.stopNow)}</b> (${pct(s.stopNowPct)}, past the ${esc(s.confirm)} ${up ? "low" : "high"})`
      : `Zone: <b>${esc(s.poi)}</b>. Entry after a ${esc(s.confirm)} CHoCH ${up ? "up (a close above its last lower high" : "down (a close below its last higher low"}${s.touched && s.chochLvl ? `, now ${esc(s.chochLvl)}` : ""}).\nStop: set at the CHoCH, just past the ${esc(s.confirm)} ${up ? "low" : "high"} (about ${esc(s.stop)})`;
    return `${ent}\nTarget 1: ${esc(s.t1)} (${rr != null ? (s.entryNow ? "" : "about ") + rr.toFixed(1) : "?"}R) · Target 2: ${esc(s.t2)}\nPrice now: ${esc(s.live)}`;
  }
  const ent = s.split
    ? `${w} half at <b>${esc(s.e1)}</b> (${esc(s.e1src)}) + half at <b>${esc(s.e2)}</b> (order block middle) · average ${esc(s.entry)}`
    : `Entry: <b>${esc(s.entry)}</b> (${esc(s.method)})`;
  // sweep & reclaim: the stop sits just past the actual sweep wick, so it is only final once the reclaim fills
  const stop = s.stopNow ? `Stop: ${esc(s.stopNow)} (${pct(s.stopNowPct)}, just past the sweep)`
    : s.method === "Sweep & reclaim" ? `Stop: just past the sweep ${s.dir === "long" ? "low" : "high"}, at least ${esc(s.stop)} (${pct(s.stopPct)})`
    : `Stop: ${esc(s.stop)} (${pct(s.stopPct)})`;
  const rr = s.rr1Now ?? s.rr1;
  return `${ent}\n${stop}\n` +
    `Target 1: ${esc(s.t1)} (${pct(s.t1Pct)}, ${rr != null ? rr.toFixed(1) : "?"}R) · Target 2: ${esc(s.t2)} (${pct(s.t2Pct)})\nPrice now: ${esc(s.live)}`;
}
function sizeLine(s) {
  const p = Math.abs(s.stopNowPct ?? s.stopPct); if (!p) return "";
  const pos = RISK / (p / 100);
  return `\nSize: risk $${RISK} → $${pos >= 1000 ? Math.round(pos).toLocaleString("en-US") : pos.toFixed(0)} position${s.confirm && !s.entryNow ? " (estimate, final at the CHoCH)" : ""}`;
}
const ctxLines = s => s.notes && s.notes.length ? `\n${s.notes.map(esc).join("\n")}` : "";
function links(s) {
  return [SITE && `<a href="${esc(SITE)}">Crypto Grabber</a>`, s.chart && `<a href="${esc(s.chart)}">Chart</a>`].filter(Boolean).join(" · ");
}
function msgReady(s) {
  return `${head(s, "ready")}\n\n${esc(s.detail || s.why)}\n\n${plan(s)}${sizeLine(s)}${ctxLines(s)}\n\n${riskNote(s)}Price is close to the ${s.confirm ? "zone" : "entry"}. You'll get an <b>Enter now</b> alert when it ${s.confirm ? `confirms on the ${esc(s.confirm)}` : "fills"}.\n${links(s)}`;
}
// Lower timeframe confirmed: tell the trader to place the limit order at the retest level now.
function msgConfirm(s) {
  const up = s.dir === "long", w = up ? "BUY" : "SELL", p = Math.abs(s.retStopPct || 0), pos = p ? RISK / (p / 100) : null;
  return `🔔 <b>${risky(s) ? "⚠️ " : ""}CONFIRMED · PLACE LIMIT ${w} · ${esc(s.sym)} ${esc(s.tf)}</b>\n` +
    `The ${esc(s.confirm)} broke structure ${up ? "up" : "down"} (CHoCH). Don't chase it: wait for the retest.\n\n` +
    `Limit ${w.toLowerCase()}: <b>${esc(s.retLvl)}</b> (retest of ${esc(s.retSrc)})\nStop: <b>${esc(s.retStop)}</b>${p ? ` (${p.toFixed(1)}%)` : ""}\n` +
    `Target 1: ${esc(s.t1)} · Target 2: ${esc(s.t2)}\nPrice now: ${esc(s.live)}${pos ? `\nSize: risk $${RISK} → $${pos >= 1000 ? Math.round(pos).toLocaleString("en-US") : pos.toFixed(0)} position` : ""}` +
    `${ctxLines(s)}\n\nCancel the order if it hasn't filled within about 12 ${esc(s.confirm)} candles, or if price runs to Target 1 first.\n${links(s)}`;
}
function msgEnter(s) {
  const fillTxt = s.split && s.fill != null ? (s.fill < 1 ? `First half filled at ${esc(s.e1)}. Keep the second half as a limit at ${esc(s.e2)}.` : `Both halves filled, average ${esc(s.avg || s.entry)}.`) : "";
  return `${head(s, "enter")}\n\n${s.filledAt ? `Triggered ${when(s.filledAt)}` : ""}${s.filledAt && fillTxt ? " · " : ""}${fillTxt}\n\n${plan(s)}${sizeLine(s)}${ctxLines(s)}\n\n${riskNote(s)}${links(s)}`;
}
function msgDone(s) {
  const t = s.missed ? "Missed: price ran to Target 1 without the entry. Don't chase it." : s.early ? "↩️ Closed early: the lower timeframe broke structure against the trade before Target 1" : { t2: "✅ Target 2 hit", t1_be: "Target 1 hit, rest closed at entry", stopped: "❌ Stopped out", no_trigger: "Entry never triggered, setup expired", timeout: "Closed (time limit)" }[s.status] || s.stateTxt;
  return `⚪ <b>${esc(s.sym)} ${esc(s.tf)} ${s.dir}</b>: ${esc(t)}\n${esc(s.detail || "")}`;
}

// Weekly scorecard: every alerted trade of the last 7 days, re-played on real prices with a $1,000 position.
const usd = v => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
const day = t => new Date(t).toLocaleDateString("en-CA", { timeZone: TZ, month: "short", day: "numeric" });
function scorecard(list, grades, now) {
  const G = Object.fromEntries(grades.map(g => [g.key, g]));
  const rows = list.map(t => ({ ...t, g: G[t.key] })).filter(t => t.g && !t.g.err);
  const CLOSED = ["t2", "t1_be", "stopped", "timeout"];
  const stats = a => {
    const ent = a.filter(t => t.g.fill > 0), closed = ent.filter(t => CLOSED.includes(t.g.status)), open = ent.filter(t => t.g.status === "open");
    const pnl = closed.reduce((x, t) => x + t.g.usd, 0), fees = closed.reduce((x, t) => x + t.g.fill * SIZE * FEE * 2, 0);
    return { n: a.length, ent: ent.length, closed: closed.length, open: open.length,
      t2: closed.filter(t => t.g.status === "t2").length, be: closed.filter(t => t.g.status === "t1_be").length,
      stop: closed.filter(t => t.g.status === "stopped").length, timeout: closed.filter(t => t.g.status === "timeout").length,
      wins: closed.filter(t => t.g.usd > 0).length, pnl, fees, net: pnl - fees, unreal: open.reduce((x, t) => x + t.g.usd, 0),
      avgR: closed.length ? closed.reduce((x, t) => x + t.g.r, 0) / closed.length : null,
      notFilled: a.filter(t => t.g.status === "no_trigger").length, waiting: a.filter(t => t.g.status === "pending").length };
  };
  const wk = rows.filter(t => now - t.at <= 7 * 864e5), m4 = rows.filter(t => now - t.at <= 28 * 864e5);
  const S = stats(wk), L = [], R = v => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}R`;
  const line = (lab, x) => `${lab}: ${x.ent ? `${x.ent} trade${x.ent === 1 ? "" : "s"} · ${x.wins} won · ${x.stop} stopped${x.open ? ` · ${x.open} open` : ""} · <b>${usd(x.net)}</b>` : "no trades"}`;
  L.push(`📈 <b>Weekly scorecard · ${day(now - 7 * 864e5)} – ${day(now)}</b>`);
  L.push(`$1,000 per trade`);
  L.push("");
  if (!wk.length) L.push("No trades were alerted this week.");
  else {
    L.push(`Entered: <b>${S.ent}</b> of ${S.n} alerts${S.notFilled ? ` (${S.notFilled} never filled)` : ""}${S.waiting ? ` · ${S.waiting} still waiting` : ""}`);
    if (S.closed) {
      L.push(`✅ Won: <b>${S.wins}</b>${S.t2 || S.be ? ` (${[S.t2 && `${S.t2} hit Target 2`, S.be && `${S.be} Target 1 then entry`].filter(Boolean).join(", ")})` : ""}`);
      L.push(`❌ Stop loss: <b>${S.stop}</b>${S.timeout ? ` · ⏱ closed on time limit: ${S.timeout}` : ""}`);
      L.push(`Win rate: <b>${Math.round(S.wins / S.closed * 100)}%</b> · average ${R(S.avgR)} per trade`);
      L.push(`Profit: ${usd(S.pnl)} · fees −$${S.fees.toFixed(2)} · <b>Net ${usd(S.net)}</b>`);
    } else L.push("No trades closed yet.");
    if (S.open) L.push(`⏳ Still open: ${S.open} (${usd(S.unreal)} right now, counted when closed)`);
    L.push("");
    L.push(line("All 5 checks", stats(wk.filter(t => t.all))));
    L.push(line("⚠️ High risk", stats(wk.filter(t => !t.all))));
    for (const tf of [...new Set(wk.map(t => t.tf))]) L.push(line(tf, stats(wk.filter(t => t.tf === tf))));
    const done = wk.filter(t => t.g.fill > 0 && CLOSED.includes(t.g.status)).sort((a, b) => b.g.usd - a.g.usd);
    if (done.length > 1) { const f = t => `${esc(t.sym)} ${esc(t.tf)} ${t.dir} ${usd(t.g.usd)}`; L.push(""); L.push(`Best: ${f(done[0])} · Worst: ${f(done[done.length - 1])}`); }
  }
  const M = stats(m4);
  if (m4.length > wk.length && M.closed) { L.push(""); L.push(`Last 4 weeks: ${M.ent} trades · ${M.wins} won · <b>Net ${usd(M.net)}</b>`); }
  return L.join("\n");
}

// Daily scoreboard: what closed today, what is open now, and what is waiting (near the zone / waiting for the CHoCH).
function daily(list, grades, setups, now, date) {
  const G = Object.fromEntries(grades.map(g => [g.key, g]));
  const rows = list.map(t => ({ ...t, g: G[t.key] })).filter(t => t.g && !t.g.err);
  const CLOSED = ["t2", "t1_be", "stopped", "timeout"], isToday = t => t && nyNow(t).date === date;
  const today = rows.filter(t => t.g.fill > 0 && CLOSED.includes(t.g.status) && isToday(t.g.closedAt || t.at));
  const open = rows.filter(t => t.g.fill > 0 && t.g.status === "open");
  const pnl = today.reduce((a, t) => a + t.g.usd - t.g.fill * SIZE * FEE * 2, 0), R = today.reduce((a, t) => a + t.g.r, 0);
  const ok = s => (!ALLOW_COUNTER && /^Counter/.test(s.style || "")) ? false : MIN === "any" ? true : s.all ? true : MIN === "take" ? s.score >= 70 && s.actionable : MIN === "risk" ? s.tier === "risk" : false;
  const pend = setups.filter(s => s.status === "pending" && ok(s));
  const waiting = pend.filter(s => s.confirm && s.touched), ready = pend.filter(s => !(s.confirm && s.touched) && s.near);
  const tag = t => `${esc(t.sym)} ${esc(t.tf)} ${t.dir}`, rTxt = v => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;
  const ic = { t2: "✅", t1_be: "🎯", stopped: "❌", timeout: "⏱" };
  const L = [`📋 <b>Daily scoreboard · ${new Date(date + "T12:00:00Z").toLocaleDateString("en-CA", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })}</b>`, ""];
  L.push(`<b>Closed that day: ${today.length}</b>${today.length ? ` · ${today.filter(t => t.g.r > 0).length} won · ${today.filter(t => t.g.status === "stopped").length} stopped · <b>${rTxt(R)}</b> · ${usd(pnl)} at $1,000 a trade` : ""}`);
  for (const t of today) L.push(`${t.g.early ? "↩️" : ic[t.g.status] || "·"} ${tag(t)} ${rTxt(t.g.r)}`);
  L.push("", `<b>Right now · in trades: ${open.length}</b>${open.length ? ` (limit ${MAX_OPEN})` : ""}`);
  for (const t of open) L.push(`⏳ ${tag(t)} · ${t.g.t1 ? "Target 1 hit, stop at entry · " : ""}now ${rTxt(t.g.r)}`);
  L.push("", `<b>Waiting for confirmation: ${waiting.length}</b>`);
  for (const s of waiting) L.push(s.chochDone ? `🔔 ${tag(s)} · confirmed, limit ${s.dir === "long" ? "buy" : "sell"} at ${esc(s.retLvl)}, stop ${esc(s.retStop)}` : `👀 ${tag(s)} · in the zone, needs a ${esc(s.confirm)} close ${s.dir === "long" ? "above" : "below"} ${esc(s.chochLvl || "its last swing")}`);
  L.push("", `<b>Ready (price near the zone): ${ready.length}</b>`);
  for (const s of ready) L.push(`🟡 ${tag(s)} · zone ${esc(s.poi || s.e1 || s.entry)} · price ${esc(s.live)}`);
  return L.join("\n");
}

(async () => {
  let state = {}, fresh = false;
  try { state = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (e) { fresh = true; }
  const srv = await serve(), port = srv.address().port;
  // On GitHub, use the Chrome that is already installed (fast); otherwise Playwright's own Chromium.
  let browser;
  try { browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}); }
  catch (e) {
    try { browser = await chromium.launch(); }
    catch (e2) { console.error("No browser available:", e2.message.split("\n")[0]); srv.close(); process.exit(3); }
  }
  const page = await browser.newPage({ timezoneId: TZ });
  page.on("pageerror", e => console.error("page error:", e.message));
  if (process.env.CG_MOCK) await require(path.resolve(process.env.CG_MOCK)).install(page);
  let out, briefs = [];
  const ny = nyNow(+process.env.MOCK_NOW || Date.now());
  const briefDue = BRIEF || (ny.hm >= "09:30" && ny.hm < "12:00" && !(state.__brief && state.__brief.date === ny.date));
  const J = state.__journal = state.__journal && Array.isArray(state.__journal.list) ? state.__journal : { list: [] };
  // at the first check after midnight (New York / Toronto time), report the day that just ended
  const [hh, mm] = ny.hm.split(":").map(Number), nowT = +process.env.MOCK_NOW || Date.now();
  const yday = nyNow(nowT - (hh * 60 + mm + 1) * 60e3).date;
  const dayDue = DAILY || (ny.hm < "06:00" && !(state.__day && state.__day.date === yday) && !fresh);
  const repDate = DAILY ? ny.date : yday;
  const weekDue = SCORECARD || (ny.wd === "Sun" && ny.hm >= "18:00" && !(state.__week && state.__week.date === ny.date));
  let grades = null;
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load" });
    // briefs first, so they land right at 9:30 instead of after the scan
    if (briefDue) for (const [name, fn] of [["BTC", () => window.cgBrief("BTC")], ["ETH", () => window.cgBrief("ETH")], ["Alts", () => window.cgAltBrief()]]) {
      try { briefs.push({ name, ...(await page.evaluate(fn)) }); } catch (e) { console.error(`${name} brief failed:`, e.message); }
    }
    for (const b of briefs) if (await send(b.html + (SITE && b.name === "Alts" ? `\n<a href="${esc(SITE)}">Crypto Grabber</a>` : ""))) { b.sent = true; if (!state.__brief || state.__brief.date !== ny.date) state.__brief = { date: ny.date, seen: Date.now() }; }
    if (briefs.some(b => b.sent)) try { fs.writeFileSync(STATE, JSON.stringify(state)); } catch (e) {}   // don't resend if the scan fails
    out = await page.evaluate(tfs => window.cgBot({ tfs }), TFS);
    if (weekDue || dayDue) { try { grades = await page.evaluate(([l, n]) => window.cgGrade(l, n), [J.list, SIZE]); } catch (e) { console.error("scorecard failed:", e.message); } }
  } finally { await browser.close(); srv.close(); }

  console.log(`${out.status} · ${out.setups.length} setup(s)`);
  if (out.market) console.log(`Market: BTC ${out.market.btc} · Alts ${out.market.alts} · ${out.market.mkt} · ${out.market.lead}`);
  const now = +process.env.MOCK_NOW || Date.now(), sent = [];   // MOCK_NOW is only used by tests
  if (TEST || fresh) {
    const m = out.market;
    await send(`✅ <b>Crypto Grabber alerts connected</b>\nChecking ${TFS.join(", ")} every 5 minutes. Alerting on ${MIN === "all" ? "setups that meet every check" : MIN === "take" ? "setups that meet every check or score 70+" : MIN === "risk" ? "setups that meet every check, plus high-risk ones scoring 50+ (marked ⚠️)" : "every signal"}.\n` +
      (m ? `\nBTC: ${esc(m.btc)} (${esc(m.btcStyle)}) · Alts: ${esc(m.alts)} · Market: ${esc(m.mkt)}\n${esc(m.lead)}, ${esc(m.pace).toLowerCase()}` : "") +
      `\n${esc(out.status)}`);
  }
  for (const b of briefs) if (b.sent) sent.push(`${b.name} brief`);
  if (grades && weekDue) { if (await send(scorecard(J.list, grades, now))) { state.__week = { date: ny.date, seen: now }; sent.push("weekly scorecard"); } }
  if (grades && dayDue) { if (await send(daily(J.list, grades, out.setups, now, repDate))) { if (!DAILY) state.__day = { date: repDate, seen: now }; sent.push("daily scoreboard"); } }
  // every alerted trade goes into the journal with its fixed plan, so the scorecard can grade it later
  const jot = s => { if (s.plan && !J.list.some(x => x.key === s.key)) J.list.push({ key: s.key, sym: s.sym, tf: s.tf, dir: s.dir, all: !!s.all, score: s.score, sigTime: s.sigTime, at: now, plan: s.plan }); };
  const ok = s => (!ALLOW_COUNTER && /^Counter/.test(s.style || "")) ? false : MIN === "any" ? true : s.all ? true : MIN === "take" ? s.score >= 70 && s.actionable : MIN === "risk" ? s.tier === "risk" : false;
  // risk caps: count the alerted trades still open, and today's stop-outs (New York day)
  const openN = () => Object.entries(state).filter(([k, v]) => !k.startsWith("__") && v.enter > 0 && !v.done).length;
  const stopsToday = () => Object.entries(state).filter(([k, v]) => !k.startsWith("__") && v.res === "stopped" && v.done && nyNow(v.done).date === ny.date).length;
  for (const s of out.setups) {
    const st = state[s.key] || {};
    if (process.env.BOT_DEBUG) console.log(`  · ${s.sym} ${s.tf} ${s.dir} ${s.status} (${s.stateTxt}) checks ${s.checks} score ${s.score} method ${s.method}`);
    if (!ok(s) && !st.ready && !st.enter) continue;
    const recent = s.filledAt && now - s.filledAt <= Math.max(2 * s.tfMs, 45 * 60e3);
    if (s.status === "open" && !s.t1hit && !st.enter && (ok(s) || st.ready)) {
      if (recent && (s.prog == null || s.prog < 0.5)) {
        const capOpen = openN() >= MAX_OPEN, capDay = stopsToday() >= MAX_DAILY_STOPS;
        if (capOpen || capDay) {
          if (await send(`⛔ <b>Skipped: ${esc(s.sym)} ${esc(s.tf)} ${s.dir}</b>\n${capDay ? `${MAX_DAILY_STOPS} stop-outs today: no new entries until tomorrow (New York time).` : `${MAX_OPEN} alerted trades are already open (limit ${MAX_OPEN}).`}`)) { st.enter = -2; sent.push(`skipped ${s.sym} ${s.tf}`); }
        } else if (await send(msgEnter(s))) { st.enter = now; jot(s); sent.push(`enter ${s.sym} ${s.tf}`); }
      }
      else st.enter = st.enter || -1;   // too late to chase; remember so it is not sent later
    } else if (s.status === "pending" && s.chochDone && !st.conf && ok(s)) {
      if (await send(msgConfirm(s))) { st.conf = now; st.ready = st.ready || now; jot(s); sent.push(`confirmed ${s.sym} ${s.tf}`); }
    } else if (s.status === "pending" && !st.ready && ok(s) && s.near) {
      if (await send(msgReady(s))) { st.ready = now; jot(s); sent.push(`ready ${s.sym} ${s.tf}`); }
    } else if (st.enter > 0 && !st.t1 && s.t1hit && s.status === "open") {
      if (await send(`🎯 <b>${esc(s.sym)} ${esc(s.tf)} ${s.dir}: Target 1 hit (${esc(s.t1)})</b>\nTake half off and move the stop to entry (${esc(s.entry)}). Target 2: ${esc(s.t2)}.\n${links(s)}`)) { st.t1 = now; sent.push(`t1 ${s.sym} ${s.tf}`); }
    } else if (st.enter > 0 && !st.done && ["t2", "t1_be", "stopped", "timeout"].includes(s.status)) {
      if (await send(msgDone(s))) { st.done = now; st.res = s.status; sent.push(`done ${s.sym} ${s.tf}`); }
    }
    if (Object.keys(st).length) state[s.key] = { ...st, seen: now };
  }
  // forget anything older than 10 days
  J.list = J.list.filter(t => now - t.at <= 35 * 864e5); J.seen = now;
  for (const k of Object.keys(state)) if (now - (state[k].seen || 0) > 10 * 864e5) delete state[k];
  fs.writeFileSync(STATE, JSON.stringify(state));
  console.log(sent.length ? `Sent: ${sent.join(", ")}` : "No new alerts.");
})().catch(e => { console.error(e); try { fs.existsSync(STATE) || fs.writeFileSync(STATE, "{}"); } catch (_) {} process.exit(1); });
