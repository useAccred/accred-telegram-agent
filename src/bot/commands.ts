import { formatCredits } from "@lib/credits";
import type { BotChat, User } from "@lib/db";
import { listTradingAgents } from "@lib/trading/queries";
import { agentButtons, alertButtons, briefButtons, budgetButtons, modelButtons } from "./actions";
import { runsCsv, tradesCsv } from "./export";
import { bullet } from "./format";
import { pendingActions, spendByDay, unlinkChat, updateChat } from "./store";
import type { TelegramApi } from "./telegram-api";
import { ToolError, agentLines, applySettings, balanceLine } from "./tools";
import { WatchError, agentNames, createWatch, describeWatch, listWatches, parseWatch, removeWatch } from "./watches";

/** Slash commands. Everything that is not a command is a message to the agent. */

const WEB = "https://agent.accred.sh";

export const HELP = `What I can do:
• Answer anything, with any model in the Accred catalog.
• Run jobs: "every morning at 8 send me the top AI news", "check this page and tell me when the price drops below 50".
• Trading: "how are my agents doing", "pause Momentum A", "close everything", "set up a balanced agent with $200 on the three most liquid tokens".
• Keep notes about you between conversations.

Anything I send, create, pause or trade waits for a button tap from you first. I never withdraw funds or touch keys; those stay on ${WEB}.

Commands:
/status – balance, agents, automations, settings
/agents – your trading agents, with buttons
/alert ETH below 2000 – price alert; /alert position closed, run failed, agent paused; /alert lists them
/brief – daily brief hour and sections, with buttons
/history – credits spent per day
/export trades | runs – a CSV file
/timezone Asia/Kolkata – your timezone
/budget – credits per message and per day, with buttons
/model – choose the model, with buttons
/memory – what I remember about you (/forget clears it)
/new – start a fresh conversation
/key – replace your API key
/stop – unlink this chat

In a group: add me, then the member whose account it should use sends /start there. I answer when mentioned or replied to, and only that member can confirm.`;

export function welcome(user: Pick<User, "keyHint">, balance: string): string {
  return `Connected to your Accred account (key ending …${user.keyHint}). ${balance}

Ask me anything, or tell me what you want done. For example:
• "What happened in crypto today?"
• "Every morning at 8, send me the three most important AI headlines."
• "Set up a balanced trading agent with $100."

/help lists the commands. I will also message you on my own: a daily brief if you want one (/brief 8), low-balance warnings, and approval requests for anything your automations want to send.`;
}

export const ASK_FOR_KEY = `Hi. I am your Accred agent. Paste your Accred API key to begin.

Create one at https://accred.sh → API (a separate key just for this chat is best, so you can revoke it any time). The message with the key is deleted as soon as I read it, and the key is stored encrypted.`;

function settingsLines(chat: BotChat): string[] {
  return [
    `Timezone ${chat.timezone}`,
    chat.briefHour === null ? "Daily brief off" : `Daily brief at ${String(chat.briefHour).padStart(2, "0")}:00`,
    `Budget ${formatCredits(chat.maxPerMessageMicro)} credits per message, ${formatCredits(chat.maxPerDayMicro)} per day`,
    `Model ${chat.modelMode === "pinned" ? chat.modelId : chat.modelMode}`,
    `Low-balance alert below ${formatCredits(chat.lowBalanceMicro)} credits`,
  ];
}

