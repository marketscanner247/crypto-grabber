// Crypto Grabber live watcher: instant Telegram alerts for the few coins that need them.
// The 5-minute check (alert.js) writes bot/watch.json: setups it has marked "ready" and trades that are open. This process
// keeps a live Binance price stream open for just those coins and alerts within seconds when price reaches
//   • the first entry limit of a ready setup      → 🟢/🔴 ENTERED
//   • Target 1 of an open trade                   → 🎯 TARGET 1 HIT
//   • the stop of an open trade (a heads-up: the stop exits on a candle close) → ⚠️ AT THE STOP
//   • the hard stop (0.5R past the stop)           → 🛑 STOP LOSS HIT
// Everything it sends is written to bot/watch-state.json, so the 5-minute check never sends the same alert again.
// Runs as the crypto-grabber-watch service (installed by: cg update). It restarts itself when watch.js changes on disk.
const fs = require("fs"), path = require("path");
// price stream: Node 22+ has WebSocket built in; older Node uses the "ws" package (installed with the bot)
let WS = globalThis.WebSocket; if (!WS) try { WS = require("ws"); } catch (e) {}
const WATCH = path.join(__dirname, "watch.json"), WSTATE = path.join(__dirname, "watch-state.json"), SELF = __filename;
const TOKEN = process.env.TELEGRAM_TOKEN || "", CHAT = process.env.TELEGRAM_CHAT_ID || "", DYOR_CHAT = process.env.TELEGRAM_DYOR_CHAT_ID || "";
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = v => v == null || !isFinite(v) ? "–" : v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toPrecision(4);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let list = [], caps = {}, wst = {}, lastLoad = 0, selfM = 0;
try { wst = JSON.parse(fs.readFileSync(WSTATE, "utf8")); } catch (e) {}
try { selfM = fs.statSync(SELF).mtimeMs; } catch (e) {}
const saveW = () => { try { fs.writeFileSync(WSTATE, JSON.stringify(wst)); } catch (e) { log("could not save watch-state:", e.message); } };

async function send(html, chat) {
  if (!TOKEN || !chat) { log("[dry run]", html.replace(/<[^>]+>/g, "")); return true; }
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: html, parse_mode: "HTML", disable_web_page_preview: true }) });
      const j = await r.json(); if (j.ok) return true;
      log("Telegram said:", j.description); if (r.status !== 429) return false;
      await new Promise(res => setTimeout(res, ((j.parameters && j.parameters.retry_after) || 3) * 1000));
    } catch (e) { log("Telegram send failed:", e.message); await new Promise(res => setTimeout(res, 2000 * (i + 1))); }
  }
  return false;
}

// ---------- live events for the website ----------
// Each alert is also written to data/live.json on GitHub, so the site shows it within about a minute instead of
// waiting for the candle to close. Last 48 hours only; several events close together go out as one update.
const GH_TOKEN = process.env.CG_GITHUB_TOKEN || "", GH_REPO = process.env.CG_GITHUB_REPO || "marketscanner247/crypto-grabber", LIVE = path.join(__dirname, "live.json");
let liveEv = []; try { liveEv = JSON.parse(fs.readFileSync(LIVE, "utf8")).events || []; } catch (e) {}
let pubT = null, pubBusy = false;
async function gh(method, body) {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/data/live.json${method === "GET" ? "?ref=main" : ""}`, { method,
    headers: { authorization: `Bearer ${GH_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "crypto-grabber-watch", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) };
}
async function publishLive() {
  pubT = null; if (!GH_TOKEN) return; if (pubBusy) { pubT = setTimeout(publishLive, 3000); return; }
  pubBusy = true;
  try {
    for (let i = 0; i < 3; i++) {
      const cur = await gh("GET"), body = JSON.stringify({ updated: Date.now(), note: "Crypto Grabber live events, written by the live watcher", events: liveEv });
      const put = await gh("PUT", { message: "live: alert", content: Buffer.from(body).toString("base64"), sha: cur.ok ? cur.j.sha : undefined, branch: "main" });
      if (put.ok) { log("live events published"); break; }
      log("live publish failed:", put.status, put.j && put.j.message); await new Promise(r => setTimeout(r, 3000));
    }
  } catch (e) { log("live publish failed:", e.message); }
  pubBusy = false;
}
function addLive(x, ev, p) {
  const now = Date.now();
  liveEv = liveEv.filter(e => now - e.at < 48 * 36e5);
  liveEv.push({ key: x.key.replace(/^dyor:/, ""), ev, p, at: now, sym: x.sym, tf: x.tf, dir: x.dir, chat: x.chat, sigTime: x.sigTime, alerted: x.chat !== "dyor",
    entry: x.entry, stop: x.stop, hard: x.hard, t1: x.t1, rr1: x.rr1, split: !!x.split });
  try { fs.writeFileSync(LIVE, JSON.stringify({ events: liveEv })); } catch (e) {}
  if (!pubT) pubT = setTimeout(publishLive, 2000);
}

