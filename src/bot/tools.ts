import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { listModels } from "@lib/accred";
import { displayName, featuredModels, pickRouting, usableTextModels } from "@lib/agent/router";
import { createRun, executeRun } from "@lib/agent/runner";
import { ToolError, toolsFor, type ToolContext } from "@lib/agent/tools";
import { getBalance } from "../balance";
import { MICRO, formatCredits, toMicro } from "@lib/credits";
import { automations, db, tradingAutomations, type BotChat, type User } from "@lib/db";
import { env } from "@lib/env";
import { monthStart } from "@lib/queries";
import { describeCron, isValidTimezone, nextRun, validateCron } from "@lib/schedule";
import { closeAllPositions, ownedAgent, pauseAgent, resumeAgent, revokeAccess } from "@lib/trading/controls";
import { assetsBlockedBy, buildMandate, createAgentFromProfile, CreateAgentError, describeMandate, resolveAssets, type Profile } from "@lib/trading/create";
import { runTradingCycle } from "@lib/trading/engine";
import { fmtPrice, fmtUsd, signedUsd } from "@lib/trading/format";
import { INTERVALS, intervalLabel } from "@lib/trading/mandate-fields";
import { topAssets, type AssetOption } from "@lib/trading/market-data";
import { agentDashboard, listDecisions, listPositions, listTradingAgents, listTrades, listWallets } from "@lib/trading/queries";
import { loadAgent, type LoadedAgent } from "@lib/trading/store";
import { STRATEGIES, STRATEGY_KINDS, isStrategyKind, type StrategyKind } from "@lib/trading/strategy";
import { createWallet, walletBalances, WalletError } from "@lib/trading/wallets";
import { bullet, credits } from "./format";
import { chatConnectionId, connectionsOfKinds, creditsBetween, MEMORY_CHARS, updateChat } from "./store";
import { timeAgo } from "@lib/format";
import { randomToken } from "@lib/crypto";

/**
 * The Telegram agent's tools. Read tools run as soon as the model asks. Write
 * tools never run from the model: `prepare` turns the model's arguments into a
 * description and normalised arguments, the user sees the description with a
 * Confirm button, and only a tap runs `run`.
 */

export type BotEffect = "read" | "write" | "internal";

export interface BotContext {
  user: User;
  chat: BotChat;
}

export interface Prepared {
  /** One line, for the log and the transcript. */
  title: string;
  /** What will happen, in plain words, shown above the buttons. */
  description: string;
  /** Arguments as `run` wants them, resolved from what the model said. */
  args: Record<string, unknown>;
  confirmLabel?: string;
}

export interface BotToolDef<Args = Record<string, unknown>> {
  name: string;
  summary: string;
  argsHint: string;
  schema: z.ZodType<Args>;
  effect: BotEffect;
  /** Write tools only. */
  prepare?(args: Args, context: BotContext): Promise<Prepared>;
  run(args: Args, context: BotContext): Promise<string>;
}

function define<Schema extends z.ZodType>(tool: BotToolDef<z.infer<Schema>> & { schema: Schema }): BotToolDef {
  return tool as unknown as BotToolDef;
}

export { ToolError };

const WEB = "https://agent.accred.sh";
const usd = (value: number) => fmtUsd(value);

// ── Built in ────────────────────────────────────────────────────────────────

const baseWebFetch = toolsFor([]).find((tool) => tool.name === "web.fetch")!;
const emptyContext: ToolContext = { configs: {}, saveMemory: async () => {} };

const webFetch = define({
  name: "web.fetch",
  summary: baseWebFetch.summary,
  argsHint: baseWebFetch.argsHint,
  schema: z.object({ url: z.string().min(8).max(2000) }),
  effect: "read",
  run: (args) => baseWebFetch.run(args, emptyContext),
});

const memorySave = define({
  name: "memory.save",
  summary: "Replace the note you keep about this user: preferences, standing instructions, facts they told you. Keep it short.",
  argsHint: '{"text": string}',
  schema: z.object({ text: z.string().max(4000) }),
  effect: "internal",
  async run(args, context) {
    await updateChat(context.chat.chatId, { memory: args.text.trim().slice(0, MEMORY_CHARS) });
    return "Saved.";
  },
});

// ── Account ─────────────────────────────────────────────────────────────────

export async function balanceLine(user: User): Promise<string> {
  const balance = await getBalance(user).catch(() => null);
  if (!balance) return "Balance: not known yet (it appears after the first model call).";
  return `Balance: ${credits(balance.micro)}${balance.source === "reported" ? ` (as of ${timeAgo(balance.at)})` : ""}.`;
}

