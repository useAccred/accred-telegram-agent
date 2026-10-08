import { eq } from "drizzle-orm";
import { checkApiKey } from "@lib/accred";
import { rateLimited } from "../rate-limit";
import { encrypt, sha256 } from "@lib/crypto";
import { db, users } from "@lib/db";
import { consumeStartCode, saveSharedChat, type TelegramUpdate } from "@lib/telegram";
import { handleCallback } from "./actions";
import { chatTurn, defaultBotDeps, type BotDeps } from "./agent";
import { ASK_FOR_KEY, handleCommand, welcome } from "./commands";
import { looksLikeKey, looksLikePrivateKey, parseCommand } from "./format";
import { ensureChat, getChat, linkChat, loadLinkedChat, updateChat } from "./store";
import { balanceLine } from "./tools";

/**
 * Routes Telegram updates to the agent: onboarding for an unknown chat,
 * commands, button taps, and messages. One update at a time per chat, chats
 * in parallel, so one user's slow turn never delays another's.
 */

const queues = new Map<string, Promise<void>>();

function enqueue(chatId: string, work: () => Promise<void>): Promise<void> {
  const previous = queues.get(chatId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(work)
    .catch((error) => console.error(`[bot ${chatId}]`, error instanceof Error ? error.message : error))
    .finally(() => {
      if (queues.get(chatId) === next) queues.delete(chatId);
    });
  queues.set(chatId, next);
  return next;
}

export function handleBotUpdate(update: TelegramUpdate, deps: BotDeps = defaultBotDeps): Promise<void> {
  if (update.callback_query?.message) {
    const chatId = String(update.callback_query.message.chat.id);
    return enqueue(chatId, () => handleCallback(update.callback_query!, deps.api));
  }
  const message = update.message;
  if (!message) return Promise.resolve();
  const chatId = String(message.chat.id);
  return enqueue(chatId, () => handleMessage(update, deps));
}

async function handleMessage(update: TelegramUpdate, deps: BotDeps): Promise<void> {
  const message = update.message!;
  const chatId = String(message.chat.id);
  const { api } = deps;
  const text = (message.text ?? "").trim();
  const command = parseCommand(text);

  // Linking through the web's Connect button: "/start <code>". Works in any chat type, as before.
  if (command?.command === "start" && command.arg) {
    const result = await consumeStartCode(command.arg, message.chat);
    if (!result) {
      await api.sendMessage(chatId, "That link has expired or was already used. Press Connect again to get a new one.");
      return;
    }
    if (message.chat.type !== "private") {
      await api.sendMessage(chatId, result.outcome === "exists" ? "This chat is already connected to Accred Automation." : "Connected. Your automations can now send messages to this chat.");
      return;
    }
    await linkChat(chatId, result.userId);
    const [user] = await db.select().from(users).where(eq(users.id, result.userId));
    await api.sendMessage(chatId, `Connected. Your automations can now send messages to this chat.\n\n${user ? welcome(user, await balanceLine(user)) : ""}`);
    return;
  }

  if (message.chat.type !== "private") return;
  if (!text) {
    await api.sendMessage(chatId, "I can only read text for now. Voice notes and images are coming once the API supports them.");
    return;
  }
  if (rateLimited(`bot:${chatId}`, 20, 60_000)) {
    await api.sendMessage(chatId, "Slow down a little: at most 20 messages a minute.");
    return;
  }

  if (looksLikePrivateKey(text)) {
    // Never leave a signing secret in a chat, and never use it.
    if (message.message_id !== undefined) await api.deleteMessage(chatId, message.message_id);
    await api.sendMessage(chatId, "That looked like a private key or seed phrase, so I deleted the message. I never accept or use those. If it was a real key, treat it as exposed and move the funds.");
    return;
  }
  const chat = await ensureChat(chatId);
  if (chat.state !== "linked") {
    await onboard(chatId, text, message.message_id, deps);
    return;
  }
  if (looksLikeKey(text) && !command) {
    // A key pasted into a linked chat: treat it as a replacement, and never leave it in the chat.
    await onboard(chatId, text, message.message_id, deps);
    return;
  }
  if (command) {
    const linked = await loadLinkedChat(chatId);
    if (!linked) return;
    const handled = await handleCommand(linked.chat, linked.user, command.command, command.arg, api);
    if (handled) return;
    // An unknown command is still a message to the agent.
  }
  await chatTurn(chatId, text, deps);
}

/** Accepts an API key pasted into the chat, deleting the message that carried it. */
async function onboard(chatId: string, text: string, messageId: number | undefined, deps: BotDeps): Promise<void> {
  const { api } = deps;
  if (!looksLikeKey(text)) {
    await api.sendMessage(chatId, ASK_FOR_KEY);
    return;
  }
  if (messageId !== undefined) await api.deleteMessage(chatId, messageId);
  if (rateLimited(`signin:tg:${chatId}`, 8, 60_000)) {
    await api.sendMessage(chatId, "Too many attempts. Wait a minute and try again.");
    return;
  }
  const key = text.trim();
  const check = await checkApiKey(key);
  if (check === "unavailable") {
    await api.sendMessage(chatId, "Accred could not be reached to check the key. Try again in a moment.");
    return;
  }
  if (check === "invalid") {
    await api.sendMessage(chatId, "Accred did not accept that key. Check it has not been revoked, then paste it again.");
    return;
  }
  const keyHash = sha256(key);
  let [user] = await db.select().from(users).where(eq(users.keyHash, keyHash));
  if (!user) {
    [user] = await db
      .insert(users)
      .values({ keyHash, keyEnc: encrypt(key), keyHint: key.slice(-4) })
      .onConflictDoUpdate({ target: users.keyHash, set: { keyHash } })
      .returning();
  }
  const previous = await getChat(chatId);
  if (previous?.userId === user!.id) await updateChat(chatId, { state: "linked" });
  else await linkChat(chatId, user!.id);
  // The chat becomes a Telegram connection, so automations and trading agents can message it.
  await saveSharedChat(user!.id, { id: Number(chatId), type: "private" }).catch(() => {});
  await api.sendMessage(chatId, welcome(user!, await balanceLine(user!)));
}
