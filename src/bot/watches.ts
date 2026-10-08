import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { botWatches, db, positions, runs, automations, tradingAutomations, type BotChat, type BotWatch, type BotWatchKind, type User } from "@lib/db";
import { fetchSnapshots } from "@lib/trading/market-data";
import { resolveAssets } from "@lib/trading/create";
import { USDG, WETH } from "@lib/trading/chain";
import { fmtPrice, fmtUsd, signedUsd } from "@lib/trading/format";
import { timeAgo } from "@lib/format";

/**
 * Alerts the user defines: "ETH below 2000" fires once when the price crosses;
 * event watches (a position closed, a run failed, an agent auto-paused) are
 * standing and fire for every new event. The heartbeat checks them once a
 * minute without a model call, so they cost no credits.
 */

export const MAX_WATCHES = 20;
export const PRICE_CHECK_MS = 60_000;

export const WATCH_LABEL: Record<BotWatchKind, string> = {
  price_below: "price below",
  price_above: "price above",
  position_closed: "a position closes",
  run_failed: "an automation run fails",
  agent_paused: "an agent is auto-paused",
};

export function describeWatch(watch: BotWatch, agentName?: string): string {
  if (watch.kind === "price_below" || watch.kind === "price_above") {
    return `${watch.assetSymbol} ${watch.kind === "price_below" ? "below" : "above"} ${fmtPrice(watch.thresholdUsd ?? 0)}${watch.status === "fired" ? " (fired)" : ""}`;
  }
  return `${WATCH_LABEL[watch.kind]}${agentName ? ` (${agentName})` : ""}`;
}

export interface ParsedWatch {
  kind: BotWatchKind;
  symbol?: string;
  threshold?: number;
  agent?: string;
}

/** Wrapped tokens stand in for the natives the user names; the chain's own addresses are tried last. */
const SYMBOL_ALIASES: Record<string, string[]> = { ETH: ["WETH", WETH.address], WETH: [WETH.address], BTC: ["WBTC", "CBBTC"], USD: ["USDG", USDG.address], USDG: [USDG.address] };

/**
 * "ETH below 2000", "eth < 2000", "alert me when btc goes above 70k",
 * "cred falls to 0.05", "position closed", "run failed", "agent paused Momentum".
 * Case never matters.
 */
export function parseWatch(text: string): ParsedWatch | null {
  let clean = text.trim().replace(/[$,]/g, "").replace(/\s+/g, " ");
  clean = clean.replace(/^(?:please\s+)?(?:tell me|notify me|alert me|ping me|warn me|alert|notify|watch)?\s*(?:when|if|once)?\s*(?:the\s+)?(?:price of\s+)?/i, "").trim();
  const price = /^([a-z0-9.]{2,16}|0x[0-9a-f]{40})\s*(?:price\s*)?(?:is\s+|goes\s+|gets\s+|falls?\s+|drops?\s+|rises?\s+|climbs?\s+|moves?\s+)?(below|under|<|<=|to|above|over|>|>=|reaches|hits|crosses|past)\s*([0-9]+(?:\.[0-9]+)?)\s*(k|m)?\s*(?:usd|dollars?)?$/i.exec(clean);
  if (price) {
    const [, symbol, direction, amount, unit] = price;
    const factor = unit?.toLowerCase() === "k" ? 1_000 : unit?.toLowerCase() === "m" ? 1_000_000 : 1;
    const verb = /falls?|drops?/i.exec(clean)?.[0];
    const below = /below|under|^<=?$/i.test(direction!) || (direction!.toLowerCase() === "to" && Boolean(verb));
    return { kind: below ? "price_below" : "price_above", symbol: symbol!.toUpperCase(), threshold: Number(amount) * factor };
  }
  const event = /^(?:a\s+|an\s+|any\s+)?(position(?:s)? (?:is |gets )?closed?|closed? position|run(?:s)? (?:is |gets )?fail(?:ed|s)?|fail(?:ed|ing)? runs?|automation(?:s)? fail(?:ed|s)?|agent(?:s)? (?:is |gets )?(?:auto-?)?paused?|paused? agents?)(?:\s+(?:for\s+|on\s+)?(.+))?$/i.exec(clean);
  if (event) {
    const [, which, agent] = event;
    const kind: BotWatchKind = /position/i.test(which!) ? "position_closed" : /run|fail|automation/i.test(which!) ? "run_failed" : "agent_paused";
    return { kind, agent: agent?.trim() || undefined };
  }
  return null;
}