const accountBalance = define({
  name: "account.balance",
  summary: "The user's Accred credit balance and what they spent this month on automations, trading agents and this chat.",
  argsHint: "{}",
  schema: z.object({}),
  effect: "read",
  async run(_args, context) {
    const [line, month] = await Promise.all([balanceLine(context.user), creditsBetween(context.user.id, monthStart(), new Date())]);
    return [
      line,
      `This month: ${formatCredits(month.automations)} credits on ${month.runs} automation runs, ${formatCredits(month.trading)} on ${month.cycles} trading cycles, ${formatCredits(month.chat)} in this chat.`,
      `100 credits = $1. Top up at https://accred.sh (Wallet).`,
    ].join("\n");
  },
});

const modelsList = define({
  name: "models.list",
  summary: "Featured models with their prices, and which model each mode (auto, economy, quality) uses right now.",
  argsHint: "{}",
  schema: z.object({}),
  effect: "read",
  async run() {
    const catalog = await listModels();
    const lines = featuredModels(catalog)
      .slice(0, 14)
      .map((model) => `${displayName(model, catalog)} (${model.id}): $${model.inputCostUsdPerMillion} in / $${model.outputCostUsdPerMillion} out per million tokens`);
    const modes = (["auto", "economy", "quality"] as const).map((mode) => {
      try {
        return `${mode}: ${displayName(pickRouting(catalog, mode).planner, catalog)}`;
      } catch {
        return `${mode}: unavailable`;
      }
    });
    return `Modes right now: ${modes.join("; ")}.\nFeatured models:\n${bullet(lines)}`;
  },
});

// ── Trading: reading ────────────────────────────────────────────────────────

function statusWord(agent: LoadedAgent): string {
  const { automation } = agent;
  if (automation.status === "running") return "Running";
  if (automation.status === "paused") return automation.pausedBy === "breaker" ? `Auto-paused (${automation.pauseReason ?? "safety limit"})` : "Paused by you";
  return automation.accessRevokedAt ? "Stopped, access revoked" : "Stopped";
}

export async function agentLines(userId: string): Promise<string[]> {
  const agents = await listTradingAgents(userId);
  return agents.map(({ automation, portfolio }) => {
    const open = portfolio.openPositions ? `${portfolio.openPositions} open (${portfolio.openAssets.join(", ")})` : "no open positions";
    const status =
      automation.status === "running" ? "Running" : automation.status === "paused" ? (automation.pausedBy === "breaker" ? "Auto-paused" : "Paused") : "Stopped";
    return `${automation.name}: ${status} · equity ${usd(portfolio.equityUsd)} of ${usd(portfolio.allocationUsd)} · today ${signedUsd(portfolio.dayNetUsd)} · total ${signedUsd(portfolio.realizedNetUsd + portfolio.unrealizedUsd)} · ${open}`;
  });
}

/** Finds one of the user's trading agents by id, by name, or as the only one. */
async function findAgent(userId: string, query: string | undefined): Promise<LoadedAgent> {
  const rows = await db
    .select({ id: tradingAutomations.id, name: tradingAutomations.name })
    .from(tradingAutomations)
    .where(eq(tradingAutomations.userId, userId))
    .orderBy(desc(tradingAutomations.createdAt));
  if (rows.length === 0) throw new ToolError("The user has no trading agents yet.");
  const wanted = (query ?? "").trim().toLowerCase();
  let match = rows.find((row) => row.id === wanted);
  if (!match && wanted) match = rows.find((row) => row.name.toLowerCase() === wanted) ?? rows.find((row) => row.name.toLowerCase().includes(wanted));
  if (!match && !wanted && rows.length === 1) match = rows[0];
  if (!match) throw new ToolError(`No agent matches "${query}". The user's agents: ${rows.map((row) => row.name).join(", ")}.`);
  const agent = await loadAgent(match.id);
  if (!agent) throw new ToolError("That agent could not be loaded.");
  return agent;
}

const tradingOverview = define({
  name: "trading.overview",
  summary: "The user's trading wallets with their ETH and USDG, and every trading agent with its status, equity, result and open positions.",
  argsHint: "{}",
  schema: z.object({}),
  effect: "read",
  async run(_args, context) {
    const wallets = await listWallets(context.user.id);
    const walletLines = await Promise.all(
      wallets.map(async (wallet) => {
        const balances = await walletBalances(wallet.address).catch(() => null);
        const funds = balances ? `${balances.usdg.toFixed(2)} USDG, ${balances.eth.toFixed(5)} ETH (${usd(balances.totalUsd)})` : "balance not readable right now";
        return `${wallet.name} ${wallet.address}: ${funds}${wallet.tradingRevokedAt ? " · trading authority REVOKED" : ""}`;
      }),
    );
    const agents = await agentLines(context.user.id);
    return [
      wallets.length ? `Wallets:\n${bullet(walletLines)}` : "No trading wallet yet. One can be created with trading.create_wallet.",
      agents.length ? `Agents:\n${bullet(agents)}` : "No trading agents yet.",
      `Live trading on this server: ${env.liveTrading ? "on" : "off"}.`,
    ].join("\n\n");
  },
});

