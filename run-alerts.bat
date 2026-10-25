@echo off
rem Crypto Grabber: run one alert check from this PC (backup for the GitHub schedule).
rem Your Telegram token and chat id are kept in your user folder, never in this folder.
setlocal
set "CFG=%USERPROFILE%\crypto-grabber-telegram.txt"
set "FIRST="
if exist "%CFG%" goto have
set /p "T=Paste your Telegram bot token: "
set /p "C=Paste your Telegram chat id: "
> "%CFG%" echo %T%
>> "%CFG%" echo %C%
set "FIRST=1"
:have
set /p TELEGRAM_TOKEN=<"%CFG%"
for /f "usebackq skip=1 delims=" %%a in ("%CFG%") do if not defined TELEGRAM_CHAT_ID set "TELEGRAM_CHAT_ID=%%a"
cd /d "%~dp0bot"
if exist node_modules\playwright goto run
echo Installing, first run only. This takes a minute...
call npm install --no-audit --no-fund
call npx playwright install chromium
:run
if not defined ALERT_MIN set "ALERT_MIN=all"
if not defined ALERT_TFS set "ALERT_TFS=1h,4h,1d"
set "TZ_NAME=America/Toronto"
if defined FIRST set "TEST=true"
node alert.js
if defined FIRST pause
endlocal