// ---------- what to watch ----------
function load() {
  try {
    const st = fs.statSync(WATCH); if (st.mtimeMs === lastLoad) return false; lastLoad = st.mtimeMs;
    const j = JSON.parse(fs.readFileSync(WATCH, "utf8"));
    caps = j.caps || {};
    list = (j.items || []).filter(x => x && x.id && isFinite(x.stop) && isFinite(x.t1));
    // forget fired events for trades no longer watched (older than 10 days)
    const now = Date.now(); for (const k of Object.keys(wst)) if (now - (wst[k].seen || 0) > 10 * 864e5) delete wst[k];
    log(`watching ${list.length}: ${list.map(x => `${x.sym} ${x.tf}${x.chat === "dyor" ? " (DYOR)" : ""} ${x.state === "wait" ? "waiting" : "open"}`).join(", ") || "nothing"}`);
    return true;
  } catch (e) { if (list.length) log("watch.json unreadable:", e.message); return false; }
}

// ---------- price stream ----------
const socks = {};   // "spot" | "perp" → { ws, key }
function connect(kind, ids) {
  const key = ids.slice().sort().join(","), cur = socks[kind];
  if (cur && cur.key === key && cur.ws && cur.ws.readyState <= 1) return;
  if (cur && cur.ws) try { cur.ws.close(); } catch (e) {}
  if (!ids.length) { delete socks[kind]; return; }
  const base = kind === "perp" ? "wss://fstream.binance.com/stream?streams=" : "wss://data-stream.binance.vision/stream?streams=";
  // every trade (not a once-a-second snapshot), so a quick wick to a target or stop is never missed
  const ws = new WS(base + ids.map(i => i.toLowerCase() + "@aggTrade").join("/"));
  socks[kind] = { ws, key, at: Date.now() };
  ws.onmessage = ev => { try { const d = JSON.parse(ev.data).data; if (d && d.s) { socks[kind] && (socks[kind].last = Date.now()); onPrice(d.s, +(d.p ?? d.c)); } } catch (e) {} };
  ws.onclose = () => { if (socks[kind] && socks[kind].ws === ws) socks[kind].ws = null; };
  ws.onerror = () => {};
}
function resubscribe() {
  connect("spot", [...new Set(list.filter(x => !x.perp).map(x => x.id))]);
  connect("perp", [...new Set(list.filter(x => x.perp).map(x => x.id))]);
}