const tradingAgent = define({
  name: "trading.agent",
  summary: "One trading agent in detail: status and pause reason, allocation, PnL, open positions with their stop and target, recent decisions and trades.",
  argsHint: '{"agent": string (name or id; may be omitted when the user has one agent)}',
  schema: z.object({ agent: z.string().max(120).optional() }),
  effect: "read",
  async run(args, context) {
    const agent = await findAgent(context.user.id, args.agent);
    const [dashboard, open, decisions, trades] = await Promise.all([
      agentDashboard(agent),
      listPositions(agent.automation.id, "open", 10),
      listDecisions(agent.automation.id, 5),
      listTrades(agent.automation.id, 5),
    ]);
    const p = dashboard.portfolio;
    const lines = [
      `${agent.automation.name}: ${statusWord(agent)}. Live on Robinhood Chain, ${intervalLabel(agent.automation.intervalMinutes).toLowerCase()}.`,
      `Allocation ${usd(p.allocationUsd)}, available ${usd(p.availableUsd)}, equity ${usd(p.equityUsd)}, drawdown ${p.drawdownPercent.toFixed(1)}%.`,
      `Today ${signedUsd(p.dayNetUsd)}, realized ${signedUsd(p.realizedNetUsd)}, unrealized ${signedUsd(p.unrealizedUsd)}. ${dashboard.stats.closedTrades} closed trades, win rate ${dashboard.stats.winRatePercent === null ? "n/a" : `${dashboard.stats.winRatePercent.toFixed(0)}%`}.`,
      `Credits: ${formatCredits(dashboard.costs.creditsMicro)} over ${dashboard.costs.cycles} cycles (${dashboard.costs.modelCalls} with a model call). Proposals ${dashboard.proposals}, rejected ${dashboard.rejected}.`,
      `Strategies: ${agent.strategy.kinds.map((kind) => STRATEGIES[kind].label).join(", ") || "none"}${agent.strategy.instructions ? `; instructions: ${agent.strategy.instructions.slice(0, 200)}` : ""}.`,
      `Assets: ${agent.mandate.allowedAssets.map((asset) => asset.symbol).join(", ")}.`,
    ];
    if (open.length) {
      lines.push(
        "Open positions:",
        bullet(
          open.map(
            (position) =>
              `${position.symbol}: ${position.quantity.toPrecision(5)} at ${fmtPrice(position.entryPriceUsd)}, now ${fmtPrice(position.lastPriceUsd)}, stop ${fmtPrice(position.stopLossPrice)}, target ${position.takeProfitPrice ? fmtPrice(position.takeProfitPrice) : "none"}, opened ${timeAgo(position.openedAt)}`,
          ),
        ),
      );
    }
    if (decisions.length) {
      lines.push(
        "Recent decisions:",
        bullet(
          decisions.map(({ proposal, evaluation }) => {
            const failed = evaluation?.checks.filter((check) => check.status === "fail").map((check) => check.label) ?? [];
            return `${timeAgo(proposal.createdAt)} ${proposal.action} ${proposal.assetSymbol} ${usd(proposal.requestedUsd)} → ${proposal.state}${failed.length ? ` (${failed.join("; ")})` : ""}${proposal.reason ? ` — ${proposal.reason.slice(0, 120)}` : ""}`;
          }),
        ),
      );
    }
    if (trades.length) {
      lines.push(
        "Recent trades:",
        bullet(
          trades.map(
            (trade) =>
              `${timeAgo(trade.createdAt)} ${trade.side} ${trade.symbol} ${usd(trade.notionalUsd)} at ${fmtPrice(trade.priceUsd)} (${trade.reason}) ${trade.status}${trade.side === "sell" ? ` pnl ${signedUsd(trade.realizedPnlUsd)}` : ""}${trade.txHash ? ` https://robin.etherscan.io/tx/${trade.txHash}` : ""}`,
          ),
        ),
      );
    }
    lines.push(`Page: ${WEB}/app/trading/${agent.automation.id}`);
    return lines.join("\n");
  },
});

const tradingAssets = define({
  name: "trading.assets",
  summary: "The most traded tokens on Robinhood Chain with their liquidity, volume and market cap. Use it to choose or check an allowlist.",
  argsHint: "{}",
  schema: z.object({}),
  effect: "read",
  async run() {
    const assets = await topAssets();
    if (assets.length === 0) return "The asset list could not be loaded right now.";
    return bullet(
      assets.map((asset) => `${asset.symbol} (${asset.name}) ${asset.address}: liquidity ${usd(asset.liquidityUsd)}, 24h volume ${usd(asset.volumeH24)}, market cap ${asset.marketCapUsd === null ? "unknown" : usd(asset.marketCapUsd)}`),
    );
  },
});

// ── Trading: controls (confirmed) ───────────────────────────────────────────

const agentArg = z.object({ agent: z.string().max(120).optional() });

