import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { automations, db, executions, runs, tradingAutomations } from "@lib/db";
import { microToExact } from "@lib/credits";

/** CSV files the user can ask for: their trades, or their automation runs. */

const MAX_ROWS = 2_000;
const DAYS = 90;

export function toCsv(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const cell = (value: string | number | null | undefined) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

export async function tradesCsv(userId: string, now = Date.now()): Promise<{ csv: string; rows: number }> {
  const agents = await db.select({ id: tradingAutomations.id, name: tradingAutomations.name }).from(tradingAutomations).where(eq(tradingAutomations.userId, userId));
  if (agents.length === 0) return { csv: toCsv(["time", "agent", "side", "symbol", "quantity", "price_usd", "notional_usd", "swap_fee_usd", "network_fee_usd", "realized_pnl_usd", "reason", "status", "tx_hash"], []), rows: 0 };
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
  const list = await db
    .select()
    .from(executions)
    .where(and(inArray(executions.automationId, agents.map((agent) => agent.id)), gte(executions.createdAt, new Date(now - DAYS * 86_400_000))))
    .orderBy(desc(executions.createdAt))
    .limit(MAX_ROWS);
  const rows = list.map((trade) => [
    trade.createdAt.toISOString(),
    names.get(trade.automationId) ?? trade.automationId,
    trade.side,
    trade.symbol,
    trade.quantity,
    trade.priceUsd,
    trade.notionalUsd,
    trade.swapFeeUsd,
    trade.networkFeeUsd,
    trade.realizedPnlUsd,
    trade.reason,
    trade.status,
    trade.txHash,
  ]);
  return { csv: toCsv(["time", "agent", "side", "symbol", "quantity", "price_usd", "notional_usd", "swap_fee_usd", "network_fee_usd", "realized_pnl_usd", "reason", "status", "tx_hash"], rows), rows: rows.length };
}

export async function runsCsv(userId: string, now = Date.now()): Promise<{ csv: string; rows: number }> {
  const list = await db
    .select({ at: runs.createdAt, name: automations.name, trigger: runs.trigger, status: runs.status, credits: runs.creditsMicro, error: runs.error, finishedAt: runs.finishedAt, id: runs.id })
    .from(runs)
    .innerJoin(automations, eq(automations.id, runs.automationId))
    .where(and(eq(runs.userId, userId), gte(runs.createdAt, new Date(now - DAYS * 86_400_000))))
    .orderBy(desc(runs.createdAt))
    .limit(MAX_ROWS);
  const rows = list.map((run) => [run.at.toISOString(), run.name, run.trigger, run.status, microToExact(run.credits), run.finishedAt?.toISOString() ?? "", run.error ?? "", run.id]);
  return { csv: toCsv(["time", "automation", "trigger", "status", "credits", "finished", "error", "run_id"], rows), rows: rows.length };
}