/** Finds the token for a symbol, trying the wrapped form when the native name is not listed. */
async function resolveSymbol(symbol: string): Promise<{ address: string; symbol: string } | null> {
  const candidates = [symbol, ...(SYMBOL_ALIASES[symbol.toUpperCase()] ?? [])];
  for (const candidate of candidates) {
    const { assets } = await resolveAssets([candidate]);
    if (assets[0]) return { address: assets[0].address, symbol: assets[0].symbol };
  }
  return null;
}

export async function listWatches(chatId: string): Promise<BotWatch[]> {
  return db.select().from(botWatches).where(and(eq(botWatches.chatId, chatId), inArray(botWatches.status, ["active", "fired"]))).orderBy(desc(botWatches.createdAt));
}

export class WatchError extends Error {}

export async function createWatch(chat: BotChat, user: User, parsed: ParsedWatch): Promise<BotWatch> {
  const existing = await listWatches(chat.chatId);
  if (existing.length >= MAX_WATCHES) throw new WatchError(`You already have ${MAX_WATCHES} alerts. Remove one with /alert off <number>.`);
  let assetAddress: string | null = null;
  let assetSymbol: string | null = null;
  let agentId: string | null = null;
  if (parsed.kind === "price_below" || parsed.kind === "price_above") {
    const asset = await resolveSymbol(parsed.symbol!);
    if (!asset) throw new WatchError(`I could not find "${parsed.symbol}" on Robinhood Chain. Use a symbol from the top list (ask "which assets trade?") or a 0x address.`);
    assetAddress = asset.address;
    assetSymbol = asset.symbol;
    if (!(parsed.threshold! > 0)) throw new WatchError("Give a price above zero.");
  } else if (parsed.agent) {
    const rows = await db.select({ id: tradingAutomations.id, name: tradingAutomations.name }).from(tradingAutomations).where(eq(tradingAutomations.userId, user.id));
    const wanted = parsed.agent.toLowerCase();
    const match = rows.find((row) => row.name.toLowerCase() === wanted) ?? rows.find((row) => row.name.toLowerCase().includes(wanted));
    if (!match) throw new WatchError(`No agent matches "${parsed.agent}". Your agents: ${rows.map((row) => row.name).join(", ") || "none"}.`);
    agentId = match.id;
  }
  const duplicate = existing.find(
    (watch) => watch.kind === parsed.kind && watch.assetAddress === assetAddress && watch.thresholdUsd === (parsed.threshold ?? null) && watch.agentId === agentId && watch.status === "active",
  );
  if (duplicate) return duplicate;
  const [watch] = await db
    .insert(botWatches)
    .values({ chatId: chat.chatId, userId: user.id, kind: parsed.kind, assetAddress, assetSymbol, thresholdUsd: parsed.threshold ?? null, agentId })
    .returning();
  return watch!;
}

export async function removeWatch(chatId: string, id: string): Promise<boolean> {
  const rows = await db.update(botWatches).set({ status: "off" }).where(and(eq(botWatches.id, id), eq(botWatches.chatId, chatId))).returning({ id: botWatches.id });
  return rows.length > 0;
}

export async function agentNames(userId: string): Promise<Map<string, string>> {
  const rows = await db.select({ id: tradingAutomations.id, name: tradingAutomations.name }).from(tradingAutomations).where(eq(tradingAutomations.userId, userId));
  return new Map(rows.map((row) => [row.id, row.name]));
}

export interface WatchDeps {
  prices(addresses: string[]): Promise<Map<string, number>>;
  now(): number;
}

export const defaultWatchDeps: WatchDeps = {
  prices: async (addresses) => {
    const snapshots = await fetchSnapshots(addresses, { fresh: true });
    return new Map([...snapshots.entries()].map(([address, snapshot]) => [address, snapshot.priceUsd]));
  },
  now: () => Date.now(),
};

/** Price watches that crossed their threshold. Pure, so it can be tested without a chain. */
export function pricesCrossed(watches: BotWatch[], prices: Map<string, number>): Array<{ watch: BotWatch; price: number }> {
  const hits: Array<{ watch: BotWatch; price: number }> = [];
  for (const watch of watches) {
    if (watch.status !== "active" || !watch.assetAddress || watch.thresholdUsd === null) continue;
    const price = prices.get(watch.assetAddress);
    if (price === undefined || !Number.isFinite(price)) continue;
    if (watch.kind === "price_below" && price <= watch.thresholdUsd) hits.push({ watch, price });
    if (watch.kind === "price_above" && price >= watch.thresholdUsd) hits.push({ watch, price });
  }
  return hits;
}