function control(name: string, summary: string, verb: string, describe: (agent: LoadedAgent) => string, act: (agent: LoadedAgent) => Promise<string>) {
  return define({
    name,
    summary,
    argsHint: '{"agent": string (name or id)}',
    schema: agentArg,
    effect: "write",
    async prepare(args, context) {
      const agent = await findAgent(context.user.id, args.agent);
      return { title: `${verb} ${agent.automation.name}`, description: describe(agent), args: { agent: agent.automation.id } };
    },
    async run(args, context) {
      const agent = await ownedAgent(context.user.id, String(args.agent));
      if (!agent) throw new ToolError("That agent no longer exists.");
      return act(agent);
    },
  });
}

const tradingPause = control(
  "trading.pause",
  "Pause a trading agent: no new positions, protective exits continue. Needs confirmation.",
  "Pause",
  (agent) => `Pause ${agent.automation.name}? No new positions will be opened. Open positions keep their stop loss, take profit and time limit.`,
  (agent) => pauseAgent(agent, "telegram"),
);

const tradingResume = control(
  "trading.resume",
  "Resume a paused trading agent. Needs confirmation.",
  "Resume",
  (agent) => `Resume ${agent.automation.name}? It will start opening positions again inside its mandate. The loss streak and drawdown measure restart from now.${agent.automation.pausedBy === "breaker" ? ` It was auto-paused: ${agent.automation.pauseReason ?? "a safety limit was reached"}.` : ""}`,
  (agent) => resumeAgent(agent, env.liveTrading, "telegram"),
);

const tradingCloseAll = control(
  "trading.close_all",
  "Pause an agent and sell every open position back to USDG at the market price. Needs confirmation.",
  "Close all positions of",
  (agent) => `Close all positions of ${agent.automation.name}? The agent is paused first, then every open position is sold at the market price. A position that cannot be priced or sold stays open under its stop loss.`,
  async (agent) => (await closeAllPositions(agent, "telegram")).text,
);

const tradingRevoke = control(
  "trading.revoke_access",
  "Revoke an agent's authority to propose or open trades. Open positions keep their protective exits. Starting again needs a fresh approval on the web. Needs confirmation.",
  "Revoke trading access of",
  (agent) => `Revoke trading access of ${agent.automation.name}? It will no longer propose or open trades. Open positions keep their stop loss and take profit. Starting it again takes a fresh review and approval on the web.`,
  (agent) => revokeAccess(agent, "telegram"),
);

const tradingRunNow = control(
  "trading.run_now",
  "Start one cycle of a running agent now instead of waiting for its interval. Spends credits if a candidate passes the screens. Needs confirmation.",
  "Run a cycle of",
  (agent) => `Run a cycle of ${agent.automation.name} now? It reads prices, applies the screens and may ask the model, within the agent's credit budget per cycle.`,
  async (agent) => {
    if (agent.automation.status !== "running") return `${agent.automation.name} is ${agent.automation.status}; only a running agent can run a cycle.`;
    const result = await Promise.race([
      runTradingCycle(agent.automation.id, "manual").catch((error) => ({ runId: "", status: "failed" as const, summary: error instanceof Error ? error.message : "The cycle failed." })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 75_000)),
    ]);
    if (result === null) return "The cycle is still running. Ask for the agent's status in a minute to see the result.";
    if (!result) return "Another cycle was already running.";
    return `Cycle ${result.status}: ${result.summary}`;
  },
);

const tradingCreateWallet = define({
  name: "trading.create_wallet",
  summary: "Create a new dedicated trading wallet on Robinhood Chain and return its deposit address. Needs confirmation.",
  argsHint: '{"name"?: string}',
  schema: z.object({ name: z.string().max(60).optional() }),
  effect: "write",
  async prepare(args) {
    const name = args.name?.trim() || "Trading wallet";
    return {
      title: `Create wallet "${name}"`,
      description: `Create a new trading wallet named "${name}"? Its key is generated on the server, stored encrypted and never shown. You then send USDG and a little ETH to its address on Robinhood Chain (chain ID 4663).`,
      args: { name },
    };
  },
  async run(args, context) {
    try {
      const wallet = await createWallet(context.user.id, String(args.name ?? ""));
      return `Wallet "${wallet.name}" created.\nDeposit address (Robinhood Chain, chain ID 4663):\n${wallet.address}\nSend USDG to buy positions with and a little ETH for network fees. Funds sent on another network cannot be recovered.`;
    } catch (error) {
      throw new ToolError(error instanceof WalletError ? error.message : "The wallet could not be created.");
    }
  },
});

const CreateAgentArgs = z.object({
  name: z.string().min(1).max(80),
  wallet: z.string().max(120).optional(),
  allocationUsd: z.coerce.number().min(10).max(1_000_000),
  profile: z.enum(["conservative", "balanced", "aggressive"]),
  assets: z.array(z.string().min(1).max(60)).min(1).max(30),
  strategies: z.array(z.string()).max(5).optional(),
  instructions: z.string().max(2000).optional(),
  intervalMinutes: z.coerce.number().optional(),
  modelMode: z.enum(["auto", "economy", "quality"]).optional(),
  lowerMinimums: z.boolean().optional(),
  creditsPerCycle: z.coerce.number().min(0.1).max(100).optional(),
  creditsPerMonth: z.coerce.number().min(0.1).max(100_000).optional(),
});