// ---------- events ----------
const busy = new Set();
async function fire(x, ev, html, val) {
  const k = x.key, w = wst[k] || {};
  if (w[ev] || busy.has(k + ev)) return; busy.add(k + ev);
  const ok = await send(html, x.chat === "dyor" ? DYOR_CHAT : CHAT);
  busy.delete(k + ev);
  if (ok) { mark(x, ev, val ?? Date.now()); log("sent", ev, x.sym, x.tf, x.chat); if (val == null && ev !== "atstop" && ev !== "atstop2") addLive(x, ev, ev === "enter" ? x.e1 : ev === "t1" ? x.t1 : x.hard); }
}
const reach = (x, p, lvl) => x.dir === "long" ? p >= lvl : p <= lvl;   // moved to a level in the trade's favour
const back = (x, p, lvl) => x.dir === "long" ? p <= lvl : p >= lvl;    // moved to a level against the trade
const closeAt = tf => { const m = { "15m": 9e5, "1h": 36e5, "4h": 144e5, "1d": 864e5 }[tf]; return m ? new Date(Math.ceil(Date.now() / m) * m).toLocaleTimeString("en-CA", { timeZone: process.env.TZ_NAME || "America/Toronto", hour: "2-digit", minute: "2-digit", hour12: false }) : "the candle close"; };
// risk caps, as in the 5-minute check: its counts plus what this watcher entered/stopped since
function capHit(x) {
  if (x.chat === "dyor" || !caps.maxOpen) return null;
  const mine = list.filter(y => y.chat !== "dyor" && y.state === "wait" && wst[y.key]);
  const open = (caps.open || 0) + mine.filter(y => wst[y.key].enter > 0 && !wst[y.key].done).length;
  const dir = (caps[x.dir] || 0) + mine.filter(y => y.dir === x.dir && wst[y.key].enter > 0 && !wst[y.key].done).length;
  const stops = (caps.stops || 0) + list.filter(y => y.chat !== "dyor" && wst[y.key] && wst[y.key].done).length;
  if (stops >= caps.maxStops) return `${caps.maxStops} stop-outs today: no new entries until tomorrow (New York time).`;
  if (open >= caps.maxOpen) return `${caps.maxOpen} alerted trades are already open (limit ${caps.maxOpen})${caps.list && caps.list.length ? `: ${esc(caps.list.join(", "))}` : ""}.`;
  if (dir >= caps.maxDir) return `Already ${dir} ${x.dir}s open. Alts move together with BTC, so another ${x.dir} doubles the same bet (limit ${caps.maxDir}).`;
  return null;
}
function mark(x, ev, v) { const w = wst[x.key] = wst[x.key] || {}; w[ev] = v; w.dir = x.dir; w.seen = Date.now(); saveW(); }
function onPrice(id, p) {
  if (!isFinite(p)) return;
  for (const x of list) {
    if (x.id !== id) continue;
    const w = wst[x.key] || {}, name = `${esc(x.sym)} ${esc(x.tf)} ${x.dir}`, dy = x.chat === "dyor" ? "🔍 " : "", tag = x.chat === "dyor" ? " · DYOR" : "";
    if (x.state === "wait" && !w.enter) {
      if (back(x, p, x.stop)) { mark(x, "enter", -1); continue; }        // price is already past the stop: the setup failed, no entry
      if (!back(x, p, x.e1)) continue;
      const cap = capHit(x);
      if (cap) { fire(x, "enter", `⛔ <b>SKIPPED · ${name}</b> · ⚡ live\n${cap}`, -2); continue; }
      fire(x, "enter", String(x.msg || `<b>ENTERED ${name}</b>`).replace(/Price now: [^\n]*/, `Price now: <b>${fmt(p)}</b> · ⚡ live, filled just now`));
      continue;
    }
    const open = x.state === "open" || w.enter > 0;
    if (!open || w.done) continue;
    const t1done = x.t1hit || w.t1;
    if (!t1done && reach(x, p, x.t1))
      fire(x, "t1", `${dy}🎯 <b>TARGET 1 HIT · ${name}</b>${tag} · ⚡ live at ${fmt(p)}\n${x.trail ? `Take half off, move the stop to entry (${fmt(x.entry)}) and let the rest trail.` : "Take the profit."}`);
    else if (!t1done && isFinite(x.hard) && back(x, p, x.hard))
      fire(x, "done", `${dy}🛑 <b>STOP LOSS HIT · ${name}</b>${tag} · ⚡ live: price ${fmt(p)} reached the hard stop ${fmt(x.hard)}. Close the trade.`);
    else if (!w[t1done ? "atstop2" : "atstop"]) {
      const stop = t1done ? (isFinite(x.trailLvl) ? x.trailLvl : x.entry) : x.stop;
      if (back(x, p, stop)) fire(x, t1done ? "atstop2" : "atstop", `${dy}⚠️ <b>AT THE STOP · ${name}</b>${tag} · ⚡ price ${fmt(p)}\nThe stop (${fmt(stop)}) exits on a ${esc(x.tf)} candle close past it: next close at ${closeAt(x.tf)}.${!t1done && isFinite(x.hard) ? ` If price reaches ${fmt(x.hard)} first, close it right away.` : ""}`);
    }
  }
}

// ---------- main loop ----------
if (!WS) { console.log("No WebSocket available: run  cg update  to install it. Live watcher waiting."); setInterval(() => { try { if (fs.statSync(SELF).mtimeMs !== selfM) process.exit(0); } catch (e) {} }, 15e3); }
else {
load(); resubscribe();
setInterval(() => {
  try { if (fs.statSync(SELF).mtimeMs !== selfM) { log("watch.js updated, restarting"); process.exit(0); } } catch (e) {}
  if (load()) resubscribe();
  // reconnect a dropped stream
  for (const k of Object.keys(socks)) if (socks[k].ws && Date.now() - (socks[k].last || socks[k].at) > 120e3) { log(`${k} stream quiet for 2 minutes, reconnecting`); try { socks[k].ws.close(); } catch (e) {} socks[k].ws = null; }
  for (const k of Object.keys(socks)) if (!socks[k].ws) { const ids = socks[k].key.split(",").filter(Boolean); delete socks[k]; connect(k, ids); }
}, 15e3);
log("live watcher started");
}
