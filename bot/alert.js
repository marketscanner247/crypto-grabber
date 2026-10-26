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
// New York clock (handles daylight saving)
function nyNow(t) {
  const p = {}; for (const x of new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
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
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load" });
    out = await page.evaluate(tfs => window.cgBot({ tfs }), TFS);
    if (briefDue) { try { brief = await page.evaluate(() => window.cgBrief()); } catch (e) { console.error("brief failed:", e.message); } }
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
  const ok = s => MIN === "any" ? true : s.all ? true : MIN === "take" ? s.score >= 70 && s.actionable : MIN === "risk" ? s.tier === "risk" : false;
  for (const s of out.setups) {
    const st = state[s.key] || {};
    if (process.env.BOT_DEBUG) console.log(`  · ${s.sym} ${s.tf} ${s.dir} ${s.status} (${s.stateTxt}) checks ${s.checks} score ${s.score} method ${s.method}`);
    if (!ok(s) && !st.ready && !st.enter) continue;
    const recent = s.filledAt && now - s.filledAt <= Math.max(2 * s.tfMs, 45 * 60e3);
    if (s.status === "open" && !s.t1hit && !st.enter && (ok(s) || st.ready)) {
      if (recent && (s.prog == null || s.prog < 0.5)) { if (await send(msgEnter(s))) { st.enter = now; sent.push(`enter ${s.sym} ${s.tf}`); } }
      else st.enter = st.enter || -1;   // too late to chase; remember so it is not sent later
    } else if (s.status === "pending" && !st.ready && ok(s) && s.near) {
      if (await send(msgReady(s))) { st.ready = now; sent.push(`ready ${s.sym} ${s.tf}`); }
    } else if (st.enter > 0 && !st.t1 && s.t1hit && s.status === "open") {
      if (await send(`🎯 <b>${esc(s.sym)} ${esc(s.tf)} ${s.dir}: Target 1 hit (${esc(s.t1)})</b>\nTake half off and move the stop to entry (${esc(s.entry)}). Target 2: ${esc(s.t2)}.\n${links(s)}`)) { st.t1 = now; sent.push(`t1 ${s.sym} ${s.tf}`); }
    } else if (st.enter > 0 && !st.done && ["t2", "t1_be", "stopped", "timeout"].includes(s.status)) {
      if (await send(msgDone(s))) { st.done = now; sent.push(`done ${s.sym} ${s.tf}`); }
    }
    if (Object.keys(st).length) state[s.key] = { ...st, seen: now };
  }
  // forget anything older than 10 days
  for (const k of Object.keys(state)) if (now - (state[k].seen || 0) > 10 * 864e5) delete state[k];
  fs.writeFileSync(STATE, JSON.stringify(state));
  console.log(sent.length ? `Sent: ${sent.join(", ")}` : "No new alerts.");
})().catch(e => { console.error(e); try { fs.existsSync(STATE) || fs.writeFileSync(STATE, "{}"); } catch (_) {} process.exit(1); });