const tradingCreateAgent = define({
  name: "trading.create_agent",
  summary:
    "Create and start a trading agent with real funds from one of the user's wallets, using a risk profile's limits. Ask the user for the allocation, the profile and the assets if they did not say. Needs the user's approval.",
  argsHint:
    '{"name": string, "allocationUsd": number, "profile": "conservative"|"balanced"|"aggressive", "assets": string[] (symbols or 0x addresses), "wallet"?: string (name or address; omit when the user has one), "strategies"?: ("momentum"|"breakout"|"trend_following"|"mean_reversion"|"volume_expansion")[], "instructions"?: string, "intervalMinutes"?: 5|15|30|60|240|1440, "modelMode"?: "auto"|"economy"|"quality", "lowerMinimums"?: boolean, "creditsPerCycle"?: number, "creditsPerMonth"?: number}',
  schema: CreateAgentArgs,
  effect: "write",
  async prepare(args, context) {
    if (!env.liveTrading) throw new ToolError("Live trading is switched off on this server, so an agent cannot be started yet.");
    const wallets = await listWallets(context.user.id);
    if (wallets.length === 0) throw new ToolError("The user has no trading wallet. Create one with trading.create_wallet first, then fund it.");
    const wanted = (args.wallet ?? "").trim().toLowerCase();
    const wallet = wanted
      ? wallets.find((candidate) => candidate.id === wanted || candidate.address === wanted || candidate.name.toLowerCase() === wanted) ??
        wallets.find((candidate) => candidate.name.toLowerCase().includes(wanted))
      : wallets.length === 1
        ? wallets[0]
        : undefined;
    if (!wallet) throw new ToolError(`Which wallet? The user has: ${wallets.map((candidate) => `${candidate.name} (${candidate.address})`).join(", ")}.`);
    if (wallet.tradingRevokedAt) throw new ToolError(`Trading authority is revoked for ${wallet.name}. Restore it on the Wallets page first.`);

    const { assets, unknown } = await resolveAssets(args.assets);
    if (unknown.length) throw new ToolError(`These assets were not found on Robinhood Chain: ${unknown.join(", ")}. Use trading.assets to see what trades, or give a 0x address.`);
    const strategies = (args.strategies ?? []).filter(isStrategyKind) as StrategyKind[];
    const instructions = (args.instructions ?? "").trim();
    if (strategies.length === 0 && !instructions) throw new ToolError(`Pick at least one strategy (${STRATEGY_KINDS.join(", ")}) or give instructions.`);
    const intervalMinutes = args.intervalMinutes ?? 15;
    if (!INTERVALS.some((interval) => interval.minutes === intervalMinutes)) throw new ToolError("intervalMinutes must be 5, 15, 30, 60, 240 or 1440.");

    const input = {
      name: args.name.trim(),
      walletId: wallet.id,
      allocationUsd: args.allocationUsd,
      profile: args.profile as Profile,
      assets,
      strategies,
      instructions,
      intervalMinutes,
      modelMode: args.modelMode ?? "auto",
      lowerMinimums: args.lowerMinimums ?? false,
      creditsPerCycle: args.creditsPerCycle ?? 5,
      creditsPerMonth: args.creditsPerMonth ?? 300,
    };
    const mandate = buildMandate(input);
    const blocked = assetsBlockedBy(mandate, assets);
    const balances = await walletBalances(wallet.address).catch(() => null);
    const lines = [
      `Create trading agent "${input.name}" from wallet ${wallet.name} (${wallet.address})?`,
      balances ? `The wallet holds ${balances.usdg.toFixed(2)} USDG and ${balances.eth.toFixed(5)} ETH.` : "The wallet's balance could not be read right now.",
      "",
      "With this mandate the agent:",
      bullet(describeMandate(mandate, input.profile)),
      `• looks at the market ${intervalLabel(intervalMinutes).toLowerCase()} using ${strategies.map((kind) => STRATEGIES[kind].label).join(", ") || "your instructions"}${instructions ? ` ("${instructions.slice(0, 140)}")` : ""}`,
      `• uses the ${input.modelMode} model mode, at most ${input.creditsPerCycle} credits per cycle and ${input.creditsPerMonth} per month`,
      `• sends its notices to this chat`,
    ];
    if (blocked.length) {
      lines.push(
        "",
        input.lowerMinimums
          ? `Market minimums were lowered so ${blocked.map((asset) => asset.symbol).join(", ")} can trade.`
          : `Note: ${blocked.map((asset) => asset.symbol).join(", ")} will not be traded with this profile's minimum liquidity, market cap or token age. Ask to lower the minimums if you want them traded.`,
      );
    }
    lines.push("", "This agent trades real funds from its wallet. Losses are real and trades on the chain cannot be undone. The limits cap what it can lose; they do not prevent loss.");
    return { title: `Create trading agent "${input.name}"`, description: lines.join("\n"), args: input, confirmLabel: "Approve and start trading" };
  },
  async run(args, context) {
    const input = args as unknown as ReturnType<typeof CreateAgentArgs.parse> & { walletId: string; assets: AssetOption[]; strategies: StrategyKind[]; instructions: string; intervalMinutes: number; lowerMinimums: boolean; creditsPerCycle: number; creditsPerMonth: number };
    const connectionId = await chatConnectionId(context.user.id, context.chat.chatId);
    try {
      const { id, mandate } = await createAgentFromProfile({
        userId: context.user.id,
        name: input.name,
        walletId: input.walletId,
        allocationUsd: input.allocationUsd,
        profile: input.profile as Profile,
        assets: input.assets,
        strategies: input.strategies,
        instructions: input.instructions,
        intervalMinutes: input.intervalMinutes,
        modelMode: (input.modelMode ?? "auto") as "auto" | "economy" | "quality",
        maxPerRunCredits: input.creditsPerCycle,
        maxPerMonthCredits: input.creditsPerMonth,
        connectionIds: connectionId ? [connectionId] : [],
        timezone: context.chat.timezone,
        lowerMinimums: input.lowerMinimums,
        source: "telegram",
      });
      return `"${input.name}" is approved and running. The first cycle starts within a minute. It may trade ${mandate.allowedAssets.map((asset) => asset.symbol).join(", ")} with up to ${usd(mandate.agentAllocationUsd)}.\nPage: ${WEB}/app/trading/${id}\nSay "pause ${input.name}" at any time.`;
    } catch (error) {
      throw new ToolError(error instanceof CreateAgentError ? error.message : "The agent could not be created.");
    }
  },
});

