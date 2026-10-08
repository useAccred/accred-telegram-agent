import { resolveApproval } from "@lib/agent/runner";
import { listModels } from "@lib/accred";
import { suggestedModels } from "@lib/agent/router";
import type { BotChat, BriefSection } from "@lib/db";
import { briefText, weeklyText } from "./heartbeat";
import { armAction, claimAction, createAction, loadLinkedChat, pendingActions, saveTranscript, setActionMessage } from "./store";
import type { InlineButton, TelegramApi } from "./telegram-api";
import { ToolError, agentLines, applySettings, toolByName, type BotContext, type BotToolDef, type Prepared } from "./tools";
import { describeWatch, listWatches, removeWatch } from "./watches";

/**
 * Buttons. A write tool the model asked for becomes a pending action with
 * Confirm and Cancel; a run on the web that stopped at "Needs approval" gets
 * Approve and Decline; settings, agent and alert menus carry their choice in
 * the button. The button carries ids and choices only. Tapping it is the only
 * thing that runs a tool or a run. In a group, only the member who linked the
 * chat may tap anything that spends or changes.
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
  from?: { id: number; username?: string };
  message?: { message_id: number; chat: { id: number | string } };
}

// ── Menus ───────────────────────────────────────────────────────────────────

export const BRIEF_SECTIONS: Array<{ key: BriefSection; label: string }> = [
  { key: "balance", label: "Balance" },
  { key: "spend", label: "Yesterday's spend" },
  { key: "agents", label: "Trading agents" },
  { key: "automations", label: "Automations" },
  { key: "cred", label: "CRED market" },
];

export async function modelButtons(chat: BotChat): Promise<InlineButton[][]> {
  const mark = (label: string, value: string) => (chat.modelMode === value || chat.modelId === value ? `✓ ${label}` : label);
  const rows: InlineButton[][] = [
    [
      { text: mark("Auto", "auto"), callback_data: "s:model:auto" },
      { text: mark("Economy", "economy"), callback_data: "s:model:economy" },
      { text: mark("Quality", "quality"), callback_data: "s:model:quality" },
    ],
  ];
  try {
    const tiers = suggestedModels(await listModels());
    const seen = new Set<string>();
    const picks: InlineButton[] = [];
    for (const model of [tiers.smart, tiers.top, tiers.fast]) {
      if (seen.has(model.id) || `s:model:${model.id}`.length > 64) continue;
      seen.add(model.id);
      picks.push({ text: mark(model.name.slice(0, 28), model.id), callback_data: `s:model:${model.id}` });
    }
    if (picks.length) rows.push(picks);
  } catch {
    // The catalog is optional for the menu.
  }
  return rows;
}

export function budgetButtons(): InlineButton[][] {
  const preset = (perMessage: number, perDay: number) => ({ text: `${perMessage} / ${perDay}`, callback_data: `s:budget:${perMessage}:${perDay}` });
  return [[preset(3, 50), preset(6, 100)], [preset(10, 300), preset(25, 1000)]];
}

export function briefButtons(chat: BotChat): InlineButton[][] {
  const hour = (value: number) => ({ text: chat.briefHour === value ? `✓ ${String(value).padStart(2, "0")}:00` : `${String(value).padStart(2, "0")}:00`, callback_data: `s:brief:${value}` });
  const sections = BRIEF_SECTIONS.map((section) => ({ text: `${chat.briefSections.includes(section.key) ? "☑" : "☐"} ${section.label}`, callback_data: `s:bsec:${section.key}` }));
  return [[hour(7), hour(8), hour(9), hour(20), { text: chat.briefHour === null ? "✓ Off" : "Off", callback_data: "s:brief:off" }], sections.slice(0, 3), sections.slice(3)];
}

export function agentButtons(agents: Array<{ id: string; name: string; status: string }>): InlineButton[][] {
  return agents.map((agent) => [
    { text: `${agent.name.slice(0, 20)}: details`, callback_data: `g:d:${agent.id}` },
    agent.status === "running" ? { text: "Pause", callback_data: `g:p:${agent.id}` } : { text: "Resume", callback_data: `g:r:${agent.id}` },
    { text: "Close all", callback_data: `g:c:${agent.id}` },
  ]);
}

export function alertButtons(watches: Array<{ id: string; label: string }>): InlineButton[][] {
  return watches.slice(0, 10).map((watch) => [{ text: `Remove: ${watch.label.slice(0, 40)}`, callback_data: `w:off:${watch.id}` }]);
}

export const briefDetailButtons: InlineButton[][] = [[{ text: "Agent details", callback_data: "b:agents" }, { text: "This week", callback_data: "b:week" }]];

// ── Dispatch ────────────────────────────────────────────────────────────────

export async function handleCallback(query: CallbackQuery, api: TelegramApi): Promise<void> {
  const chatId = query.message ? String(query.message.chat.id) : undefined;
  const data = query.data ?? "";
  if (!chatId) {
    await api.answerCallback(query.id);
    return;
  }
  if (data.startsWith("a:")) return handleAction(query, chatId, api);

  const linked = await loadLinkedChat(chatId);
  if (!linked) {
    await api.answerCallback(query.id, "This chat is not linked.");
    return;
  }
  const { chat, user } = linked;
  if (chat.chatKind === "group" && query.from && String(query.from.id) !== chat.ownerTelegramId) {
    await api.answerCallback(query.id, "Only the member who linked this group can change settings or confirm.");
    return;
  }
  const say = (text: string, buttons?: InlineButton[][]) => api.sendMessage(chatId, text, buttons ? { buttons } : undefined);
  try {
    const [kind, ...rest] = data.split(":");
    if (kind === "s") {
      const [what, ...valueParts] = rest;
      const value = valueParts.join(":");
      let changes: string[] = [];
      if (what === "model") changes = await applySettings(chat, value === "auto" || value === "economy" || value === "quality" ? { modelMode: value } : { modelId: value });
      else if (what === "budget") {
        const [perMessage, perDay] = value.split(":").map(Number);
        changes = await applySettings(chat, { creditsPerMessage: perMessage!, creditsPerDay: perDay! });
      } else if (what === "brief") changes = await applySettings(chat, { briefHour: value === "off" ? null : Number(value) });
      else if (what === "bsec") {
        const key = value as BriefSection;
        const next = chat.briefSections.includes(key) ? chat.briefSections.filter((section) => section !== key) : [...chat.briefSections, key];
        changes = await applySettings(chat, { briefSections: next });
        const updated = { ...chat, briefSections: next };
        if (query.message) await api.editButtons(chatId, query.message.message_id, briefButtons(updated));
        await api.answerCallback(query.id, `Brief: ${next.length ? next.join(", ") : "nothing selected"}`);
        return;
      }
      await api.answerCallback(query.id, changes.join(", ").slice(0, 190) || "Done");
      if (query.message) await api.editButtons(chatId, query.message.message_id, null);
      await say(`Set: ${changes.join(", ")}.`);
      return;
    }
    if (kind === "g") {
      const [verb, id] = rest;
      const context: BotContext = { user, chat };
      if (verb === "d") {
        await api.answerCallback(query.id);
        void api.typing(chatId);
        await say(await toolByName.get("trading.agent")!.run({ agent: id }, context));
        return;
      }
      const toolName = verb === "p" ? "trading.pause" : verb === "r" ? "trading.resume" : verb === "c" ? "trading.close_all" : null;
      if (!toolName) throw new ToolError("Unknown button.");
      const tool = toolByName.get(toolName)!;
      const prepared = await tool.prepare!({ agent: id }, context);
      await api.answerCallback(query.id);
      await requestConfirmation(context, tool, prepared, api);
      return;
    }
    if (kind === "b") {
      await api.answerCallback(query.id);
      void api.typing(chatId);
      if (rest[0] === "agents") {
        const lines = await agentLines(user.id).catch(() => []);
        await say(lines.length ? lines.join("\n\n") : "No trading agents.");
      } else if (rest[0] === "week") await say(await weeklyText(chat, user));
      else await say(await briefText(chat, user));
      return;
    }
    if (kind === "w") {
      const id = rest[1] ?? "";
      const watches = await listWatches(chatId);
      const watch = watches.find((candidate) => candidate.id === id);
      const removed = watch ? await removeWatch(chatId, id) : false;
      await api.answerCallback(query.id, removed ? "Alert removed" : "Already gone");
      const remaining = watches.filter((candidate) => candidate.id !== id);
      if (query.message) await api.editButtons(chatId, query.message.message_id, alertButtons(remaining.map((candidate) => ({ id: candidate.id, label: describeWatch(candidate) }))));
      if (watch) await say(`Removed: ${describeWatch(watch)}.`);
      return;
    }
    await api.answerCallback(query.id);
  } catch (error) {
    await api.answerCallback(query.id);
    await say(error instanceof ToolError ? error.message : "That did not work. Try again.");
  }
}

async function handleAction(query: CallbackQuery, chatId: string, api: TelegramApi): Promise<void> {
  const match = /^a:([0-9a-f-]{36}):([yn])$/.exec(query.data ?? "");
  if (!match) {
    await api.answerCallback(query.id);
    return;
  }
  const [, id, choice] = match;
  const linkedFirst = await loadLinkedChat(chatId);
  if (linkedFirst?.chat.chatKind === "group" && query.from && String(query.from.id) !== linkedFirst.chat.ownerTelegramId) {
    await api.answerCallback(query.id, "Only the member who linked this group can confirm.");
    return;
  }
  // A close-all needs a typed word after the tap, so one stray tap cannot sell everything.
  if (choice === "y") {
    const action = (await pendingActions(chatId)).find((candidate) => candidate.id === id);
    if (action && action.tool === "trading.close_all" && action.args.armWord && !action.args.armed) {
      await armAction(action.id);
      await api.answerCallback(query.id, "One more step");
      if (query.message) await api.editButtons(chatId, query.message.message_id, null);
      await api.sendMessage(chatId, `To sell every position of this agent, type CLOSE within two minutes. Anything else cancels it.`);
      return;
    }
  }
  await decideAction(id!, chatId, choice === "y" ? "confirmed" : "cancelled", api, query);
}

/** Runs or cancels a pending action. `query` is the tap that caused it; absent when the typed word did. */
export async function decideAction(id: string, chatId: string, outcome: "confirmed" | "cancelled", api: TelegramApi, query?: CallbackQuery): Promise<void> {
  const action = await claimAction(id, chatId, outcome);
  if (query) await api.answerCallback(query.id, action === "expired" ? "That request expired." : action ? (outcome === "confirmed" ? "Confirmed" : "Cancelled") : "Already handled.");
  if (!action || action === "expired") {
    if (query?.message) await api.editButtons(chatId, query.message.message_id, null);
    if (action === "expired") await api.sendMessage(chatId, "That request expired. Ask me again if you still want it.");
    return;
  }
  if (query?.message) await api.editButtons(chatId, query.message.message_id, null);
  else if (action.messageId) await api.editButtons(chatId, action.messageId, null);

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