/**
 * Everything that should be sent to the chat now. Price watches that fired are
 * marked "fired"; event watches stay active and the chat's watermark moves.
 */
export async function checkWatches(chat: BotChat, user: User, deps: WatchDeps = defaultWatchDeps): Promise<string[]> {
  const watches = await listWatches(chat.chatId);
  const now = deps.now();
  const since = chat.lastWatchAt ?? new Date(now - 60_000);
  const notices: string[] = [];
  const names = await agentNames(user.id);

  const priceWatches = watches.filter((watch) => watch.status === "active" && watch.assetAddress);
  if (priceWatches.length) {
    const prices = await deps.prices([...new Set(priceWatches.map((watch) => watch.assetAddress!))]).catch(() => new Map<string, number>());
    for (const { watch, price } of pricesCrossed(priceWatches, prices)) {
      await db.update(botWatches).set({ status: "fired", firedCount: watch.firedCount + 1, lastFiredAt: new Date(now) }).where(eq(botWatches.id, watch.id));
      notices.push(`${watch.assetSymbol} is at ${fmtPrice(price)}, ${watch.kind === "price_below" ? "below" : "above"} your ${fmtPrice(watch.thresholdUsd ?? 0)} alert.`);
    }
  }

  const eventWatches = watches.filter((watch) => watch.status === "active" && !watch.assetAddress);
  const wants = (kind: BotWatchKind, agentId: string | null) => eventWatches.filter((watch) => watch.kind === kind && (!watch.agentId || watch.agentId === agentId));

  if (eventWatches.some((watch) => watch.kind === "position_closed")) {
    const closed = await db
      .select({ id: positions.id, automationId: positions.automationId, symbol: positions.symbol, realizedPnlUsd: positions.realizedPnlUsd, feesUsd: positions.feesUsd, closeReason: positions.closeReason, closedAt: positions.closedAt })
      .from(positions)
      .where(and(eq(positions.userId, user.id), eq(positions.status, "closed"), gte(positions.closedAt, since)))
      .limit(20);
    for (const position of closed) {
      const hit = wants("position_closed", position.automationId);
      if (hit.length === 0) continue;
      notices.push(`${names.get(position.automationId) ?? "An agent"} closed ${position.symbol}: ${signedUsd(position.realizedPnlUsd - position.feesUsd)} after fees (${(position.closeReason ?? "closed").replace(/_/g, " ")}).`);
      await db.update(botWatches).set({ firedCount: hit[0]!.firedCount + 1, lastFiredAt: new Date(now) }).where(inArray(botWatches.id, hit.map((watch) => watch.id)));
    }
  }
  if (eventWatches.some((watch) => watch.kind === "run_failed")) {
    const failed = await db
      .select({ id: runs.id, name: automations.name, error: runs.error, finishedAt: runs.finishedAt })
      .from(runs)
      .innerJoin(automations, eq(automations.id, runs.automationId))
      .where(and(eq(runs.userId, user.id), inArray(runs.status, ["failed", "stopped_budget"]), gte(runs.finishedAt, since)))
      .limit(20);
    const hit = wants("run_failed", null);
    for (const run of failed) {
      notices.push(`Automation "${run.name}" failed ${timeAgo(run.finishedAt)}: ${(run.error ?? "no details").slice(0, 200)}`);
    }
    if (failed.length && hit.length) await db.update(botWatches).set({ firedCount: hit[0]!.firedCount + failed.length, lastFiredAt: new Date(now) }).where(inArray(botWatches.id, hit.map((watch) => watch.id)));
  }
  if (eventWatches.some((watch) => watch.kind === "agent_paused")) {
    const paused = await db
      // The automation row is touched when the breaker pauses it, so its update time is the pause time.
      .select({ id: tradingAutomations.id, name: tradingAutomations.name, reason: tradingAutomations.pauseReason })
      .from(tradingAutomations)
      .where(and(eq(tradingAutomations.userId, user.id), eq(tradingAutomations.status, "paused"), eq(tradingAutomations.pausedBy, "breaker"), gte(tradingAutomations.updatedAt, since)));
    for (const agent of paused) {
      const hit = wants("agent_paused", agent.id);
      if (hit.length === 0) continue;
      notices.push(`${agent.name} was auto-paused: ${agent.reason ?? "a safety limit was reached"}. Say "resume ${agent.name}" when you want it back.`);
      await db.update(botWatches).set({ firedCount: hit[0]!.firedCount + 1, lastFiredAt: new Date(now) }).where(inArray(botWatches.id, hit.map((watch) => watch.id)));
    }
  }
  return notices;
}

export const usd = fmtUsd;