// ── Automations ─────────────────────────────────────────────────────────────

async function findAutomation(userId: string, query: string) {
  const rows = await db.select().from(automations).where(eq(automations.userId, userId)).orderBy(desc(automations.createdAt));
  if (rows.length === 0) throw new ToolError("The user has no automations yet.");
  const wanted = query.trim().toLowerCase();
  const match = rows.find((row) => row.id === wanted) ?? rows.find((row) => row.name.toLowerCase() === wanted) ?? rows.find((row) => row.name.toLowerCase().includes(wanted));
  if (!match) throw new ToolError(`No automation matches "${query}". The user's automations: ${rows.map((row) => row.name).join(", ")}.`);
  return match;
}

const automationsList = define({
  name: "automations.list",
  summary: "The user's automations with their trigger, schedule, state and last run.",
  argsHint: "{}",
  schema: z.object({}),
  effect: "read",
  async run(_args, context) {
    const rows = await db.select().from(automations).where(eq(automations.userId, context.user.id)).orderBy(desc(automations.createdAt));
    if (rows.length === 0) return "No automations yet.";
    return bullet(
      rows.map((row) => {
        const trigger = row.triggerType === "schedule" ? describeCron(row.cron ?? "") : row.triggerType === "webhook" ? "on a webhook" : "manual";
        return `${row.name}: ${trigger}${row.enabled ? "" : " (paused)"}, last run ${timeAgo(row.lastRunAt)}, next ${row.nextRunAt ? timeAgo(row.nextRunAt) : "none"}, budget ${formatCredits(row.maxPerRunMicro)} per run. ${WEB}/app/automations/${row.id}`;
      }),
    );
  },
});

const CreateAutomationArgs = z.object({
  name: z.string().min(1).max(80),
  instruction: z.string().min(10).max(4000),
  cron: z.string().max(100).optional(),
  connections: z.array(z.enum(["gmail", "slack", "discord", "github", "http"])).max(5).optional(),
  requireApproval: z.boolean().optional(),
  modelMode: z.enum(["auto", "economy", "quality"]).optional(),
  creditsPerRun: z.coerce.number().min(0.1).max(1000).optional(),
});

