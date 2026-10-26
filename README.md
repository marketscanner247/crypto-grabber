# Crypto Grabber

A crypto RSI-divergence scanner (the website) plus Telegram alerts. The alerts run every 5 minutes on a small server of your own (about €6 a month, on time) or on GitHub (free, but GitHub often runs them 20–60 minutes late).

## What's in this folder

| File | What it does |
|---|---|
| `index.html` | The Crypto Grabber app (the website) |
| `manifest.webmanifest`, `sw.js`, `icon-192.png`, `icon-512.png` | Let you add the site to your phone's home screen |
| `bot/alert.js`, `bot/package.json` | The alert bot: runs the app's own scan and messages you on Telegram |
| `.github/workflows/alerts.yml` | Tells GitHub to run the bot every 5 minutes |
| `server/setup.sh`, `server/run.sh`, `server/cg` | Sets up your own alert server (recommended, see below) |
| `run-alerts.bat` | Backup: runs the bot from your Windows PC instead of GitHub |

## Alerts you will get

- 🟡 **Setup ready**: a setup is waiting for its entry and price is now close to it (within about 1 ATR)
- 🟢/🔴 **Enter now**: the entry filled. Entries come in two halves: the first at the middle of the fair value gap the move left behind (or the top of the order block), the second at the middle of the order block. The message says which half filled and where the other limit sits.
- 🎯 **Target 1 hit**: take half, move the stop to the average entry
- ⚪ **Closed**: Target 2 hit, back to entry, or stopped. Only for trades that actually filled.

Setups that never fill (missed or expired), pay under 1:1, or need a spike-wide stop are not alerted and not shown in the app.

Setups that meet all 5 checks come with 🟢/🔴/🟡. Setups scoring 50+ that miss some checks come marked ⚠️ **High risk**, with what's missing; if you take one, use half size and take profit at Target 1.

Setups that would long into 4h / 1d / 1w resistance or the 4h / 1d EMA 200 (or short into support) closer than 1R are skipped too. An entry sitting on the 4h / 1d EMA 50 or 200 counts as a good location.

📊 **Daily briefs** at the New York open (9:30 am ET, once a day), three short messages:
- **BTC** and **ETH**: trend by timeframe, Asia / London / previous day / week / month highs and lows and which were swept, top-down support and resistance (with the 4h / 1d EMAs), liquidity, and the day's bias with an invalidation level. ETH also gets its ETH/BTC read.
- **Alts**: whether alts are worth trading today, who is leading (BTC or alts), BTC dominance, ALT/BTC and ETH/BTC, alt season, breadth, and the strongest / weakest alts this week.

To get them now: **Actions → Telegram alerts → Run workflow**, tick **Send the daily BTC, ETH and alts briefs now**.

📈 **Weekly scorecard** on Sunday evening (first run after 6 pm New York time): every trade alerted in the last 7 days, replayed on real prices as a $1,000 position. How many were entered, won, hit the stop loss, and the profit after an estimated 0.1% fee each side, split by all-5-checks vs high risk and by timeframe, plus the last 4 weeks. Trades are managed the way the app plans them (entry in two halves, half off at Target 1 with the stop moved to the average entry, the rest to Target 2). To get one now: **Run workflow**, tick **Send the weekly scorecard now**. It only counts alerts sent after this version is uploaded.

Each alert is sent once. GitHub's scheduler is best-effort, so at busy times a run can start late or be skipped (the brief can land anywhere from 9:30 to about 10:30).

## One-time setup (about 15 minutes)

### 1. Create your Telegram bot
1. In Telegram, search for **@BotFather** and press **Start**.
2. Send `/newbot`. Give it a name (e.g. `Crypto Grabber Alerts`) and a username ending in `bot` (e.g. `maddy_grabber_bot`).
3. BotFather replies with a **token** like `123456789:AAH...`. Copy it. Keep it private.
4. Open your new bot (BotFather links it) and press **Start**. The bot can't message you until you do this.
5. Search for **@userinfobot**, press **Start**. It replies with your **Id** (a number). That is your **chat id**.

### 2. Put the files on GitHub
1. Sign in at github.com, click **+** (top right) → **New repository**.
2. Name: `crypto-grabber`. Choose **Public** (free alerts and free website need a public repository). Click **Create repository**.
3. On the new page click **uploading an existing file**.
4. Open this folder in File Explorer, select **everything inside it** (including the `.github` and `bot` folders) and drag it onto the GitHub page. Click **Commit changes**.
5. Check the file list shows a `.github` folder. If it doesn't, click **Add file → Create new file**, type `.github/workflows/alerts.yml` as the name, paste the contents of that file from this folder, and commit.

### 3. Add your Telegram details as secrets
1. In the repository: **Settings → Secrets and variables → Actions → New repository secret**.
2. Name `TELEGRAM_TOKEN`, value: the BotFather token. **Add secret**.
3. Again: name `TELEGRAM_CHAT_ID`, value: your id from @userinfobot. **Add secret**.

Secrets are encrypted and never visible in the repository, even though it is public.

