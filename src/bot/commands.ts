import { formatCredits } from "@lib/credits";
import type { BotChat, User } from "@lib/db";
import { bullet } from "./format";
import { pendingActions, unlinkChat, updateChat } from "./store";
import type { TelegramApi } from "./telegram-api";
import { ToolError, agentLines, applySettings, balanceLine } from "./tools";

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
/brief 8 – daily brief at 08:00 (/brief off to stop)
/timezone Asia/Kolkata – your timezone
/budget 5 100 – credits per message and per day
/model auto | economy | quality | <model id>
/memory – what I remember about you (/forget clears it)
/new – start a fresh conversation
/key – replace your API key
/stop – unlink this chat`;

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
          await say(chat.briefHour === null ? "The daily brief is off. Send /brief 8 for one at 08:00." : `Your daily brief comes at ${String(chat.briefHour).padStart(2, "0")}:00 ${chat.timezone}. /brief off stops it.`);
          return true;
        }
        if (/^(off|none|stop)$/i.test(arg)) {
          await applySettings(chat, { briefHour: null });
          await say("Daily brief off.");
          return true;
        }
        const hour = Number(/^(\d{1,2})(?::\d{2})?$/.exec(arg)?.[1]);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
          await say("Give an hour from 0 to 23, for example /brief 8.");
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
          await say(`${formatCredits(chat.maxPerMessageMicro)} credits per message, ${formatCredits(chat.maxPerDayMicro)} per day. Change with /budget 5 100.`);
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
          await say(`Model: ${chat.modelMode === "pinned" ? chat.modelId : chat.modelMode}. Use /model auto, economy, quality, or a model id.`);
          return true;
        }
        const mode = arg.toLowerCase();
        const changes =
          mode === "auto" || mode === "economy" || mode === "quality" ? await applySettings(chat, { modelMode: mode }) : await applySettings(chat, { modelId: arg });
        await say(`Set: ${changes.join(", ")}.`);
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
