# Plan: Telegram agent

**Status:** Built. See "Where the build stands".
**Last updated:** 2026-10-08
**Repo:** `accred-telegram-agent`, its own service. The engine code (agent loop, trading, wallets, database schema) comes from `accred-automation` as a git submodule, and both share one database.

A personal agent that lives in Telegram. The user pastes an Accred API key once, then talks to the agent in plain words. It answers questions with any model, runs jobs for the user, controls and creates trading agents inside a mandate, and keeps working in the background when the user is not there: a morning brief, alerts, and approval requests with buttons.

**One sentence:** one chat, one API key, and an agent that answers, acts, trades inside limits and reports back on its own.

---

## Contents

1. [Objective](#1-objective)
2. [Where the build stands](#2-where-the-build-stands)
3. [What the user sees](#3-what-the-user-sees)
4. [Onboarding](#4-onboarding)
5. [A conversation turn](#5-a-conversation-turn)
6. [Tools](#6-tools)
7. [Confirmations](#7-confirmations)
8. [Trading from the chat](#8-trading-from-the-chat)
9. [Background work](#9-background-work)
10. [Budget](#10-budget)
11. [Memory and context](#11-memory-and-context)
12. [Commands](#12-commands)
13. [Data model](#13-data-model)
14. [Architecture](#14-architecture)
15. [Security](#15-security)
16. [What it never does](#16-what-it-never-does)
17. [Configuration](#17-configuration)
18. [Testing](#18-testing)
19. [Roadmap](#19-roadmap)

---

## 1. Objective

Make the whole platform usable from one Telegram chat, with no web page needed after the first message:

- **Answer anything.** Any question, any model in the Accred catalog, paid from the user's credits with a receipt per reply.
- **Act.** Create and run automations, read the web, keep notes between conversations.
- **Trade inside limits.** Create a dedicated wallet, set up a trading agent from a risk profile, watch it, pause it, close everything, in the same chat. The deterministic risk engine, mandate and monitor of the trading product apply unchanged.
- **Work alone.** When the user is away: a daily brief, low-balance and trade notices, and approval requests the user answers with a button.

The agent is the same account as the web app. Everything it creates is visible at agent.accred.sh, and everything created on the web is visible to the agent.

---

## 2. Where the build stands

| Area | State |
| --- | --- |
| Onboarding with an API key in the chat, key message deleted | Built |
| Conversation loop with the JSON tool protocol, per-message and daily budgets | Built |
| Read tools: balance, models, web, trading overview and detail, automations, assets | Built |
| Write tools behind a Confirm button: pause, resume, close all, revoke, run now, create wallet, create trading agent, create and run automations | Built |
| Daily brief, low-balance alert, approval requests with buttons | Built |
| Settings by command and by asking the agent | Built |
| Per-chat memory and transcript | Built |
| Tests for the pure parts | Built |
| Group chats | Not built. Private chats only |
| Voice notes | Not built. The API is text only |
| Withdrawals from the chat | Deliberately not built. See section 16 |

---

## 3. What the user sees

```text
User:   /start
Bot:    Hi. I am your Accred agent. Paste your Accred API key to begin.
        (Create one at accred.sh → API. The message with the key is deleted as soon as I read it.)
User:   ct_live_…
Bot:    Connected. Balance: 1,240.50 credits ($12.41).
        Ask me anything, or say what you want done. Try:
        • "What is happening in AI today?"
        • "Every morning at 8, send me the three most important crypto headlines."
        • "Set up a balanced trading agent with $200."
        /help lists the commands.
User:   How are my trading agents doing?
Bot:    Momentum A (Live · Running): equity $212.40, today +$3.10, total +$12.40, 1 open position (TOKEN, stop $0.41).
        …
User:   Pause it.
Bot:    Pause "Momentum A"? No new positions will be opened. Open positions keep their stop loss and take profit.
        [Confirm] [Cancel]
User:   (taps Confirm)
Bot:    Paused. Protective monitoring continues.
```

The next morning, unprompted:

```text
Bot:    Good morning. Balance 1,201.20 credits. Yesterday you spent 39.30 credits across 6 automation runs and 2 cycles.
        Momentum A: paused by you. 1 open position, unrealized +$1.80.
        Morning headlines: ran at 08:00, sent.
        Reply to ask me anything.
```

---

## 4. Onboarding

1. The user opens the shared Accred bot and presses Start, or sends any message.
2. If the chat is not linked, the bot asks for an Accred API key.
3. The next message that looks like a key is checked with Accred without spending credit, exactly as the web sign-in does. The bot **deletes the message containing the key** from the chat.
4. The account is found or created by the key's SHA-256, as on the web. The chat is linked to that account, and a Telegram connection for the chat is saved so automations and trading agents can message it.
5. The bot confirms with the balance and a few examples.

A chat linked through the web ("Connect" on the Connections page) is also linked to the agent at that moment, so existing users get the agent without pasting their key again.

Replacing the key: `/key`. Unlinking the chat: `/stop`. The web account and its data stay.

---

## 5. A conversation turn

```text
Message arrives
  → chat known and linked? otherwise onboarding
  → rate limit: 20 messages per minute per chat
  → "typing…" shown
  → build the context: persona, tools, memory, account summary, last turns
  → loop (at most 6 tool calls, 8 model calls):
      price the worst case; stop if over the per-message budget or the daily cap
      call the brain model, parse one JSON object
      "final" → send the text (split at 4,000 characters), record the turn and its credits
      "tool"  → read tool: run it, condense long output with the reading model, feed it back
                write tool: save the action, send "Confirm?" with buttons, stop the loop
  → transcript trimmed and saved
```

The protocol, parser, router, worst-case pricing and compaction are the ones the automation runner uses. The bot's loop differs in three ways: the "job" is a conversation with history, a write tool ends the turn with a confirmation request instead of pausing a run, and credits are charged against the chat's own budgets.

---

## 6. Tools

| Tool | Effect | What it does |
| --- | --- | --- |
| `web.fetch` | read | Fetches a public page, JSON API or feed |
| `memory.save` | internal | Replaces the note the agent keeps for this chat |
| `account.balance` | read | Credits available, and this month's spend by product |
| `models.list` | read | Featured models with prices, and what Auto, Economy and Best quality mean right now |
| `trading.overview` | read | Wallets with ETH and USDG, every agent with status, equity, PnL and open positions |
| `trading.agent` | read | One agent in detail: positions with stops and targets, last decisions, last trades, pause reason |
| `trading.assets` | read | The most traded tokens on Robinhood Chain with liquidity, for picking an allowlist |
| `trading.pause` | **write** | Pause an agent |
| `trading.resume` | **write** | Resume a paused agent |
| `trading.close_all` | **write** | Pause and sell every open position |
| `trading.revoke_access` | **write** | Remove the agent's authority to propose or open trades |
| `trading.run_now` | **write** | Start a cycle now |
| `trading.create_wallet` | **write** | Create a dedicated wallet and return its deposit address |
| `trading.create_agent` | **write** | Create and start a trading agent from a profile, an allocation and an asset list |
| `cred.market` | read | The live market of $CRED: price, market cap and fully diluted value, burned supply read from the chain, liquidity, volume, changes |
| `cred.buy` | **write** | Buy CRED with USDG from the user's trading wallet: quoted and simulated through the same route and pinned router as trading agents, sent only after the tap |
| `cred.sell` | **write** | Sell CRED back to USDG from the trading wallet, quoted and simulated the same way |
| `trading.history` | read | The audit log in plain sentences: what agents and wallets did, for one agent or all, over the last days |
| `automations.list` | read | The user's automations, their schedule and last run |
| `automations.create` | **write** | Create an automation: instruction, schedule, connections |
| `automations.run` | **write** | Run an automation now |
| `automations.set_enabled` | **write** | Pause or resume an automation |
| `bot.settings` | internal | Change the brief hour, timezone, budgets or model mode |

Every **write** tool is a confirmation request. The model cannot run one.

---

## 7. Confirmations

A write tool produces a pending action: the tool, its validated arguments, a one-line title and a plain-language description of what will happen. The bot sends the description with two buttons, **Confirm** and **Cancel**. The action expires after 10 minutes. The button carries only a random action id; the arguments live in the database.

Tapping Confirm runs the tool directly, with no model in between, and sends the tool's own report. Tapping Cancel records the refusal. In both cases the model sees the outcome on the next turn, so it never repeats a declined action.

Creating a trading agent uses a stronger wording. The description lists the allocation, the profile and its key limits, the assets, the strategies, the interval, the model and the credit budget, and ends with "This agent trades real funds from its wallet. Losses are real and trades cannot be undone." The button reads **Approve and start trading**. This is the same approval step the web form requires, and it is recorded in the audit log with `source: "telegram"`.

Automation approvals work the same way from the other direction: when a run on the web stops at "Needs approval", the bot sends the pending action with **Approve** and **Decline** buttons, and the run continues from the chat.

---

## 8. Trading from the chat

The trading product is unchanged. The bot is a second front end for it:

- **Reading** uses the same queries as the dashboard.
- **Controls** call the same code as the dashboard buttons, after a confirmation.
- **Creating an agent** goes through `createAgentFromProfile` in `src/lib/trading/create.ts`, which applies the same rules as the web form: live trading must be on for the server, the wallet must be the user's and not revoked, the allocation at least $10, at least one allowed asset, at least one strategy or an instruction, all seven permissions, a per-cycle budget of 0.1 to 100 credits. The mandate is the chosen profile's preset, unchanged. The chat's Telegram connection is linked for notices.
- Assets are named by symbol or address. Symbols are resolved against the most traded tokens on the chain; addresses are looked up. An asset that would not pass the profile's market filters is named in the confirmation, with the option to lower the minimums as the web form offers.

What the chat cannot do: withdraw funds, import a private key, edit a mandate field by field, or raise an agent's allocation. Those stay on the web, where the full form and the risk-increase confirmation live. The bot says so and gives the link.

---

## 9. Background work

The scheduler already ticks every 30 seconds. The bot adds a heartbeat on the same tick, throttled to once a minute, that for each linked chat:

1. **Sends approval requests.** Any run waiting for approval that the chat has not been told about.
2. **Sends the daily brief** at the chat's brief hour in its timezone, once per day: balance, yesterday's spend by product, every trading agent's state and result, automation runs of the day, and anything auto-paused.
3. **Warns on low balance** once per 24 hours when the balance is below the chat's threshold (default 200 credits).
4. **Announces deposits.** Every two minutes it reads each trading wallet's USDG, ETH and CRED; an increase is reported once, with the wallet's new balances.
5. **Sends a weekly report** on Monday at the brief hour: per agent, closed trades, net result after fees, win rate, best and worst trade, equity; and credits spent by product.

Trade executions, rejections, exits, breakers and failures reach the chat through the existing notification path, because the chat is a Telegram connection and the bot links it to every agent it creates.

Nothing in the heartbeat calls a model. It costs no credits.

The process also watches itself: the polling loop records when Telegram last answered, the health endpoint reports it (503 when stale), and after five quiet minutes the process exits so the host restarts it.

---

## 10. Budget

| Setting | Default | Range |
| --- | --- | --- |
| Per message | 3 credits | 0.1 to 100 |
| Per day | 50 credits | 1 to 5,000 |
| Model mode | Auto | Auto, Economy, Best quality, a pinned model |

Before every model call the worst case is priced as in the runner. A call that would pass either limit is not made, and the bot says which limit stopped it and how to change it. Credits actually charged are recorded per turn, so the daily total is exact.

Model credits spent by automations and trading agents the bot created are governed by those objects' own budgets, exactly as if they had been created on the web.

---

## 11. Memory and context

- **Transcript.** The last turns of the conversation, kept under 16 KB and 30 messages. `/new` clears it.
- **Memory.** One note of up to 2,000 characters the agent writes with `memory.save`: preferences, standing instructions, facts about the user. `/memory` shows it, `/forget` clears it.
- **Account summary.** Rebuilt every turn from the database: balance, trading agents in one line each, number of automations, time and timezone. The model never has to call a tool to know the basics.

---

## 12. Commands

| Command | Does |
| --- | --- |
| `/start` | Begin, or show what the agent can do |
| `/help` | The commands and examples |
| `/status` | Balance, agents, automations, settings, in one message |
| `/brief 8` · `/brief off` | Daily brief at 08:00 in your timezone, or none |
| `/timezone Asia/Kolkata` | Your timezone |
| `/budget 5 100` | Per-message and daily credit limits |
| `/model auto` · `economy` · `quality` · `<model id>` | Which model answers |
| `/memory` · `/forget` | Show or clear the agent's note about you |
| `/new` | Start a fresh conversation |
| `/key` | Replace the API key |
| `/stop` | Unlink this chat |

Anything else is a message to the agent.

---

## 13. Data model

| Table | Purpose | Key fields |
| --- | --- | --- |
| `bot_chats` | One per linked Telegram chat | `chat_id` (PK), `user_id`, `state` (onboarding or linked), settings (timezone, brief hour, budgets, model), `memory`, `transcript`, `last_brief_on`, `low_balance_alerted_at`, `notified_run_ids` |
| `bot_turns` | One per reply the agent gave | `chat_id`, `credits_micro`, `model`, tokens, `tool_calls`, `created_at` |
| `bot_actions` | Pending confirmations | `id`, `chat_id`, `kind` (tool or run approval), `tool`, `args`, `title`, `status`, `expires_at`, `message_id` |

Everything cascades from `users`. Unlinking a chat deletes its `bot_chats` row and its turns and actions.

---

## 14. Architecture

```text
Telegram ──long polling──▶ src/lib/telegram.ts
                               │  /start <code>   → connection linking (unchanged) + chat link
                               │  everything else → src/lib/bot/router.ts
                               ▼
                       per-chat queue (one turn at a time per chat, chats in parallel)
                               │
          ┌────────────────────┼─────────────────────┐
          ▼                    ▼                     ▼
   commands.ts            agent.ts               actions.ts
   /status /brief …   conversation loop       Confirm / Cancel / Approve
                        tools.ts
                 read tools run inline
                 write tools → bot_actions + buttons
                               │
                               ▼
      trading/*.ts  agent/runner.ts  queries.ts  (the same code the web app uses)

scheduler.ts tick ──▶ bot/heartbeat.ts: approvals, daily brief, low balance
```

Files:

| File | Does |
| --- | --- |
| `src/server.ts` | The process: health endpoint, polling, heartbeat timer |
| `src/bot/router.ts` | Routes updates: onboarding, commands, messages, button taps |
| `src/bot/agent.ts` | The conversation loop, budgets, transcript |
| `src/bot/tools.ts` | The bot's tools |
| `src/bot/actions.ts` | Pending confirmations and what happens on Confirm |
| `src/bot/commands.ts` | Slash commands |
| `src/bot/heartbeat.ts` | Background work |
| `src/bot/store.ts` | Database access for chats, turns and actions |
| `src/bot/telegram-api.ts` | The few Telegram methods the bot uses |
| `src/bot/format.ts` | Text formatting and message splitting |
| `vendor/accred-automation/src/lib/` | The shared engine: agent loop, trading, wallets, schema (submodule) |
| `vendor/…/trading/create.ts`, `controls.ts` | Creating a trading agent from a profile and the emergency controls, shared with the web |

---

## 15. Security

- **The key message is deleted** from the chat right after it is read. The key is stored encrypted, as on the web; only its last four characters are ever shown again.
- **Private chats only.** The agent does not answer in groups, so a group member can never act on another member's account.
- **Every action that moves money, spends credits on a job, or changes an agent needs a button tap.** The model only proposes. Buttons carry a random id, not the arguments, and expire.
- **No withdrawals, no key import, no mandate edits from the chat.** A compromised phone can pause and close, which only ever reduces exposure, but cannot move funds out or loosen a limit.
- **Outside content is data.** Web pages, tool results and memory are wrapped and marked as data in the prompt, as in the runner.
- **Rate limits** per chat. Budgets per message and per day.
- **Audit.** Trading actions from the chat are written to the audit log with `source: "telegram"`.

---

## 16. What it never does

1. Withdraw or transfer funds. Withdrawals need the web, signed in with the key.
2. Show, send or accept a private key or seed phrase.
3. Raise an allocation, loosen a mandate or grant a permission. Edits need the web form and its risk-increase confirmation.
4. Trade without a confirmed mandate. Creating an agent is one approval; every trade after that is the risk engine's decision, never the chat model's.
5. Answer in a group chat.
6. Spend past the per-message or daily budget.

---

## 17. Configuration

The bot runs as its own always-on service with `TELEGRAM_BOT_TOKEN`, the same `DATABASE_URL` and `APP_SECRET` as the web app (and `TRADING_WALLET_SECRET` and `LIVE_TRADING` when the web app has them). The web app uses the same token to send notices and runs with `TELEGRAM_POLLING=off`, so exactly one process polls the bot.

Set the bot's command list once in @BotFather (`/setcommands`) with the commands in section 12, so Telegram shows the menu.

---

## 18. Testing

Unit tests cover: key detection, command parsing, message splitting, budget decisions, confirmation descriptions, asset resolution and the brief text. The conversation loop and the heartbeat are driven against fakes for Telegram and the model.

Not covered: the real Telegram API, and the real Accred API. Before relying on it, do one real round: `/start`, paste a key, ask a question, create an automation, confirm it, and check that the run appears on the web.

---

## 19. Roadmap

| Phase | Scope |
| --- | --- |
| 1 | Everything in section 2 marked Built |
| 2 | Edit a mandate from the chat with the same risk-increase confirmation as the web; "while you were away" summary on the first message after a long gap |
| 3 | Voice notes once the API meters transcription; images once it accepts them |
| 4 | Group chats with a shared credit pool, members approved by the owner |