/** Runs a command for a linked chat. Returns false when the text is not a command it knows. */
export async function handleCommand(chat: BotChat, user: User, command: string, arg: string, api: TelegramApi): Promise<boolean> {
  const chatId = chat.chatId;
  const say = (text: string) => api.sendMessage(chatId, text);
  try {
    switch (command) {
      case "start":
        await say(welcome(user, await balanceLine(user)));
        return true;
      case "help":
        await say(HELP);
        return true;
      case "status": {
        const [balance, agents, pending] = await Promise.all([balanceLine(user), agentLines(user.id).catch(() => []), pendingActions(chatId)]);
        await say(
          [
            balance,
            agents.length ? `Trading agents:\n${bullet(agents)}` : "Trading agents: none.",
            pending.length ? `Waiting for your tap:\n${bullet(pending.map((action) => action.title))}` : "",
            `Settings:\n${bullet(settingsLines(chat))}`,
            `Web: ${WEB}/app`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
        return true;
      }
      case "brief": {
        if (!arg) {
          await api.sendMessage(
            chatId,
            `${chat.briefHour === null ? "The daily brief is off." : `Your daily brief comes at ${String(chat.briefHour).padStart(2, "0")}:00 ${chat.timezone}.`} Sections: ${chat.briefSections.join(", ") || "none"}. Pick an hour, and tick the sections you want.`,
            { buttons: briefButtons(chat) },
          );
          return true;
        }
        if (/^(off|none|stop)$/i.test(arg)) {
          await applySettings(chat, { briefHour: null });
          await say("Daily brief off.");
          return true;
        }
        const sections = /^sections?\s+(.+)$/i.exec(arg);
        if (sections) {
          const wanted = sections[1]!.toLowerCase().split(/[\s,]+/).filter(Boolean);
          const valid = ["balance", "spend", "agents", "automations", "cred"] as const;
          const unknown = wanted.filter((entry) => !(valid as readonly string[]).includes(entry));
          if (unknown.length) {
            await say(`Unknown section${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Choose from ${valid.join(", ")}.`);
            return true;
          }
          const changes = await applySettings(chat, { briefSections: wanted as Array<(typeof valid)[number]> });
          await say(`Set: ${changes.join(", ")}.`);
          return true;
        }
        const hour = Number(/^(\d{1,2})(?::\d{2})?$/.exec(arg)?.[1]);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
          await say("Give an hour from 0 to 23, for example /brief 8, or /brief sections balance,agents.");
          return true;
        }
        await applySettings(chat, { briefHour: hour });
        await say(`Daily brief at ${String(hour).padStart(2, "0")}:00 ${chat.timezone}. Change the timezone with /timezone.`);
        return true;
      }
      case "timezone": {
        if (!arg) {
          await say(`Your timezone is ${chat.timezone}. Change it with /timezone Europe/Berlin.`);
          return true;
        }
        await applySettings(chat, { timezone: arg });
        await say(`Timezone set to ${arg}.`);
        return true;
      }
      case "budget": {
        const [perMessage, perDay] = arg.split(/[\s,]+/).filter(Boolean).map(Number);
        if (!arg) {
          await api.sendMessage(chatId, `${formatCredits(chat.maxPerMessageMicro)} credits per message, ${formatCredits(chat.maxPerDayMicro)} per day. Pick a preset (per message / per day) or send /budget 5 100.`, { buttons: budgetButtons() });
          return true;
        }
        if (!(perMessage! > 0)) {
          await say("Give the credits per message and, optionally, per day: /budget 5 100.");
          return true;
        }
        const changes = await applySettings(chat, { creditsPerMessage: perMessage, ...(perDay! > 0 ? { creditsPerDay: perDay } : {}) });
        await say(`Set: ${changes.join(", ")}.`);
        return true;
      }
      case "model": {
        if (!arg) {
          await api.sendMessage(chatId, `Model: ${chat.modelMode === "pinned" ? chat.modelId : chat.modelMode}. Pick one, or send /model <model id>.`, { buttons: await modelButtons(chat) });
          return true;
        }
        const mode = arg.toLowerCase();
        const changes =
          mode === "auto" || mode === "economy" || mode === "quality" ? await applySettings(chat, { modelMode: mode }) : await applySettings(chat, { modelId: arg });
        await say(`Set: ${changes.join(", ")}.`);
        return true;
      }
      case "agents": {
        const agents = await listTradingAgents(user.id).catch(() => []);
        if (agents.length === 0) {
          await say(`No trading agents yet. Say "set up a balanced agent with $100" or create one at ${WEB}/app/trading.`);
          return true;
        }
        const lines = await agentLines(user.id);
        await api.sendMessage(chatId, bullet(lines), { buttons: agentButtons(agents.map(({ automation }) => ({ id: automation.id, name: automation.name, status: automation.status }))) });
        return true;
      }
      case "alert":
      case "alerts": {
        const watches = await listWatches(chatId);
        const names = await agentNames(user.id);
        const list = () =>
          watches.length
            ? bullet(watches.map((watch, index) => `${index + 1}. ${describeWatch(watch, watch.agentId ? names.get(watch.agentId) : undefined)}`))
            : "No alerts yet.";
        if (!arg) {
          await api.sendMessage(chatId, `${list()}\n\nAdd one: /alert ETH below 2000, /alert CRED above 0.05, /alert position closed, /alert run failed, /alert agent paused Momentum.`, {
            buttons: alertButtons(watches.map((watch) => ({ id: watch.id, label: describeWatch(watch) }))),
          });
          return true;
        }
        const off = /^(off|remove|delete)\s+(\d+|all)$/i.exec(arg);
        if (off) {
          if (off[2]!.toLowerCase() === "all") {
            for (const watch of watches) await removeWatch(chatId, watch.id);
            await say(`Removed ${watches.length} alert${watches.length === 1 ? "" : "s"}.`);
            return true;
          }
          const watch = watches[Number(off[2]) - 1];
          if (!watch) {
            await say(`There is no alert ${off[2]}. ${list()}`);
            return true;
          }
          await removeWatch(chatId, watch.id);
          await say(`Removed: ${describeWatch(watch)}.`);
          return true;
        }
        const parsed = parseWatch(arg);
        if (!parsed) {
          await say('I did not understand that alert. Examples: /alert ETH below 2000, /alert position closed, /alert run failed, /alert agent paused Momentum.');
          return true;
        }
        try {
          const watch = await createWatch(chat, user, parsed);
          await say(`Alert set: ${describeWatch(watch)}. I check it every minute; it costs no credits.`);
        } catch (error) {
          await say(error instanceof WatchError ? error.message : "The alert could not be set.");
        }
        return true;
      }
      case "history": {
        const days = await spendByDay(user.id, chat.timezone, 14);
        if (days.length === 0) {
          await say("Nothing spent in the last 14 days.");
          return true;
        }
        const total = days.reduce((sum, day) => sum + day.total, 0n);
        await say(
          [
            `Credits spent in the last 14 days: ${formatCredits(total)}.`,
            bullet(days.map((day) => `${day.date}: ${formatCredits(day.total)} (chat ${formatCredits(day.chat)}, automations ${formatCredits(day.automations)}, trading ${formatCredits(day.trading)})`)),
            "/export trades or /export runs for a CSV.",
          ].join("\n"),
        );
        return true;
      }
      case "export": {
        const what = arg.trim().toLowerCase();
        if (what !== "trades" && what !== "runs") {
          await say("What should I export? /export trades or /export runs (last 90 days, as a CSV file).");
          return true;
        }
        const { csv, rows } = what === "trades" ? await tradesCsv(user.id) : await runsCsv(user.id);
        if (rows === 0) {
          await say(`No ${what} in the last 90 days.`);
          return true;
        }
        const sent = await api.sendDocument(chatId, { name: `accred-${what}-${new Date().toISOString().slice(0, 10)}.csv`, content: csv, mimeType: "text/csv" }, `${rows} ${what}, last 90 days.`);
        if (sent === null) await say("The file could not be sent. Try again in a moment.");
        return true;
      }
      case "memory":
        await say(chat.memory.trim() ? `What I remember about you:\n${chat.memory}` : "I have not saved anything about you yet. Tell me your preferences and I will.");
        return true;
      case "forget":
        await updateChat(chatId, { memory: "" });
        await say("Forgotten.");
        return true;
      case "new":
        await updateChat(chatId, { transcript: [] });
        await say("Fresh start. What can I do for you?");
        return true;
      case "key":
        await updateChat(chatId, { state: "awaiting_key" });
        await say("Paste the new Accred API key. The message is deleted as soon as I read it.");
        return true;
      case "stop":
        await unlinkChat(chatId);
        await say("This chat is unlinked. Your account, automations and agents are untouched at agent.accred.sh. Send /start to link again.");
        return true;
      default:
        return false;
    }
  } catch (error) {
    await say(error instanceof ToolError ? error.message : "That did not work. Try again.");
    return true;
  }
}