const automationsCreate = define({
  name: "automations.create",
  summary:
    "Create an automation: a job the agent runs on a schedule (five-field cron in the user's timezone) or when the user asks. The job can read the web, use the user's connected apps and message this chat. Write the instruction as a brief to a person: where to look, what to decide, what to send, when to do nothing. Needs confirmation.",
  argsHint: '{"name": string, "instruction": string, "cron"?: string (omit for a manual job), "connections"?: ("gmail"|"slack"|"discord"|"github"|"http")[], "requireApproval"?: boolean (default true: sends and changes wait for a button), "modelMode"?: "auto"|"economy"|"quality", "creditsPerRun"?: number}',
  schema: CreateAutomationArgs,
  effect: "write",
  async prepare(args, context) {
    const timezone = context.chat.timezone;
    const cron = args.cron?.trim();
    if (cron) {
      const problem = validateCron(cron, timezone);
      if (problem) throw new ToolError(`Schedule problem: ${problem}`);
    }
    const kinds = [...new Set(args.connections ?? [])];
    const linked = await connectionsOfKinds(context.user.id, kinds);
    const missing = kinds.filter((kind) => !linked.some((connection) => connection.kind === kind));
    if (missing.length) throw new ToolError(`The user has no ${missing.join(", ")} connection. They can add one at ${WEB}/app/connections.`);
    const telegram = await chatConnectionId(context.user.id, context.chat.chatId);
    const connectionIds = [...new Set([...(telegram ? [telegram] : []), ...kinds.map((kind) => linked.find((connection) => connection.kind === kind)!.id)])];
    const requireApproval = args.requireApproval ?? true;
    const creditsPerRun = args.creditsPerRun ?? 10;
    const description = [
      `Create automation "${args.name}"?`,
      `Runs: ${cron ? `${describeCron(cron)} (${timezone})` : "only when you ask"}.`,
      `Job: ${args.instruction}`,
      `Can use: this Telegram chat${kinds.length ? `, ${kinds.join(", ")}` : ""}; reads the web.`,
      `Budget: ${creditsPerRun} credits per run, ${Math.max(creditsPerRun * 30, 300)} per month. Model mode: ${args.modelMode ?? "auto"}.`,
      requireApproval ? "Anything it sends or changes will wait for your approval here first." : "It acts without asking.",
    ].join("\n");
    return {
      title: `Create automation "${args.name}"`,
      description,
      args: { ...args, cron: cron || null, connectionIds, requireApproval, creditsPerRun, timezone },
    };
  },
  async run(args, context) {
    const input = args as { name: string; instruction: string; cron: string | null; connectionIds: string[]; requireApproval: boolean; creditsPerRun: number; timezone: string; modelMode?: "auto" | "economy" | "quality" };
    const maxPerRunMicro = toMicro(input.creditsPerRun);
    const [created] = await db
      .insert(automations)
      .values({
        userId: context.user.id,
        name: input.name,
        instruction: input.instruction,
        triggerType: input.cron ? "schedule" : "manual",
        cron: input.cron,
        timezone: input.timezone,
        webhookToken: randomToken(24),
        connectionIds: input.connectionIds,
        modelMode: input.modelMode ?? "auto",
        maxPerRunMicro,
        maxPerMonthMicro: maxPerRunMicro * 30n > 300n * MICRO ? maxPerRunMicro * 30n : 300n * MICRO,
        requireApproval: input.requireApproval,
        enabled: true,
        nextRunAt: input.cron ? nextRun(input.cron, input.timezone) : null,
      })
      .returning({ id: automations.id, nextRunAt: automations.nextRunAt });
    return `Automation "${input.name}" created.${created!.nextRunAt ? ` First run ${timeAgo(created!.nextRunAt)}.` : " Say \"run it\" whenever you want it to run."}\nPage: ${WEB}/app/automations/${created!.id}`;
  },
});

const automationsRun = define({
  name: "automations.run",
  summary: "Run one of the user's automations now. Needs confirmation.",
  argsHint: '{"automation": string (name or id)}',
  schema: z.object({ automation: z.string().min(1).max(120) }),
  effect: "write",
  async prepare(args, context) {
    const automation = await findAutomation(context.user.id, args.automation);
    return { title: `Run "${automation.name}"`, description: `Run "${automation.name}" now? It may spend up to ${formatCredits(automation.maxPerRunMicro)} credits.`, args: { id: automation.id } };
  },
  async run(args, context) {
    const id = String((args as unknown as { id: string }).id);
    const [automation] = await db.select().from(automations).where(and(eq(automations.id, id), eq(automations.userId, context.user.id)));
    if (!automation) throw new ToolError("That automation no longer exists.");
    const run = await createRun(automation, "manual");
    if (!run.runnable) return `"${automation.name}" has reached its monthly credit cap, so the run was not started.`;
    void executeRun(run.id);
    return `"${automation.name}" is running. ${automation.requireApproval ? "If it wants to send or change anything, you will get a button here." : ""} Result: ${WEB}/app/runs/${run.id}`;
  },
});

