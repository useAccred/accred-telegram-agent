import { resolveApproval } from "@lib/agent/runner";
import { claimAction, createAction, loadLinkedChat, saveTranscript, setActionMessage } from "./store";
import type { InlineButton, TelegramApi } from "./telegram-api";
import { ToolError, toolByName, type BotContext, type BotToolDef, type Prepared } from "./tools";

/**
 * Confirmations. A write tool the model asked for becomes a pending action
 * with Confirm and Cancel buttons; a run on the web that stopped at "Needs
 * approval" becomes one with Approve and Decline. The button carries only the
 * action's id. Tapping it is the only thing that runs the tool or the run.
 */

export function actionButtons(id: string, confirmLabel = "Confirm", cancelLabel = "Cancel"): InlineButton[][] {
  return [[{ text: confirmLabel, callback_data: `a:${id}:y` }, { text: cancelLabel, callback_data: `a:${id}:n` }]];
}

export async function requestConfirmation(context: BotContext, tool: BotToolDef, prepared: Prepared, api: TelegramApi): Promise<void> {
  const action = await createAction({ chatId: context.chat.chatId, userId: context.user.id, kind: "tool", tool: tool.name, args: prepared.args, title: prepared.title });
  const messageId = await api.sendMessage(context.chat.chatId, prepared.description, { buttons: actionButtons(action.id, prepared.confirmLabel) });
  await setActionMessage(action.id, messageId);
}

/** Tells the chat about a run waiting for approval on the web, with buttons that answer it. */
export async function requestRunApproval(chatId: string, userId: string, run: { id: string; automationName: string; actionTitle: string; detail?: string | null }, api: TelegramApi): Promise<void> {
  const action = await createAction({ chatId, userId, kind: "run_approval", runId: run.id, title: `${run.automationName}: ${run.actionTitle}` });
  const text = [`"${run.automationName}" wants to: ${run.actionTitle}`, run.detail ? `\n${run.detail}` : "", `\nApprove to let it happen, or decline and it will wrap up without doing this.`].join("");
  const messageId = await api.sendMessage(chatId, text, { buttons: actionButtons(action.id, "Approve", "Decline") });
  await setActionMessage(action.id, messageId);
}

export interface CallbackQuery {
  id: string;
  data?: string;
  message?: { message_id: number; chat: { id: number | string } };
}

export async function handleCallback(query: CallbackQuery, api: TelegramApi): Promise<void> {
  const match = /^a:([0-9a-f-]{36}):([yn])$/.exec(query.data ?? "");
  const chatId = query.message ? String(query.message.chat.id) : undefined;
  if (!match || !chatId) {
    await api.answerCallback(query.id);
    return;
  }
  const [, id, choice] = match;
  const outcome = choice === "y" ? "confirmed" : "cancelled";
  const action = await claimAction(id!, chatId, outcome);
  await api.answerCallback(query.id, action === "expired" ? "That request expired." : action ? (outcome === "confirmed" ? "Confirmed" : "Cancelled") : "Already handled.");
  if (!action || action === "expired") {
    if (query.message) await api.editButtons(chatId, query.message.message_id, null);
    if (action === "expired") await api.sendMessage(chatId, "That request expired. Ask me again if you still want it.");
    return;
  }
  if (query.message) await api.editButtons(chatId, query.message.message_id, null);

  const linked = await loadLinkedChat(chatId);
  if (!linked || linked.user.id !== action.userId) {
    await api.sendMessage(chatId, "This chat is no longer linked to that account.");
    return;
  }
  const { chat, user } = linked;
  const transcript = [...chat.transcript];

  if (outcome === "cancelled") {
    const declined = action.kind === "run_approval" ? await declineRun(action, user.id) : false;
    await api.sendMessage(chatId, declined ? `Declined. "${action.title}" will wrap up without doing this.` : `Cancelled: ${action.title}.`);
    transcript.push({ role: "user", content: `(I ${declined ? "declined" : "cancelled"}: ${action.title}.)` });
    await saveTranscript(chatId, transcript);
    return;
  }

  if (action.kind === "run_approval" && action.runId) {
    const proceed = await resolveApproval(action.runId, user.id, true);
    if (!proceed) {
      await api.sendMessage(chatId, "That run is no longer waiting for approval.");
      return;
    }
    void proceed();
    await api.sendMessage(chatId, `Approved. "${action.title}" continues.`);
    transcript.push({ role: "user", content: `(I approved: ${action.title}.)` });
    await saveTranscript(chatId, transcript);
    return;
  }

  const tool = action.tool ? toolByName.get(action.tool) : undefined;
  if (!tool) {
    await api.sendMessage(chatId, "That action is not available any more.");
    return;
  }
  void api.typing(chatId);
  let result: string;
  try {
    result = await tool.run(action.args, { user, chat });
  } catch (error) {
    result = `That did not work: ${error instanceof ToolError || error instanceof Error ? error.message : "unknown error"}`;
  }
  await api.sendMessage(chatId, result);
  transcript.push({ role: "user", content: `(I confirmed: ${action.title}.)` }, { role: "assistant", content: result.slice(0, 1500) });
  await saveTranscript(chatId, transcript);
}

/** A declined run approval: the run is told and wraps up. */
export async function declineRun(action: { runId: string | null; title: string }, userId: string): Promise<boolean> {
  if (!action.runId) return false;
  const proceed = await resolveApproval(action.runId, userId, false);
  if (!proceed) return false;
  void proceed();
  return true;
}
