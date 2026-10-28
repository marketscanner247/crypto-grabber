// Crypto Grabber → Telegram alerts.
// Runs the site's own scan in a headless browser, then messages Telegram when
//   • a setup that meets every check appears and is waiting for its entry ("Setup ready"), and
//   • its recommended entry triggers ("Enter now").
// It remembers what it already sent in bot/state.json, so each alert goes out once.
//
// Environment:
//   TELEGRAM_TOKEN, TELEGRAM_CHAT_ID  from @BotFather / @userinfobot (GitHub secrets). Without them it only prints.
//   ALERT_MIN   risk = setups that meet every check, plus high-risk ones scoring 50+ (marked ⚠️) (default; on 4h
//                      with counter-trend setups excluded, both groups were profitable over the 365-day backtest)
//               all  = only setups that meet every check
//               take = every check, or a score of 70+
//               any  = every signal (handy to confirm alerts work)
//   ALERT_TFS   timeframes to scan, default "4h" (the only timeframe that held up in the 120-day backtest)
//   TZ_NAME     time zone for times in messages, default America/Toronto
//   SITE_URL    link added to messages (defaults to the GitHub Pages address of this repo)
//   TEST=true   also send a "connected" test message
//   BRIEF=true  send the daily BTC, ETH and alts briefs now (otherwise once a day, on the first run after 9:30 am New York time)
//   SCORECARD=true  send the weekly scorecard now (otherwise once a week, on the first run after 6 pm New York time on Sunday)
//   BROWSER_CHANNEL=chrome  use the installed Google Chrome instead of Playwright's Chromium
//   CG_GITHUB_TOKEN  a GitHub token that can write this repo's contents: the permanent trade record (bot/record.json on
//                    the server) is then published to data/trades.json, which the app reads on every device
//   CG_GITHUB_REPO   owner/repo for that file (default marketscanner247/crypto-grabber)
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, ".."), STATE = path.join(__dirname, "state.json"), REC = path.join(__dirname, "record.json");
const GH_TOKEN = process.env.CG_GITHUB_TOKEN || "", GH_REPO = process.env.CG_GITHUB_REPO || "marketscanner247/crypto-grabber", GH_PATH = "data/trades.json";
const TOKEN = process.env.TELEGRAM_TOKEN || "", CHAT = process.env.TELEGRAM_CHAT_ID || "";
const MIN = (process.env.ALERT_MIN || "risk").toLowerCase();
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
const MAX_OPEN = +process.env.MAX_OPEN || 3;
// Alts move with BTC: several alt longs (or shorts) at once are one big BTC bet. At most this many open the same way.
const MAX_SAME_DIR = +process.env.MAX_SAME_DIR || 2;
// Every setup that passes the Most profit rules is alerted, labelled with the levels it fits, by how much Target 1 pays:
// 🛡️ Safest (1.5R+, fits all three) · ⚖️ Balanced (1.2–1.5R) · 🚀 Most profit only (under 1.2R).
// 2-year 4h backtest: Most profit +84R (worst drop −17R), Balanced +76R (−10R, both years profitable), Safest +60R (−6.5R).
// TRADES=bal or TRADES=safe sends only that level and above (default: all three).
const MIN_RR = { max: 0, bal: 1.2, safe: 1.5 }[(process.env.TRADES || (/^(1|true|yes)$/i.test(process.env.SAFER || "") ? "safe" : "max")).toLowerCase()] ?? 0;
const LVL = rr => rr == null ? null : rr >= 1.5 ? { k: "safe", t: "🛡️ SAFEST", d: "fits all three levels" } : rr >= 1.2 ? { k: "bal", t: "⚖️ BALANCED", d: "fits Balanced and Most profit" } : { k: "max", t: "🚀 MOST PROFIT ONLY", d: "skip it if you trade Balanced or Safest" };
const lvlLine = s => { const L = LVL(s.rr1); return L ? `\n<b>${L.t}</b> · Target 1 pays ${s.rr1.toFixed(1)}R · ${L.d}` : ""; };
const MAX_DAILY_STOPS = +process.env.MAX_DAILY_STOPS || 3;   // no new entries for the rest of the day after this many stops
// The 120-day backtest lost money on counter-trend setups in every version, so they are not alerted unless asked for.
const ENTRY = (process.env.ENTRY || "zone").toLowerCase();   // zone = limit orders at the order block (default) · ltf = wait for the lower-timeframe CHoCH
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
const okS = s => (!ALLOW_COUNTER && /^Counter/.test(s.style || "")) ? false : MIN === "any" ? true : s.all ? true : MIN === "take" ? s.score >= 70 && s.actionable : MIN === "risk" ? s.tier === "risk" : false;
const whyNot = s => okS(s) ? null : (s.block || (/^Counter/.test(s.style || "") ? `${s.style}: the bot skips counter-trend setups` : "below the alert rules"));
// ---------- permanent trade record ----------
// Every setup the bot sees (alerted or not) with its fixed plan; open ones are re-played each run until they close.
// Setups that never filled are dropped after 7 days; filled trades are kept for good.
function loadRec() { try { const r = JSON.parse(fs.readFileSync(REC, "utf8")); if (Array.isArray(r.list)) return r; } catch (e) {} return { list: [] }; }
const trimRec = r => { const g = r.g || {}, p = r.plan || {};
  return { key: r.key, sym: r.sym, tf: r.tf, dir: r.dir, sigTime: r.sigTime, seen: r.seen, alerted: !!r.alerted, why: r.why || null, rr1: p.rr1 ?? null, all: !!r.all, score: r.score ?? null,
    entry: p.entry, stop: p.stop, t1: p.t1, status: g.status || "pending", r: g.r ?? 0, fill: g.fill ?? 0, t1hit: !!g.t1, enteredAt: g.enteredAt || null, closedAt: g.closedAt || null,
    entryP: g.entryP ?? null, stopA: g.stopA ?? null, stopNow: g.stopNow ?? null, last: g.last ?? null }; };