### 4. Test it
1. Click the **Actions** tab. If asked, click **I understand my workflows, go ahead and enable them**.
2. Click **Telegram alerts** on the left → **Run workflow** → **Run workflow**.
3. Within 2–3 minutes you should get "✅ Crypto Grabber alerts connected" on Telegram, with the current BTC / alts / market read.
4. From then on it runs by itself every 5 minutes.

### 5. Turn on the website (optional, same repository)
1. **Settings → Pages**. Source: **Deploy from a branch**. Branch: **main**, folder **/(root)**. **Save**.
2. After a minute, open `https://YOUR-USERNAME.github.io/crypto-grabber/` on your phone → Share → **Add to Home Screen**.
3. Alert messages include a link to this page.

## Settings (optional)

In **Settings → Secrets and variables → Actions → Variables tab → New repository variable**:

| Name | Value | Effect |
|---|---|---|
| `ALERT_MIN` | `risk` (default) | All-checks setups, plus ⚠️ high-risk ones scoring 50+ |
| | `all` | Only setups that meet all 5 checks |
| | `take` | All-checks setups, plus any scoring 70+ |
| | `any` | Every signal (noisy; good for checking it works) |
| `ALERT_TFS` | `1h,4h,1d,3d,1w` (default) | Timeframes to scan, e.g. `15m,1h,4h` |

## Your own alert server (recommended, about €6 a month)

GitHub's free scheduler treats "every 5 minutes" as a suggestion. A small server runs the check exactly every 5 minutes, all day.

1. **Make an SSH key on your PC** (once). Open **PowerShell** and run `ssh-keygen`, pressing Enter at every question. Then run `type $env:USERPROFILE\.ssh\id_ed25519.pub` and copy the line it prints.
2. **Create the server** at Hetzner Cloud (hetzner.com/cloud → sign up or log in): new project → **Add server**.
   - Location: **Nuremberg, Falkenstein or Helsinki** (Europe; Binance's futures data, used for the liquidation estimates, isn't available from US servers).
   - Image: **Ubuntu 24.04**. Type: **Shared vCPU, x86, CX23** (2 vCPU, 4 GB). Keep **Public IPv4** on.
   - SSH keys: **Add SSH key**, paste the line from step 1.
   - Create. Copy the server's IP address.
3. **Upload this folder to GitHub first** (it must include the `server` folder).
4. **Connect and install.** In PowerShell: `ssh root@YOUR-IP` (type `yes` the first time). Then paste:
   ```
   curl -fsSL https://raw.githubusercontent.com/marketscanner247/crypto-grabber/main/server/setup.sh | bash
   ```
   It takes about 5 minutes. When it asks, paste your Telegram bot token (it stays hidden) and your chat id. You'll get "✅ Crypto Grabber alerts connected" on Telegram.
5. **Turn off the GitHub schedule** so you don't get every alert twice: **Actions → Telegram alerts → ⋯ → Disable workflow.**

The server pulls your latest files from GitHub before every check, so updating the app is still just uploading to GitHub. Your Telegram token is kept only on the server (`/etc/crypto-grabber.env`).

Commands on the server (after `ssh root@YOUR-IP`):

| Command | What it does |
|---|---|
| `cg` | On/off, next check, last results |
| `cg brief` | Send the BTC, ETH and alts briefs now |
| `cg scorecard` | Send the weekly scorecard now |
| `cg test` | Send the test message |
| `cg log` | Watch checks live (Ctrl+C to stop) |
| `cg stop` / `cg start` | Pause / resume alerts |

## Updating the app

Upload the new `index.html` to the repository (**Add file → Upload files**, commit). Both the website and the alerts use it from the next run.

## Pausing or stopping alerts

On your server: `cg stop` (and `cg start` to resume). On GitHub: **Actions → Telegram alerts → ⋯ (top right) → Disable workflow.** Enable it the same way.

GitHub pauses scheduled workflows in repositories with no activity for 60 days and emails you first. Uploading any file (or clicking Enable) restarts it.

## Cost

Your own server: about €6 a month (Hetzner CX23 plus its IPv4 address; check the price shown when you create it). Everything else is free: GitHub Actions minutes are unlimited for public repositories, Telegram bots are free, and all market data comes from free public APIs.

## Troubleshooting

- **No test message**: open the run in the Actions tab and read the "Scan and alert" step. "chat not found" means you didn't press Start on your bot, or the chat id is wrong. "Unauthorized" means the token is wrong.
- **Message says "Couldn't reach Binance or OKX"**: the exchanges are blocking GitHub's servers. Use the Windows backup below.
- **Too many alerts**: set `ALERT_MIN` to `take` (70+) or `all` (only setups that meet every check).

## Windows backup (runs from your PC)

Only needed if GitHub can't reach the exchanges. Your PC must be on for alerts.

1. Install **Node.js LTS** from nodejs.org.
2. Double-click `run-alerts.bat`. The first time, it asks for your token and chat id (saved in your user folder, not in this folder), installs what it needs, and sends the test message.
3. To run it every 5 minutes: open **Command Prompt** in this folder and run:
   ```
   schtasks /create /sc minute /mo 5 /tn "Crypto Grabber alerts" /tr "\"%CD%\run-alerts.bat\""
   ```
   Remove it later with `schtasks /delete /tn "Crypto Grabber alerts" /f`.