const automationsSetEnabled = define({
  name: "automations.set_enabled",
  summary: "Pause or resume an automation's schedule. Needs confirmation.",
  argsHint: '{"automation": string, "enabled": boolean}',
  schema: z.object({ automation: z.string().min(1).max(120), enabled: z.boolean() }),
  effect: "write",
  async prepare(args, context) {
    const automation = await findAutomation(context.user.id, args.automation);
    return {
      title: `${args.enabled ? "Resume" : "Pause"} "${automation.name}"`,
      description: args.enabled ? `Turn "${automation.name}" back on? Its schedule resumes.` : `Pause "${automation.name}"? It will not run on its schedule until you turn it on again.`,
      args: { id: automation.id, enabled: args.enabled },
    };
  },
  async run(args, context) {
    const { id, enabled } = args as unknown as { id: string; enabled: boolean };
    const [automation] = await db.select().from(automations).where(and(eq(automations.id, String(id)), eq(automations.userId, context.user.id)));
    if (!automation) throw new ToolError("That automation no longer exists.");
    await db
      .update(automations)
      .set({ enabled, nextRunAt: enabled && automation.triggerType === "schedule" && automation.cron ? nextRun(automation.cron, automation.timezone) : null, updatedAt: new Date() })
      .where(eq(automations.id, automation.id));
    return `"${automation.name}" is ${enabled ? "on" : "paused"}.`;
  },
});

// ── Settings ────────────────────────────────────────────────────────────────

export const SettingsArgs = z.object({
  briefHour: z.number().int().min(0).max(23).nullable().optional(),
  timezone: z.string().max(64).optional(),
  creditsPerMessage: z.coerce.number().min(0.1).max(100).optional(),
  creditsPerDay: z.coerce.number().min(1).max(5000).optional(),
  modelMode: z.enum(["auto", "economy", "quality", "pinned"]).optional(),
  modelId: z.string().max(200).optional(),
  lowBalanceCredits: z.coerce.number().min(0).max(1_000_000).optional(),
});

export async function applySettings(chat: BotChat, args: z.infer<typeof SettingsArgs>): Promise<string[]> {
  const patch: Record<string, unknown> = {};
  const changes: string[] = [];
  if (args.timezone !== undefined) {
    if (!isValidTimezone(args.timezone)) throw new ToolError(`"${args.timezone}" is not a timezone. Use an IANA name such as Asia/Kolkata or Europe/Berlin.`);
    patch.timezone = args.timezone;
    changes.push(`timezone ${args.timezone}`);
  }
  if (args.briefHour !== undefined) {
    patch.briefHour = args.briefHour;
    changes.push(args.briefHour === null ? "daily brief off" : `daily brief at ${String(args.briefHour).padStart(2, "0")}:00`);
  }
  if (args.creditsPerMessage !== undefined) {
    patch.maxPerMessageMicro = toMicro(args.creditsPerMessage);
    changes.push(`${args.creditsPerMessage} credits per message`);
  }
  if (args.creditsPerDay !== undefined) {
    patch.maxPerDayMicro = toMicro(args.creditsPerDay);
    changes.push(`${args.creditsPerDay} credits per day`);
  }
  if (args.lowBalanceCredits !== undefined) {
    patch.lowBalanceMicro = toMicro(args.lowBalanceCredits);
    changes.push(`low-balance alert below ${args.lowBalanceCredits} credits`);
  }
  if (args.modelMode !== undefined || args.modelId !== undefined) {
    if (args.modelId || args.modelMode === "pinned") {
      const models = usableTextModels(await listModels().catch(() => []));
      const model = models.find((candidate) => candidate.id === args.modelId);
      if (!model) throw new ToolError(`"${args.modelId ?? ""}" is not an available model id. Use models.list to see ids.`);
      patch.modelMode = "pinned";
      patch.modelId = model.id;
      changes.push(`model ${model.id}`);
    } else {
      patch.modelMode = args.modelMode;
      patch.modelId = null;
      changes.push(`model mode ${args.modelMode}`);
    }
  }
  if (changes.length === 0) throw new ToolError("Nothing to change.");
  await updateChat(chat.chatId, patch);
  return changes;
}

const botSettings = define({
  name: "bot.settings",
  summary:
    "Change this chat's settings: the hour of the daily brief (null for none), the timezone, credit limits per message and per day, the model mode or a pinned model id, the low-balance alert threshold.",
  argsHint: '{"briefHour"?: 0-23|null, "timezone"?: string, "creditsPerMessage"?: number, "creditsPerDay"?: number, "modelMode"?: "auto"|"economy"|"quality", "modelId"?: string, "lowBalanceCredits"?: number}',
  schema: SettingsArgs,
  effect: "internal",
  async run(args, context) {
    const changes = await applySettings(context.chat, args);
    return `Settings updated: ${changes.join(", ")}.`;
  },
});

// ── Registry ────────────────────────────────────────────────────────────────

export const BOT_TOOLS: BotToolDef[] = [
  webFetch,
  memorySave,
  accountBalance,
  modelsList,
  tradingOverview,
  tradingAgent,
  tradingAssets,
  tradingPause,
  tradingResume,
  tradingCloseAll,
  tradingRevoke,
  tradingRunNow,
  tradingCreateWallet,
  tradingCreateAgent,
  automationsList,
  automationsCreate,
  automationsRun,
  automationsSetEnabled,
  botSettings,
];

export const toolByName = new Map(BOT_TOOLS.map((tool) => [tool.name, tool]));

