// Full-rules backtest on real history, run on the alert server:  cg backtest   (or: node bot/backtest.js)
// Uses the app's own engine (window.cgBacktest): each past signal is judged only with data available at its close,
// for three stop settings, and the result goes to Telegram and the console.
//   BT_DAYS (default 120), BT_TFS (default 1h,4h,1d), BT_TOP (default 50)
//   BT_SET: "zone" (default: the zone entry and its tweaks A–A7) or "ltf" (the lower-timeframe entries B–I)
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("playwright");
const ROOT = path.join(__dirname, "..");
const TOKEN = process.env.TELEGRAM_TOKEN || "", CHAT = process.env.TELEGRAM_CHAT_ID || "";
const DAYS = +process.env.BT_DAYS || 120, TOP = +process.env.BT_TOP || 50;
const SET = process.env.BT_SET || "zone";
const TFS = (process.env.BT_TFS || "1h,4h,1d").split(",").map(s => s.trim()).filter(Boolean);

async function send1(html) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT, text: html, parse_mode: "HTML", disable_web_page_preview: true }) });
      const j = await r.json(); if (j.ok) return true; console.error("Telegram said:", j.description);
    } catch (e) { console.error("Telegram send failed:", e.message); }
    await new Promise(r => setTimeout(r, 3000 * (i + 1)));
  }
  return false;
}
// Telegram allows 4,096 characters per message: send the report in pieces, one block per variant
async function send(html) {
  if (!TOKEN || !CHAT) return;
  const parts = html.split("\n\n"), out = [];
  for (const p of parts) { if (out.length && (out[out.length - 1] + "\n\n" + p).length < 3800) out[out.length - 1] += "\n\n" + p; else out.push(p); }
  for (const m of out) await send1(m);
}
function serve() {
  const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png" };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
    const f = path.join(ROOT, path.normalize(p));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r(srv)));
}
const pc = v => v == null ? "–" : `${Math.round(v * 100)}%`, rr = v => v == null ? "–" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;
const line = (lab, x) => `${lab}: ${x.closed} closed · win ${pc(x.winRate)} · avg ${rr(x.avgR)} · total ${x.totalR >= 0 ? "+" : ""}${x.totalR.toFixed(1)}R${x.early ? ` · ${x.early} early exits` : ""}`;

(async () => {
  const srv = await serve(), browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {});
  const page = await browser.newPage({ timezoneId: process.env.TZ_NAME || "America/Toronto" });
  page.on("console", m => { if (/^loaded /.test(m.text())) process.stdout.write("\r" + m.text() + "   "); });
  if (process.env.CG_MOCK) await require(path.resolve(process.env.CG_MOCK)).install(page);
  let r;
  try {
    await page.goto(`http://127.0.0.1:${srv.address().port}/index.html`, { waitUntil: "load" });
    console.log(`Backtesting the top ${TOP} coins, ${TFS.join(", ")}, last ${DAYS} days. This takes a few minutes...`);
    r = await page.evaluate(o => window.cgBacktest(o), { days: DAYS, tfs: TFS, top: TOP, progress: true, set: SET });
  } finally { await browser.close(); srv.close(); }
  console.log("");
  const L = [`🧪 <b>Backtest · last ${r.days} days · ${r.coins} coins · ${r.tfs.join(", ")}</b>`,
    `Real prices, today's rules, each signal judged only with data from its own time. Fees ${r.fee}% per trade.`, ""];
  const short = SET !== "ltf";
  const hl = r.days >= 700 ? `${Math.round(r.days / 730)} year${r.days >= 1400 ? "s" : ""}` : `${Math.round(r.days / 60)} months`;
  if (short) {   // one block per tweak, then which kinds of setups made the money under the default rules
    const base = r.variants[0].alerted;
    for (const v of r.variants) {
      const d = v.alerted.totalR - base.totalR;
      L.push(`<b>${v.name}</b>${v === r.variants[0] ? "" : ` (${d >= 0 ? "+" : ""}${d.toFixed(1)}R vs A)`}`);
      L.push(line("All alerted", v.alerted) + (v.alerted.maxDD != null ? ` · worst drop −${v.alerted.maxDD.toFixed(1)}R` : ""));
      if (v.half1) L.push(`· first ${hl} ${v.half1.totalR >= 0 ? "+" : ""}${v.half1.totalR.toFixed(1)}R (${v.half1.closed}) · last ${hl} ${v.half2.totalR >= 0 ? "+" : ""}${v.half2.totalR.toFixed(1)}R (${v.half2.closed})`);
      L.push(line("· with the trend", v.withTrend));
      L.push(line("· all 5 checks", v.aplus));
      L.push("");
    }
    const a = r.variants[0];
    if (a.cuts) {
      L.push(`<b>Inside A: which setups made the money</b>`);
      for (const [lab, x] of a.cuts) if (x.closed) L.push(line(`· ${lab}`, x));
      L.push("");
    }
  }
  for (const v of short ? [] : r.variants) {
    L.push(`<b>${v.name}</b>`);
    L.push(line("Alerted (all checks + high risk)", v.alerted));
    L.push(line("· all 5 checks", v.aplus));
    L.push(line("· ⚠️ high risk", v.risk));
    L.push(line("· with the trend", v.withTrend));
    L.push(line("· counter-trend", v.counter));
    for (const [tf, x] of Object.entries(v.byTf)) {
      L.push(line(`· ${tf}`, x));
      const t = v.byTfTrend && v.byTfTrend[tf]; if (t) { L.push(line(`   ${tf} with the trend`, t.with)); L.push(line(`   ${tf} counter-trend`, t.counter)); }
      const a = v.aplusByTf && v.aplusByTf[tf]; if (a && a.closed) L.push(line(`   ${tf} all 5 checks`, a));
    }
    L.push("");
  }
  L.push("Win = closed in profit. Above +0R total means the rules made money over the period.");
  const msg = L.join("\n");
  console.log(msg.replace(/<[^>]+>/g, ""));
  fs.writeFileSync(path.join(__dirname, "backtest-result.json"), JSON.stringify(r, null, 1));
  await send(msg);
})().catch(e => { console.error(e); process.exit(1); });
