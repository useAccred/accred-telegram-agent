import { and, desc, eq, gte, notInArray, sql } from "drizzle-orm";
import { getBalance } from "../balance";
import { formatCredits } from "@lib/credits";
import { automations, db, runSteps, runs, tradingAutomations, type BotChat, type User } from "@lib/db";
import { dayStart } from "@lib/trading/portfolio";
import { requestRunApproval } from "./actions";
import { bullet, credits, localDate, localHour } from "./format";
import { creditsBetween, expireActions, listLinkedChats, updateChat } from "./store";
import { telegramApi, type TelegramApi } from "./telegram-api";
import { agentLines } from "./tools";

/**
 * What the agent does on its own. Runs on the scheduler's tick, throttled to
 * once a minute. Nothing here calls a model, so it costs no credits.
 */

const EVERY_MS = 60_000;
const BALANCE_CHECK_MS = 30 * 60_000;
const ALERT_AGAIN_MS = 24 * 3_600_000;
let lastRun = 0;
const balanceChecked = new Map<string, number>();

export async function botHeartbeat(api: TelegramApi = telegramApi(), now = Date.now()): Promise<void> {
  if (now - lastRun < EVERY_MS) return;
  lastRun = now;
  for (const action of await expireActions()) {
    if (action.messageId) await api.editButtons(action.chatId, action.messageId, null);
  }
  for (const { chat, user } of await listLinkedChats()) {
    try {
      await sendApprovals(chat, user, api);
      await sendBrief(chat, user, api, now);
      await checkBalance(chat, user, api, now);
    } catch (error) {
      console.error(`[bot heartbeat ${chat.chatId}]`, error instanceof Error ? error.message : error);
    }
  }
}

/** Runs waiting for approval on the web that this chat has not been told about. */
async function sendApprovals(chat: BotChat, user: User, api: TelegramApi): Promise<void> {
  const waiting = await db
    .select({ id: runs.id, automationId: runs.automationId })
    .from(runs)
    .where(and(eq(runs.userId, user.id), eq(runs.status, "waiting_approval"), chat.notifiedRunIds.length ? notInArray(runs.id, chat.notifiedRunIds) : sql`true`))
    .limit(5);
  if (waiting.length === 0) return;
  const notified = [...chat.notifiedRunIds];
  for (const run of waiting) {
    const [[automation], [step]] = await Promise.all([
      db.select({ name: automations.name }).from(automations).where(eq(automations.id, run.automationId)),
      db
        .select({ title: runSteps.title, detail: runSteps.detail })
        .from(runSteps)
        .where(and(eq(runSteps.runId, run.id), eq(runSteps.kind, "approval"), eq(runSteps.status, "waiting")))
        .orderBy(desc(runSteps.idx))
        .limit(1),
    ]);
    notified.push(run.id);
    if (!automation || !step) continue;
    await requestRunApproval(chat.chatId, user.id, { id: run.id, automationName: automation.name, actionTitle: step.title, detail: step.detail }, api);
  }
  await updateChat(chat.chatId, { notifiedRunIds: notified.slice(-50) });
}

export async function briefText(chat: BotChat, user: User, now = Date.now()): Promise<string> {
  const todayStart = dayStart(now, chat.timezone);
  const yesterdayStart = dayStart(todayStart - 1, chat.timezone);
  const [balance, spent, agents, runRows, paused] = await Promise.all([
    getBalance(user).catch(() => null),
    creditsBetween(user.id, new Date(yesterdayStart), new Date(todayStart)),
    agentLines(user.id).catch(() => [] as string[]),
    db
      .select({ name: automations.name, status: runs.status, createdAt: runs.createdAt })
      .from(runs)
      .innerJoin(automations, eq(automations.id, runs.automationId))
      .where(and(eq(runs.userId, user.id), gte(runs.createdAt, new Date(yesterdayStart))))
      .orderBy(desc(runs.createdAt))
      .limit(30),
    db
      .select({ name: tradingAutomations.name, reason: tradingAutomations.pauseReason })
      .from(tradingAutomations)
      .where(and(eq(tradingAutomations.userId, user.id), eq(tradingAutomations.status, "paused"), eq(tradingAutomations.pausedBy, "breaker"))),
  ]);
  const total = spent.automations + spent.trading + spent.chat;
  const lines = [
    `Good morning.${balance ? ` Balance ${credits(balance.micro)}.` : ""}`,
    total > 0n
      ? `Yesterday you spent ${formatCredits(total)} credits: ${formatCredits(spent.automations)} on ${spent.runs} automation runs, ${formatCredits(spent.trading)} on ${spent.cycles} trading cycles, ${formatCredits(spent.chat)} here.`
      : "Nothing was spent yesterday.",
  ];
  if (agents.length) lines.push("", "Trading agents:", bullet(agents));
  if (paused.length) lines.push("", "Auto-paused and waiting for you:", bullet(paused.map((agent) => `${agent.name}: ${agent.reason ?? "a safety limit was reached"}`)));
  if (runRows.length) {
    const failed = runRows.filter((run) => run.status === "failed" || run.status === "stopped_budget");
    const waiting = runRows.filter((run) => run.status === "waiting_approval");
    lines.push("", `Automations since yesterday: ${runRows.length} runs, ${runRows.filter((run) => run.status === "succeeded").length} succeeded${failed.length ? `, ${failed.length} failed (${[...new Set(failed.map((run) => run.name))].join(", ")})` : ""}${waiting.length ? `, ${waiting.length} waiting for your approval` : ""}.`);
  }
  lines.push("", "Reply to ask me anything.");
  return lines.join("\n");
}

async function sendBrief(chat: BotChat, user: User, api: TelegramApi, now: number): Promise<void> {
  if (chat.briefHour === null) return;
  const today = localDate(now, chat.timezone);
  if (chat.lastBriefOn === today || localHour(now, chat.timezone) !== chat.briefHour) return;
  // Claim the day first, so a slow brief is never sent twice.
  await updateChat(chat.chatId, { lastBriefOn: today });
  await api.sendMessage(chat.chatId, await briefText(chat, user, now));
}

async function checkBalance(chat: BotChat, user: User, api: TelegramApi, now: number): Promise<void> {
  if (chat.lowBalanceMicro <= 0n) return;
  if (now - (balanceChecked.get(chat.chatId) ?? 0) < BALANCE_CHECK_MS) return;
  balanceChecked.set(chat.chatId, now);
  const balance = await getBalance(user).catch(() => null);
  if (!balance || balance.micro >= chat.lowBalanceMicro) return;
  if (chat.lowBalanceAlertedAt && now - chat.lowBalanceAlertedAt.getTime() < ALERT_AGAIN_MS) return;
  await updateChat(chat.chatId, { lowBalanceAlertedAt: new Date(now) });
  await api.sendMessage(
    chat.chatId,
    `Your Accred balance is down to ${credits(balance.micro)}, below your ${formatCredits(chat.lowBalanceMicro)}-credit alert level. Automations and trading cycles stop when it runs out. Top up at https://accred.sh (Wallet).`,
  );
}

