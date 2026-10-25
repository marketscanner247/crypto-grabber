# Crypto Grabber

A crypto RSI-divergence scanner (the website) plus Telegram alerts that run on GitHub every 15 minutes, free.

## What's in this folder

| File | What it does |
|---|---|
| `index.html` | The Crypto Grabber app (the website) |
| `manifest.webmanifest`, `sw.js`, `icon-192.png`, `icon-512.png` | Let you add the site to your phone's home screen |
| `bot/alert.js`, `bot/package.json` | The alert bot: runs the app's own scan and messages you on Telegram |
| `.github/workflows/alerts.yml` | Tells GitHub to run the bot every 15 minutes |
| `run-alerts.bat` | Backup: runs the bot from your Windows PC instead of GitHub |

## Alerts you will get

- 🟡 **Setup ready**: a setup that meets all 9 checks has appeared and is waiting for its entry (with entry, stop, targets, and how long it stays valid)
- 🟢/🔴 **Enter now**: the recommended entry just triggered
- 🎯 **Target 1 hit**: take half, move the stop to entry
- ⚪ **Closed**: Target 2 hit, stopped, missed, or expired

Each alert is sent once. Alerts arrive within about 15 minutes of the event (GitHub's scheduler can run a few minutes late at busy times).

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
4. From then on it runs by itself every 15 minutes.

### 5. Turn on the website (optional, same repository)
1. **Settings → Pages**. Source: **Deploy from a branch**. Branch: **main**, folder **/(root)**. **Save**.
2. After a minute, open `https://YOUR-USERNAME.github.io/crypto-grabber/` on your phone → Share → **Add to Home Screen**.
3. Alert messages include a link to this page.

## Settings (optional)

In **Settings → Secrets and variables → Actions → Variables tab → New repository variable**:

| Name | Value | Effect |
|---|---|---|
| `ALERT_MIN` | `all` (default) | Only setups that meet all 9 checks |
| | `take` | Any setup scoring 70+ |
| | `any` | Every signal (noisy; good for checking it works) |
| `ALERT_TFS` | `1h,4h,1d` (default) | Timeframes to scan, e.g. `15m,1h,4h` |

## Updating the app

Upload the new `index.html` to the repository (**Add file → Upload files**, commit). Both the website and the alerts use it from the next run.

## Pausing or stopping alerts

**Actions → Telegram alerts → ⋯ (top right) → Disable workflow.** Enable it the same way.

GitHub pauses scheduled workflows in repositories with no activity for 60 days and emails you first. Uploading any file (or clicking Enable) restarts it.

## Cost

Free. GitHub Actions minutes are unlimited for public repositories, Telegram bots are free, and all market data comes from free public APIs.

## Troubleshooting

- **No test message**: open the run in the Actions tab and read the "Scan and alert" step. "chat not found" means you didn't press Start on your bot, or the chat id is wrong. "Unauthorized" means the token is wrong.
- **Message says "Couldn't reach Binance or OKX"**: the exchanges are blocking GitHub's servers. Use the Windows backup below.
- **Few alerts**: requiring all 9 checks is strict on purpose. Set `ALERT_MIN` to `take` for more.

## Windows backup (runs from your PC)

Only needed if GitHub can't reach the exchanges. Your PC must be on for alerts.

1. Install **Node.js LTS** from nodejs.org.
2. Double-click `run-alerts.bat`. The first time, it asks for your token and chat id (saved in your user folder, not in this folder), installs what it needs, and sends the test message.
3. To run it every 15 minutes: open **Command Prompt** in this folder and run:
   ```
   schtasks /create /sc minute /mo 15 /tn "Crypto Grabber alerts" /tr "\"%CD%\run-alerts.bat\""
   ```
   Remove it later with `schtasks /delete /tn "Crypto Grabber alerts" /f`.