async function gh(method, url, body) {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${url}`, { method, headers: { authorization: `Bearer ${GH_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "crypto-grabber-bot", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) };
}
// Publish when a trade opens, hits Target 1 or closes; otherwise at most every 30 minutes (live P/L).
async function publishRec(rec, now) {
  if (!GH_TOKEN) return null;
  const list = rec.list.filter(r => r.g && (r.g.fill > 0 || r.g.status === "pending")).map(trimRec);
  const sig = JSON.stringify(list.map(t => [t.key, t.status, t.t1hit, t.alerted])), full = JSON.stringify(list);
  if (sig === rec.pubSig && (full === rec.pubFull || now - (rec.pubAt || 0) < 30 * 60e3)) return null;
  const body = JSON.stringify({ updated: now, note: "Crypto Grabber trade record, written by the alert bot", trades: list });
  const cur = await gh("GET", `${GH_PATH}?ref=main`);
  const put = await gh("PUT", GH_PATH, { message: "trades: update record", content: Buffer.from(body).toString("base64"), sha: cur.ok ? cur.j.sha : undefined, branch: "main" });
  if (!put.ok) { console.error("trade record publish failed:", put.status, put.j && put.j.message); return false; }
  rec.pubSig = sig; rec.pubFull = full; rec.pubAt = now; return true;
}
function head(s, kind) {
  const icon = risky(s) ? "⚠️" : kind === "enter" ? (s.dir === "long" ? "🟢" : "🔴") : kind === "ready" ? "🟡" : "⚪";
  const title = (risky(s) ? "HIGH RISK · " : "") + (kind === "enter" ? `ENTER ${s.dir.toUpperCase()} NOW` : kind === "ready" ? `SETUP READY · ${s.dir}` : "UPDATE");
  return `${icon} <b>${title} · ${esc(s.sym)} ${esc(s.tf)}</b>${lvlLine(s)}\n${esc(s.label)} · ${esc(s.style)} · score ${s.score} · ${s.all ? "✓ all 5 checks" : `${s.checks} checks`}`;
}
const riskNote = s => risky(s) ? `⚠️ Enter at your own risk. Missing: ${esc(s.missing.slice(0, 3).join("; "))}.\nHalf size (already in the Size line).\n` : "";
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
    `Target 1: <b>${esc(s.t1)}</b> (${pct(s.t1Pct)}, ${rr != null ? rr.toFixed(1) : "?"}R) · ${s.trail ? "take half there, move the stop to entry and trail the rest" : "take all profit there"}\nPrice now: ${esc(s.live)}`;
}
function sizeLine(s) {
  const p = Math.abs(s.stopNowPct ?? s.stopPct); if (!p) return "";
  const why = [risky(s) && "high risk", s.btcHalf && "BTC below its 4h EMA 50"].filter(Boolean), risk = why.length ? RISK / 2 : RISK, pos = risk / (p / 100);
  return `\nSize: risk $${risk} → $${pos >= 1000 ? Math.round(pos).toLocaleString("en-US") : pos.toFixed(0)} position${why.length ? ` (half size: ${why.join(", ")})` : ""}${s.confirm && !s.entryNow ? " (estimate, final at the CHoCH)" : ""}`;
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
  return `🔔 <b>${risky(s) ? "⚠️ " : ""}CONFIRMED · PLACE LIMIT ${w} · ${esc(s.sym)} ${esc(s.tf)}</b>${lvlLine(s)}\n` +
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
  const t = s.missed ? "Missed: price ran to Target 1 without the entry. Don't chase it." : s.early ? "↩️ Closed early: the lower timeframe broke structure against the trade before Target 1" : { t2: s.t1all ? "✅ Target hit: whole position closed in profit" : "✅ Target 2 hit", t1_be: s.trail ? `✅ Target 1 hit, then the trailing stop closed the rest${s.r != null ? ` (${s.r >= 0 ? "+" : ""}${s.r.toFixed(2)}R in total)` : ""}` : "Target 1 hit, rest closed at entry", stopped: "❌ Stopped out", no_trigger: "Entry never triggered, setup expired", timeout: "Closed (time limit)" }[s.status] || s.stateTxt;
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
      L.push(`✅ Won: <b>${S.wins}</b>${S.t2 || S.be ? ` (${[S.t2 && `${S.t2} hit the target`, S.be && `${S.be} Target 1 then trailed out`].filter(Boolean).join(", ")})` : ""}`);
      L.push(`❌ Stop loss: <b>${S.stop}</b>${S.timeout ? ` · ⏱ closed on time limit: ${S.timeout}` : ""}`);
      L.push(`Win rate: <b>${Math.round(S.wins / S.closed * 100)}%</b> · average ${R(S.avgR)} per trade`);
      L.push(`Profit: ${usd(S.pnl)} · fees −$${S.fees.toFixed(2)} · <b>Net ${usd(S.net)}</b>`);
    } else L.push("No trades closed yet.");
    if (S.open) L.push(`⏳ Still open: ${S.open} (${usd(S.unreal)} right now, counted when closed)`);
    L.push("");
    const rr = t => t.plan && t.plan.rr1 != null ? t.plan.rr1 : 0;
    L.push(line("🚀 Most profit (all)", stats(wk)));
    L.push(line("⚖️ Balanced (1.2R+)", stats(wk.filter(t => rr(t) >= 1.2))));
    L.push(line("🛡️ Safest (1.5R+)", stats(wk.filter(t => rr(t) >= 1.5))));
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
  const lv = t => { const r = t.plan && t.plan.rr1; return r == null ? "" : r >= 1.5 ? " 🛡️" : r >= 1.2 ? " ⚖️" : " 🚀"; };
  for (const t of today) L.push(`${t.g.early ? "↩️" : ic[t.g.status] || "·"} ${tag(t)}${lv(t)} ${rTxt(t.g.r)}`);
  if (today.length) { const sum = f => today.filter(f).reduce((a, t) => a + t.g.r, 0), r1 = t => (t.plan && t.plan.rr1) || 0;
    L.push(`By level: 🚀 Most profit ${rTxt(sum(() => true))} · ⚖️ Balanced ${rTxt(sum(t => r1(t) >= 1.2))} · 🛡️ Safest ${rTxt(sum(t => r1(t) >= 1.5))}`); }
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
  let out, briefs = [], rot = null;
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
  const rec = loadRec();
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load" });
    // briefs first, so they land right at 9:30 instead of after the scan
    if (briefDue) for (const [name, fn] of [["BTC", () => window.cgBrief("BTC")], ["ETH", () => window.cgBrief("ETH")], ["Alts", () => window.cgAltBrief()]]) {
      try { briefs.push({ name, ...(await page.evaluate(fn)) }); } catch (e) { console.error(`${name} brief failed:`, e.message); }
    }
    for (const b of briefs) if (await send(b.html + (SITE && b.name === "Alts" ? `\n<a href="${esc(SITE)}">Crypto Grabber</a>` : ""))) { b.sent = true; if (!state.__brief || state.__brief.date !== ny.date) state.__brief = { date: ny.date, seen: Date.now() }; }
    if (briefs.some(b => b.sent)) try { fs.writeFileSync(STATE, JSON.stringify(state)); } catch (e) {}   // don't resend if the scan fails
    out = await page.evaluate(([tfs, entry, minRR]) => window.cgBot({ tfs, entry, minRR }), [TFS, ENTRY, MIN_RR]);
    try { rot = await page.evaluate(() => window.cgRotation && window.cgRotation()); } catch (e) {}
    try {
      for (const s of out.setups) { if (!s.plan || !s.sigTime) continue; let r = rec.list.find(x => x.key === s.key);
        if (!r) rec.list.push(r = { key: s.key, sym: s.sym, tf: s.tf, dir: s.dir, sigTime: s.sigTime, seen: nowT, alerted: okS(s), why: whyNot(s), all: !!s.all, score: s.score, plan: s.plan });
        else if (okS(s) && !r.alerted) { r.alerted = true; r.why = null; } }
      const todo = rec.list.filter(r => !r.done).slice(-80);
      if (todo.length) { const g = await page.evaluate(([l, n]) => window.cgGrade(l, n), [todo, SIZE]);
        for (const x of g) { const r = rec.list.find(y => y.key === x.key); if (!r || x.err) continue; r.g = x;
          if (["t2", "t1_be", "stopped", "timeout", "no_trigger"].includes(x.status)) r.done = true; } }
    } catch (e) { console.error("trade record update failed:", e.message); }
    if (weekDue || dayDue) { try { grades = await page.evaluate(([l, n]) => window.cgGrade(l, n), [J.list, SIZE]); } catch (e) { console.error("scorecard failed:", e.message); } }
  } finally { await browser.close(); srv.close(); }

  rec.list = rec.list.filter(r => !(r.done && !(r.g && r.g.fill > 0) && nowT - r.seen > 7 * 864e5));
  try { const pub = await publishRec(rec, nowT); if (pub) console.log("Trade record published to GitHub."); } catch (e) { console.error("trade record publish failed:", e.message); }
  try { fs.writeFileSync(REC, JSON.stringify(rec)); } catch (e) { console.error("could not save the trade record:", e.message); }
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
  // Alt rotation: BTC range-bound + BTC dominance falling + alts picking up pace. One message when all three line up
  // (at most once a day), one when it fades (down to 1 of 3 or fewer).
  if (rot) {
    const R0 = state.__rot || {}, html = s => s.replace(/<(?!\/?b>)[^>]+>/g, "");
    if (rot.on && !R0.on && (!R0.onAt || now - R0.onAt > 24 * 36e5)) {
      if (await send(`🚀 <b>Alt rotation starting</b>\nBTC is ranging, BTC dominance is falling${rot.btcd != null ? ` (${rot.btcd.toFixed(1)}%)` : ""} and alts are picking up pace (7 days: alts ${rot.alt7 >= 0 ? "+" : ""}${(rot.alt7 || 0).toFixed(1)}% vs BTC ${rot.btc7 >= 0 ? "+" : ""}${(rot.btc7 || 0).toFixed(1)}%).\nMoney tends to rotate into alts now: favour longs on the strongest alts, on pullbacks. Be careful shorting alts.${SITE ? `\n<a href="${esc(SITE)}">Crypto Grabber</a>` : ""}`)) { state.__rot = { on: true, onAt: now }; sent.push("rotation on"); }
    } else if (!rot.on && R0.on && rot.n <= 1) {
      if (await send(`⚪ <b>Alt rotation fading</b>\n${html(rot.line)}`)) { state.__rot = { on: false, onAt: R0.onAt, offAt: now }; sent.push("rotation off"); }
    }
  }
  if (grades && weekDue) { if (await send(scorecard(J.list, grades, now))) { state.__week = { date: ny.date, seen: now }; sent.push("weekly scorecard"); } }
  if (grades && dayDue) { if (await send(daily(J.list, grades, out.setups, now, repDate))) { if (!DAILY) state.__day = { date: repDate, seen: now }; sent.push("daily scoreboard"); } }
  // every alerted trade goes into the journal with its fixed plan, so the scorecard can grade it later
  const jot = s => { if (s.plan && !J.list.some(x => x.key === s.key)) J.list.push({ key: s.key, sym: s.sym, tf: s.tf, dir: s.dir, all: !!s.all, score: s.score, sigTime: s.sigTime, at: now, plan: s.plan }); };
  const ok = s => (!ALLOW_COUNTER && /^Counter/.test(s.style || "")) ? false : MIN === "any" ? true : s.all ? true : MIN === "take" ? s.score >= 70 && s.actionable : MIN === "risk" ? s.tier === "risk" : false;
  // risk caps: count the alerted trades still open, and today's stop-outs (New York day)
  const openN = () => Object.entries(state).filter(([k, v]) => !k.startsWith("__") && v.enter > 0 && !v.done).length;
  const openDir = d => Object.entries(state).filter(([k, v]) => !k.startsWith("__") && v.enter > 0 && !v.done && v.dir === d).length;
  const stopsToday = () => Object.entries(state).filter(([k, v]) => !k.startsWith("__") && v.res === "stopped" && v.done && nyNow(v.done).date === ny.date).length;
  for (const s of out.setups) {
    const st = state[s.key] || {};
    if (process.env.BOT_DEBUG) console.log(`  · ${s.sym} ${s.tf} ${s.dir} ${s.status} (${s.stateTxt}) checks ${s.checks} score ${s.score} method ${s.method}`);
    if (!ok(s) && !st.ready && !st.enter) continue;
    const recent = s.filledAt && now - s.filledAt <= Math.max(2 * s.tfMs, 45 * 60e3);
    if (s.status === "open" && !s.t1hit && !st.enter && (ok(s) || st.ready)) {
      if (recent && (s.prog == null || s.prog < 0.5)) {
        const capOpen = openN() >= MAX_OPEN, capDay = stopsToday() >= MAX_DAILY_STOPS, capDir = openDir(s.dir) >= MAX_SAME_DIR;
        if (capOpen || capDay || capDir) {
          if (await send(`⛔ <b>Skipped: ${esc(s.sym)} ${esc(s.tf)} ${s.dir}</b>\n${capDay ? `${MAX_DAILY_STOPS} stop-outs today: no new entries until tomorrow (New York time).` : capOpen ? `${MAX_OPEN} alerted trades are already open (limit ${MAX_OPEN}).` : `Already ${openDir(s.dir)} ${s.dir}s open. Alts move together with BTC, so another ${s.dir} doubles the same bet (limit ${MAX_SAME_DIR}).`}`)) { st.enter = -2; sent.push(`skipped ${s.sym} ${s.tf}`); }
        } else if (await send(msgEnter(s))) { st.enter = now; st.dir = s.dir; jot(s); sent.push(`enter ${s.sym} ${s.tf}`); }
      }
      else st.enter = st.enter || -1;   // too late to chase; remember so it is not sent later
    } else if (s.status === "pending" && s.chochDone && !st.conf && ok(s)) {
      if (await send(msgConfirm(s))) { st.conf = now; st.ready = st.ready || now; jot(s); sent.push(`confirmed ${s.sym} ${s.tf}`); }
    } else if (s.status === "pending" && !st.ready && ok(s) && s.near) {
      if (await send(msgReady(s))) { st.ready = now; jot(s); sent.push(`ready ${s.sym} ${s.tf}`); }
    } else if (st.enter > 0 && !st.t1 && s.t1hit && s.status === "open") {
      if (await send(`🎯 <b>${esc(s.sym)} ${esc(s.tf)} ${s.dir}: Target 1 hit (${esc(s.t1)})</b>\nTake half off and move the stop to entry (${esc(s.entry)}). ${s.trail ? `Let the rest run: you'll get a message each time the stop moves up under a new ${esc(s.tf)} swing ${s.dir === "long" ? "low" : "high"}.` : `Target 2: ${esc(s.t2)}.`}\n${links(s)}`)) { st.t1 = now; st.trailAt = s.trailStop; sent.push(`t1 ${s.sym} ${s.tf}`); }
    } else if (st.enter > 0 && st.t1 && s.trail && s.status === "open" && s.trailStop && s.trailStop !== st.trailAt) {
      if (await send(`🔒 <b>${esc(s.sym)} ${esc(s.tf)} ${s.dir}: move the stop to ${esc(s.trailStop)}</b>\nNew ${esc(s.tf)} swing ${s.dir === "long" ? "low" : "high"} confirmed. The stop on the remaining half trails behind it (exit on a ${esc(s.tf)} close past it).\n${links(s)}`)) { st.trailAt = s.trailStop; sent.push(`trail ${s.sym} ${s.tf}`); }
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
