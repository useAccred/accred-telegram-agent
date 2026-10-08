import { env } from "@lib/env";
import { splitMessage } from "./format";

/**
 * The handful of Telegram Bot API methods the agent uses. Everything is plain
 * text: no parse mode, so nothing a model writes can break the formatting or
 * be read as markup. Failures are returned, not thrown: a lost message must
 * never stop the work that produced it.
 */

const API = "https://api.telegram.org";

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramApi {
  /** Sends text, split into 4,000-character messages. Buttons go on the last one. Returns its id. */
  sendMessage(chatId: string | number, text: string, options?: { buttons?: InlineButton[][] }): Promise<number | null>;
  /** Replaces the buttons under a message; `null` removes them. */
  editButtons(chatId: string | number, messageId: number, buttons: InlineButton[][] | null): Promise<void>;
  deleteMessage(chatId: string | number, messageId: number): Promise<boolean>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  typing(chatId: string | number): Promise<void>;
}

const RETRIES = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Why a fetch failed, with the cause Node hides inside "fetch failed". */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  return cause ? `${error.message} (${cause.code ?? ""} ${cause.message ?? ""})`.trim() : error.message;
}

/**
 * Calls one Bot API method. A network failure is retried a few times with a
 * short pause: the instance's connection to Telegram drops now and then, and a
 * reply must not be lost to one dropped connection.
 */
async function call<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const response = await fetch(`${API}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const payload = (await response.json()) as { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
      if (payload.ok) return payload.result as T;
      // Telegram's own refusals are final, except a rate limit, which says how long to wait.
      if (response.status === 429 && payload.parameters?.retry_after && attempt < RETRIES) {
        await sleep(Math.min(payload.parameters.retry_after, 10) * 1000);
        continue;
      }
      throw Object.assign(new Error(payload.description ?? `Telegram ${method} failed`), { status: response.status, final: true });
    } catch (error) {
      if ((error as { final?: boolean }).final) throw error;
      last = error;
      console.error(`[bot] ${method} attempt ${attempt} failed: ${describe(error)}`);
      if (attempt < RETRIES) await sleep(1_000 * attempt);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export function telegramApi(token = env.telegramBotToken ?? ""): TelegramApi {
  const keyboard = (buttons?: InlineButton[][] | null) => (buttons && buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {});
  return {
    async sendMessage(chatId, text, options = {}) {
      const parts = splitMessage(text);
      let last: number | null = null;
      for (const [index, part] of parts.entries()) {
        try {
          const result = await call<{ message_id: number }>(token, "sendMessage", {
            chat_id: chatId,
            text: part,
            disable_web_page_preview: true,
            ...(index === parts.length - 1 ? keyboard(options.buttons) : {}),
          });
          last = result.message_id;
        } catch (error) {
          console.error("[bot] sendMessage gave up:", describe(error));
          return null;
        }
      }
      return last;
    },
    async editButtons(chatId, messageId, buttons) {
      await call(token, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons ?? [] },
      }).catch(() => {});
    },
    async deleteMessage(chatId, messageId) {
      return call<boolean>(token, "deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => false);
    },
    async answerCallback(callbackId, text) {
      await call(token, "answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) }).catch(() => {});
    },
    async typing(chatId) {
      await call(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    },
  };
}
