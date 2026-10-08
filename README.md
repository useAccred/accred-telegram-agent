# Accred Telegram agent

The Accred agent in Telegram: **@AccredAgentbot**. Paste your Accred API key once and talk to it. It answers with any model in the catalog, runs jobs for you, controls and creates trading agents inside a mandate, and keeps working while you are away with a daily brief and alerts. Every action that sends, creates, pauses or trades waits for a button tap.

It is the same account as [agent.accred.sh](https://agent.accred.sh): the two share one database. The engine code (the agent loop, trading, wallets, the schema) comes from the [accred-automation](https://github.com/useAccred/accred-automation) repository as a git submodule, so there is one implementation of everything that touches money.

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
