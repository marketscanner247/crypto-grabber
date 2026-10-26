// Crypto Grabber → Telegram alerts.
// Runs the site's own scan in a headless browser, then messages Telegram when
//   • a setup that meets every check appears and is waiting for its entry ("Setup ready"), and
//   • its recommended entry triggers ("Enter now").
// It remembers what it already sent in bot/state.json, so each alert goes out once.
//
// Environment:
//   TELEGRAM_TOKEN, TELEGRAM_CHAT_ID  from @BotFather / @userinfobot (GitHub secrets). Without them it only prints.
//   ALERT_MIN   risk = setups that meet every check, plus high-risk ones scoring 50+ (marked ⚠️) (default)
//               all  = only setups that meet every check
//               take = every check, or a score of 70+
//               any  = every signal (handy to confirm alerts work)
//   ALERT_TFS   timeframes to scan, default "1h,4h,1d"
//   TZ_NAME     time zone for times in messages, default America/Toronto
//   SITE_URL    link added to messages (defaults to the GitHub Pages address of this repo)
//   TEST=true   also send a "connected" test message
//   BRIEF=true  send the daily BTC brief now (otherwise it goes out once a day, on the first run after 9:25 am New York time)
//   SCORECARD=true  send the weekly scorecard now (otherwise once a week, on the first run after 6 pm New York time on Sunday)
//   BROWSER_CHANNEL=chrome  use the installed Google Chrome instead of Playwright's Chromium
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, ".."), STATE = path.join(__dirname, "state.json");
const TOKEN = process.env.TELEGRAM_TOKEN || "", CHAT = process.env.TELEGRAM_CHAT_ID || "";
const MIN = (process.env.ALERT_MIN || "risk").toLowerCase();
const TFS = (process.env.ALERT_TFS || "1h,4h,1d").split(",").map(s => s.trim()).filter(Boolean);
const TZ = process.env.TZ_NAME || "America/Toronto";
const repo = process.env.GITHUB_REPOSITORY || "";
const SITE = process.env.SITE_URL || (repo ? `https://${repo.split("/")[0].toLowerCase()}.github.io/${repo.split("/")[1]}/` : "");
const TEST = String(process.env.TEST || "").toLowerCase() === "true";
const BRIEF = String(process.env.BRIEF || "").toLowerCase() === "true";
const SCORECARD = String(process.env.SCORECARD || "").toLowerCase() === "true";
const SIZE = 1000, FEE = 0.001;   // scorecard: $1,000 per trade; fee estimate 0.1% per side
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
  const ent = s.split
    ? `${w} half at <b>${esc(s.e1)}</b> (${esc(s.e1src)}) + half at <b>${esc(s.e2)}</b> (order block middle) · average ${esc(s.entry)}`
    : `Entry: <b>${esc(s.entry)}</b> (${esc(s.method)})`;
  return `${ent}\nStop: ${esc(s.stop)} (${pct(s.stopPct)})\n` +
    `Target 1: ${esc(s.t1)} (${pct(s.t1Pct)}, ${s.rr1 != null ? s.rr1.toFixed(1) : "?"}R) · Target 2: ${esc(s.t2)} (${pct(s.t2Pct)})\nPrice now: ${esc(s.live)}`;
}
function links(s) {
  return [SITE && `<a href="${esc(SITE)}">Crypto Grabber</a>`, s.chart && `<a href="${esc(s.chart)}">Chart</a>`].filter(Boolean).join(" · ");
}
function msgReady(s) {
  return `${head(s, "ready")}\n\n${esc(s.detail || s.why)}\n\n${plan(s)}\n\n${riskNote(s)}Price is close to the entry. You'll get an <b>Enter now</b> alert when it fills.\n${links(s)}`;
}
function msgEnter(s) {
  const fillTxt = s.split && s.fill != null ? (s.fill < 1 ? `First half filled at ${esc(s.e1)}. Keep the second half as a limit at ${esc(s.e2)}.` : `Both halves filled, average ${esc(s.avg || s.entry)}.`) : "";
  return `${head(s, "enter")}\n\n${s.filledAt ? `Triggered ${when(s.filledAt)}` : ""}${s.filledAt && fillTxt ? " · " : ""}${fillTxt}\n\n${plan(s)}\n\n${riskNote(s)}${links(s)}`;
}
function msgDone(s) {
  const t = s.missed ? "Missed: price ran to Target 1 without the entry. Don't chase it." : { t2: "✅ Target 2 hit", t1_be: "Target 1 hit, rest closed at entry", stopped: "❌ Stopped out", no_trigger: "Entry never triggered, setup expired", timeout: "Closed (time limit)" }[s.status] || s.stateTxt;
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
  let out, brief = null;
  const ny = nyNow(+process.env.MOCK_NOW || Date.now());
  const briefDue = BRIEF || (ny.hm >= "09:25" && ny.hm < "12:00" && !(state.__brief && state.__brief.date === ny.date));
  const J = state.__journal = state.__journal && Array.isArray(state.__journal.list) ? state.__journal : { list: [] };
  const weekDue = SCORECARD || (ny.wd === "Sun" && ny.hm >= "18:00" && !(state.__week && state.__week.date === ny.date));
  let grades = null;
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load" });
    out = await page.evaluate(tfs => window.cgBot({ tfs }), TFS);
    if (briefDue) { try { brief = await page.evaluate(() => window.cgBrief()); } catch (e) { console.error("brief failed:", e.message); } }
    if (weekDue) { try { grades = await page.evaluate(([l, n]) => window.cgGrade(l, n), [J.list, SIZE]); } catch (e) { console.error("scorecard failed:", e.message); } }
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
  if (brief) { if (await send(brief.html + (SITE ? `\n<a href="${esc(SITE)}">Crypto Grabber</a>` : ""))) { state.__brief = { date: ny.date, seen: now }; sent.push("daily brief"); } }
  if (grades) { if (await send(scorecard(J.list, grades, now))) { state.__week = { date: ny.date, seen: now }; sent.push("weekly scorecard"); } }
  // every alerted trade goes into the journal with its fixed plan, so the scorecard can grade it later
  const jot = s => { if (s.plan && !J.list.some(x => x.key === s.key)) J.list.push({ key: s.key, sym: s.sym, tf: s.tf, dir: s.dir, all: !!s.all, score: s.score, sigTime: s.sigTime, at: now, plan: s.plan }); };
  const ok = s => MIN === "any" ? true : s.all ? true : MIN === "take" ? s.score >= 70 && s.actionable : MIN === "risk" ? s.tier === "risk" : false;
  for (const s of out.setups) {
    const st = state[s.key] || {};
    if (process.env.BOT_DEBUG) console.log(`  · ${s.sym} ${s.tf} ${s.dir} ${s.status} (${s.stateTxt}) checks ${s.checks} score ${s.score} method ${s.method}`);
    if (!ok(s) && !st.ready && !st.enter) continue;
    const recent = s.filledAt && now - s.filledAt <= Math.max(2 * s.tfMs, 45 * 60e3);
    if (s.status === "open" && !s.t1hit && !st.enter && (ok(s) || st.ready)) {
      if (recent && (s.prog == null || s.prog < 0.5)) { if (await send(msgEnter(s))) { st.enter = now; jot(s); sent.push(`enter ${s.sym} ${s.tf}`); } }
      else st.enter = st.enter || -1;   // too late to chase; remember so it is not sent later
    } else if (s.status === "pending" && !st.ready && ok(s) && s.near) {
      if (await send(msgReady(s))) { st.ready = now; jot(s); sent.push(`ready ${s.sym} ${s.tf}`); }
    } else if (st.enter > 0 && !st.t1 && s.t1hit && s.status === "open") {
      if (await send(`🎯 <b>${esc(s.sym)} ${esc(s.tf)} ${s.dir}: Target 1 hit (${esc(s.t1)})</b>\nTake half off and move the stop to entry (${esc(s.entry)}). Target 2: ${esc(s.t2)}.\n${links(s)}`)) { st.t1 = now; sent.push(`t1 ${s.sym} ${s.tf}`); }
    } else if (st.enter > 0 && !st.done && ["t2", "t1_be", "stopped", "timeout"].includes(s.status)) {
      if (await send(msgDone(s))) { st.done = now; sent.push(`done ${s.sym} ${s.tf}`); }
    }
    if (Object.keys(st).length) state[s.key] = { ...st, seen: now };
  }
  // forget anything older than 10 days
  J.list = J.list.filter(t => now - t.at <= 35 * 864e5); J.seen = now;
  for (const k of Object.keys(state)) if (now - (state[k].seen || 0) > 10 * 864e5) delete state[k];
  fs.writeFileSync(STATE, JSON.stringify(state));
  console.log(sent.length ? `Sent: ${sent.join(", ")}` : "No new alerts.");
})().catch(e => { console.error(e); try { fs.existsSync(STATE) || fs.writeFileSync(STATE, "{}"); } catch (_) {} process.exit(1); });
