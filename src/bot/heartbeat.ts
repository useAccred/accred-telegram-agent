import { and, desc, eq, gte, notInArray, sql } from "drizzle-orm";
import { getBalance } from "../balance";
import { formatCredits } from "@lib/credits";
import { automations, db, positions, runSteps, runs, tradingAutomations, type BotChat, type User } from "@lib/db";
import { fmtUsd, signedUsd } from "@lib/trading/format";
import { listTradingAgents, listWallets } from "@lib/trading/queries";
import { walletBalances } from "@lib/trading/wallets";
import { credBalance } from "./cred";
import { dayStart } from "@lib/trading/portfolio";
import { briefDetailButtons, requestRunApproval } from "./actions";
import { credMarket } from "./cred";
import { checkWatches } from "./watches";
import { bullet, credits, isoWeek, localDate, localDay, localHour } from "./format";
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
const DEPOSIT_CHECK_MS = 2 * 60_000;
const depositChecked = new Map<string, number>();

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
      await sendWeekly(chat, user, api, now);
      await checkBalance(chat, user, api, now);
      await watchDeposits(chat, user, api, now);
      await sendWatches(chat, user, api, now);
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
  const wants = (section: BotChat["briefSections"][number]) => chat.briefSections.includes(section);
  const lines = [`Good morning.${wants("balance") && balance ? ` Balance ${credits(balance.micro)}.` : ""}`];
  if (wants("spend")) {
    lines.push(
      total > 0n
        ? `Yesterday you spent ${formatCredits(total)} credits: ${formatCredits(spent.automations)} on ${spent.runs} automation runs, ${formatCredits(spent.trading)} on ${spent.cycles} trading cycles, ${formatCredits(spent.chat)} here.`
        : "Nothing was spent yesterday.",
    );
  }
  if (wants("agents")) {
    // One line per agent keeps the brief short; the Details button has the rest.
    if (agents.length) lines.push("", "Trading agents:", bullet(agents.map((line) => line.split(" · ").slice(0, 3).join(" · "))));
    if (paused.length) lines.push("", "Auto-paused and waiting for you:", bullet(paused.map((agent) => `${agent.name}: ${agent.reason ?? "a safety limit was reached"}`)));
  }
  if (wants("automations") && runRows.length) {
    const failed = runRows.filter((run) => run.status === "failed" || run.status === "stopped_budget");
    const waiting = runRows.filter((run) => run.status === "waiting_approval");
    lines.push("", `Automations since yesterday: ${runRows.length} runs, ${runRows.filter((run) => run.status === "succeeded").length} succeeded${failed.length ? `, ${failed.length} failed (${[...new Set(failed.map((run) => run.name))].join(", ")})` : ""}${waiting.length ? `, ${waiting.length} waiting for your approval` : ""}.`);
  }
  if (wants("cred")) {
    const market = await credMarket().catch(() => null);
    if (market) lines.push("", market.text.split("\n")[0]!);
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
  await api.sendMessage(chat.chatId, await briefText(chat, user, now), { buttons: briefDetailButtons });
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


// ── Deposits ────────────────────────────────────────────────────────────────

export type Held = { usdg: number; eth: number; cred: number; at: number };

/** The increases worth telling the user about, in words. Small movements and decreases are ignored. */
export function depositChanges(before: Held | undefined, after: Held): string[] {
  if (!before) return [];
  const lines: string[] = [];
  // A hair of tolerance, so 0.0012 − 0.001 counts as the 0.0002 it is.
  const grew = (from: number, to: number, min: number) => to - from >= min - 1e-9;
  if (grew(before.usdg, after.usdg, 0.5)) lines.push(`+${(after.usdg - before.usdg).toFixed(2)} USDG`);
  if (grew(before.eth, after.eth, 0.0002)) lines.push(`+${(after.eth - before.eth).toFixed(5)} ETH`);
  if (grew(before.cred, after.cred, 1)) lines.push(`+${(after.cred - before.cred).toLocaleString("en-US", { maximumFractionDigits: 0 })} CRED`);
  return lines;
}

/** Announces arrivals in the user's trading wallets. The first reading of a wallet is only remembered. */
async function watchDeposits(chat: BotChat, user: User, api: TelegramApi, now: number): Promise<void> {
  if (now - (depositChecked.get(chat.chatId) ?? 0) < DEPOSIT_CHECK_MS) return;
  depositChecked.set(chat.chatId, now);
  const wallets = await listWallets(user.id);
  if (wallets.length === 0) return;
  const seen = { ...chat.walletBalances };
  const notices: string[] = [];
  for (const wallet of wallets) {
    const [balances, cred] = await Promise.all([walletBalances(wallet.address, { maxAgeMs: 0 }).catch(() => null), credBalance(wallet.address).catch(() => null)]);
    if (!balances || cred === null) continue;
    const held: Held = { usdg: balances.usdg, eth: balances.eth, cred, at: now };
    const changes = depositChanges(seen[wallet.address], held);
    if (changes.length) {
      notices.push(`${changes.join(", ")} arrived in ${wallet.name} (${wallet.address}). It now holds ${held.usdg.toFixed(2)} USDG, ${held.eth.toFixed(5)} ETH and ${held.cred.toLocaleString("en-US", { maximumFractionDigits: 0 })} CRED.`);
    }
    seen[wallet.address] = held;
  }
  await updateChat(chat.chatId, { walletBalances: seen });
  if (notices.length) await api.sendMessage(chat.chatId, `${notices.join("\n\n")}\n\nSay "set up a trading agent" or "buy CRED" whenever you are ready.`);
}

// ── Weekly report ───────────────────────────────────────────────────────────

export async function weeklyText(chat: BotChat, user: User, now = Date.now()): Promise<string> {
  const since = new Date(now - 7 * 86_400_000);
  const [agents, closed, spent] = await Promise.all([
    listTradingAgents(user.id).catch(() => []),
    db
      .select({ automationId: positions.automationId, symbol: positions.symbol, realizedPnlUsd: positions.realizedPnlUsd, feesUsd: positions.feesUsd, closeReason: positions.closeReason })
      .from(positions)
      .where(and(eq(positions.userId, user.id), eq(positions.status, "closed"), gte(positions.closedAt, since))),
    creditsBetween(user.id, since, new Date(now)),
  ]);
  const lines = [`Your week with Accred (${localDate(since.getTime(), chat.timezone)} to ${localDate(now, chat.timezone)}):`];
  if (agents.length === 0) lines.push("No trading agents yet.");
  for (const { automation, portfolio } of agents) {
    const mine = closed.filter((position) => position.automationId === automation.id);
    const results = mine.map((position) => position.realizedPnlUsd - position.feesUsd);
    const net = results.reduce((total, value) => total + value, 0);
    const wins = results.filter((value) => value > 0).length;
    const best = mine.length ? mine.reduce((a, b) => (a.realizedPnlUsd - a.feesUsd >= b.realizedPnlUsd - b.feesUsd ? a : b)) : null;
    const worst = mine.length ? mine.reduce((a, b) => (a.realizedPnlUsd - a.feesUsd <= b.realizedPnlUsd - b.feesUsd ? a : b)) : null;
    lines.push(
      "",
      `${automation.name} (${automation.status}): ${mine.length} closed trade${mine.length === 1 ? "" : "s"}, net ${signedUsd(net)} after fees${mine.length ? `, win rate ${Math.round((wins / mine.length) * 100)}%` : ""}.` +
        (best && worst && mine.length > 1 ? ` Best ${best.symbol} ${signedUsd(best.realizedPnlUsd - best.feesUsd)}, worst ${worst.symbol} ${signedUsd(worst.realizedPnlUsd - worst.feesUsd)}.` : "") +
        ` Equity now ${fmtUsd(portfolio.equityUsd)} of ${fmtUsd(portfolio.allocationUsd)}, ${portfolio.openPositions} open.`,
    );
  }
  const total = spent.automations + spent.trading + spent.chat;
  lines.push("", `Credits this week: ${formatCredits(total)} (${formatCredits(spent.trading)} on ${spent.cycles} trading cycles, ${formatCredits(spent.automations)} on ${spent.runs} automation runs, ${formatCredits(spent.chat)} here).`, "", "Ask me for any agent's details, or say what to change.");
  return lines.join("\n");
}

/** Monday at the brief hour (09:00 when no brief is set), once a week. */
async function sendWeekly(chat: BotChat, user: User, api: TelegramApi, now: number): Promise<void> {
  const hour = chat.briefHour ?? 9;
  if (localDay(now, chat.timezone) !== 1 || localHour(now, chat.timezone) !== hour) return;
  const week = isoWeek(localDate(now, chat.timezone));
  if (chat.lastWeeklyOn === week) return;
  await updateChat(chat.chatId, { lastWeeklyOn: week });
  await api.sendMessage(chat.chatId, await weeklyText(chat, user, now), { buttons: [[{ text: "Agent details", callback_data: "b:agents" }]] });
}

// ── Alerts the user defined ─────────────────────────────────────────────────

/** Price thresholds and event watches. Each chat is checked once a minute; the watermark moves whatever happens. */
async function sendWatches(chat: BotChat, user: User, api: TelegramApi, now: number): Promise<void> {
  const notices = await checkWatches(chat, user);
  await updateChat(chat.chatId, { lastWatchAt: new Date(now) });
  if (notices.length) await api.sendMessage(chat.chatId, notices.join("\n\n"));
}
