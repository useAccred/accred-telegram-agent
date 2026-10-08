# Accred Telegram agent

The Accred agent in Telegram: **@AccredAgentbot**. Paste your Accred API key once and talk to it. It answers with any model in the catalog, runs jobs for you, controls and creates trading agents inside a mandate, and keeps working while you are away with a daily brief and alerts. Every action that sends, creates, pauses or trades waits for a button tap.

It is the same account as [agent.accred.sh](https://agent.accred.sh): the two share one database. The engine code (the agent loop, trading, wallets, the schema) comes from the [accred-automation](https://github.com/useAccred/accred-automation) repository as a git submodule, so there is one implementation of everything that touches money.

## What it does

- Chat with any model in the Accred catalog; keeps notes about you between conversations.
- Jobs on a schedule (automations), trading agents (status, pause, resume, close, tighter limits, one position, exit levels), $CRED market and confirmed swaps.
- Gmail, read-only, when it is connected on the web.
- Alerts checked every minute at no credit cost: `/alert ETH below 2000`, `/alert position closed`, `/alert run failed`, `/alert agent paused`.
- Daily brief (pick the hour and the sections) and a weekly report, with detail buttons; low-balance and deposit notices.
- `/history` (credits per day) and `/export trades | runs` (CSV file).
- Groups: a member links the group with `/start`; the bot answers when mentioned or replied to, and only that member can confirm.
- Menus with buttons for the model, budget, brief and agents; the command list is registered from code in six languages.
- Everything that sends, creates, pauses or trades waits for a Confirm tap; closing every position also needs the word CLOSE typed.

## Run it

```bash
git clone --recurse-submodules https://github.com/useAccred/accred-telegram-agent
cd accred-telegram-agent
cp .env.example .env     # same DATABASE_URL and APP_SECRET as the web app, plus the bot token
pnpm install
pnpm start
```

The web app must run with `TELEGRAM_POLLING=off` and the same `TELEGRAM_BOT_TOKEN`, so that exactly one process polls the bot while both can send.

Tests: `pnpm test` runs the pure tests; with `TRADING_TEST_DATABASE_URL` set to a database that has the web app's migrations applied, the database-backed tests run too.

## Deploy

`render.yaml` describes an always-on Node web service (the health endpoint is `/api/health`). Set the secrets in the dashboard. Updating the engine: `git submodule update --remote vendor/accred-automation`, commit, deploy.

## Documents

- [docs/PLAN.md](docs/PLAN.md): what it does, the tools, confirmations, background work, security, what it never does.
