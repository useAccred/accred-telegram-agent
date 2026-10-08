import { erc20Abi, formatUnits, parseUnits, type Hex } from "viem";
import { audit } from "@lib/trading/audit";
import { EXPLORER_URL, USDG, publicClient } from "@lib/trading/chain";
import { fmtPrice, fmtUsd, signedUsd } from "@lib/trading/format";
import { createLiveVenue, type Fill, type LiveQuote, type LiveVenue } from "@lib/trading/live-venue";
import { fetchSnapshots, type MarketSnapshot } from "@lib/trading/market-data";
import { MIN_GAS_WEI } from "@lib/trading/engine";
import { bullet } from "./format";

/**
 * $CRED, the Accred ecosystem token on Robinhood Chain. Two things the chat
 * can do with it: read its market live (price and depth from the price
 * providers, supply and burn from the chain itself), and buy it with USDG from
 * the user's trading wallet through the same route, simulation, exact approval
 * and pinned router that trading agents use. The buy is never automatic: it is
 * quoted, shown, and only a Confirm tap sends it.
 */

export const CRED = { address: "0xaab950f473370aae2fe3a469a8099e9bd2f4ef26", symbol: "CRED", name: "Accred", decimals: 18 } as const;
export const DEAD = "0x000000000000000000000000000000000000dead" as const;
export const TOTAL_SUPPLY = 1_000_000_000;

export interface CredSupply {
  total: number;
  burned: number;
  /** Total minus what sits at the dead address. */
  net: number;
}

export interface CredDeps {
  snapshot(): Promise<MarketSnapshot | undefined>;
  supply(): Promise<CredSupply>;
  venue(): LiveVenue;
  balance(address: string): Promise<number>;
  now(): number;
}

/** CRED held by an address, in whole tokens. */
export async function credBalance(address: string): Promise<number> {
  const raw = await publicClient().readContract({ address: CRED.address, abi: erc20Abi, functionName: "balanceOf", args: [address as Hex] });
  return Number(formatUnits(raw, CRED.decimals));
}

async function readSupply(): Promise<CredSupply> {
  const client = publicClient();
  const [totalRaw, burnedRaw] = await Promise.all([
    client.readContract({ address: CRED.address, abi: erc20Abi, functionName: "totalSupply" }),
    client.readContract({ address: CRED.address, abi: erc20Abi, functionName: "balanceOf", args: [DEAD] }),
  ]);
  const total = Number(formatUnits(totalRaw, CRED.decimals));
  const burned = Number(formatUnits(burnedRaw, CRED.decimals));
  return { total, burned, net: total - burned };
}

let sharedVenue: LiveVenue | undefined;

export const defaultCredDeps: CredDeps = {
  snapshot: async () => (await fetchSnapshots([CRED.address], { fresh: true })).get(CRED.address),
  supply: readSupply,
  venue: () => (sharedVenue ??= createLiveVenue()),
  balance: credBalance,
  now: () => Date.now(),
};

const tokens = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 0 });
const pct = (value: number | null) => (value === null || !Number.isFinite(value) ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`);

export interface CredMarket {
  priceUsd: number;
  marketCapUsd: number;
  fullyDilutedUsd: number;
  supply: CredSupply;
  snapshot: MarketSnapshot;
  text: string;
}

/** The $CRED market right now. Throws when neither the price nor the chain can be read. */
export async function credMarket(deps: CredDeps = defaultCredDeps): Promise<CredMarket> {
  const [snapshot, supply] = await Promise.all([deps.snapshot(), deps.supply()]);
  if (!snapshot) throw new Error("No price for $CRED could be read from the market data providers right now.");
  const priceUsd = snapshot.priceUsd;
  const marketCapUsd = priceUsd * supply.net;
  const fullyDilutedUsd = priceUsd * supply.total;
  const age = Math.max(0, Math.round((deps.now() - snapshot.fetchedAt) / 1000));
  const text = [
    `$CRED (Accred) on Robinhood Chain, live ${age < 5 ? "just now" : `${age}s ago`}:`,
    bullet([
      `Price ${fmtPrice(priceUsd)}`,
      `Market cap ${fmtUsd(marketCapUsd)} (price × supply net of burned tokens, ${tokens(supply.net)} CRED)`,
      `Fully diluted ${fmtUsd(fullyDilutedUsd)} (${tokens(supply.total)} CRED total supply)`,
      `Burned ${tokens(supply.burned)} CRED (${((supply.burned / supply.total) * 100).toFixed(2)}% of supply, read from the dead address on the chain)`,
      `Liquidity ${fmtUsd(snapshot.liquidityUsd)} in the deepest pool (${snapshot.dex}), 24h volume ${fmtUsd(snapshot.volumeH24 ?? 0)}`,
      `Change 1h ${pct(snapshot.priceChangeH1)}, 6h ${pct(snapshot.priceChangeH6)}, 24h ${pct(snapshot.priceChangeH24)}`,
      `Source ${snapshot.source}; contract ${EXPLORER_URL}/token/${CRED.address}`,
    ]),
  ].join("\n");
  return { priceUsd, marketCapUsd, fullyDilutedUsd, supply, snapshot, text };
}

export class CredBuyError extends Error {}

export interface CredQuote {
  quote: LiveQuote;
  usdg: number;
  expectedCred: number;
  minCred: number;
  impliedPriceUsd: number;
  walletUsdg: number;
  text: string;
}

/** Quotes and simulates a USDG → CRED swap from a wallet. Throws when it cannot be done as asked. */
export async function quoteCredBuy(input: { walletAddress: string; usdg: number; slippagePercent: number }, deps: CredDeps = defaultCredDeps): Promise<CredQuote> {
  if (!(input.usdg >= 1)) throw new CredBuyError("Buy at least 1 USDG worth.");
  if (!(input.slippagePercent >= 0.1 && input.slippagePercent <= 5)) throw new CredBuyError("Slippage must be between 0.1% and 5%.");
  const venue = deps.venue();
  const funds = await venue.funds(input.walletAddress);
  if (!funds) throw new CredBuyError("The wallet's balance could not be read from the chain right now.");
  if (funds.usdg < input.usdg) throw new CredBuyError(`The wallet holds ${funds.usdg.toFixed(2)} USDG, less than the ${input.usdg} USDG asked for. Deposit USDG first.`);
  if (funds.ethWei < MIN_GAS_WEI) throw new CredBuyError("The wallet needs a little ETH for network fees (about $0.50 worth). Send some ETH to it on Robinhood Chain first.");
  const snapshot = await deps.snapshot();
  const quote = await venue.quote({
    side: "buy",
    wallet: input.walletAddress,
    token: CRED.address,
    amountInRaw: parseUnits(input.usdg.toFixed(USDG.decimals), USDG.decimals),
    slippagePercent: input.slippagePercent,
    market: snapshot ?? null,
    now: deps.now(),
  });
  if (!quote.simulation.ok) throw new CredBuyError(`The swap could not be simulated: ${quote.simulation.detail}`);
  const expectedCred = quote.quantity;
  const minCred = Number(formatUnits(BigInt(quote.minOutRaw), CRED.decimals));
  const impliedPriceUsd = expectedCred > 0 ? input.usdg / expectedCred : NaN;
  const text = [
    `Buy $CRED with ${input.usdg.toFixed(2)} USDG from the wallet ${input.walletAddress}?`,
    bullet([
      `You receive about ${tokens(expectedCred)} CRED (simulated on the chain), at least ${tokens(minCred)} with the ${input.slippagePercent}% slippage limit`,
      `Implied price ${fmtPrice(impliedPriceUsd)}${snapshot ? `, market ${fmtPrice(snapshot.priceUsd)} (impact ${quote.priceImpactPercent.toFixed(2)}%)` : ""}`,
      `Network fee about ${fmtUsd(quote.networkFeeUsd)} in ETH, paid by the wallet`,
      `Wallet holds ${funds.usdg.toFixed(2)} USDG now`,
    ]),
    "The swap goes through the pinned router with an approval for exactly this amount. It cannot be undone once sent.",
  ].join("\n");
  return { quote, usdg: input.usdg, expectedCred, minCred, impliedPriceUsd, walletUsdg: funds.usdg, text };
}

/** Executes a fresh quote. Records the hash the moment it is signed, so nothing is ever lost track of. */
export async function executeCredBuy(input: { userId: string; walletId: string; walletAddress: string; usdg: number; slippagePercent: number }, deps: CredDeps = defaultCredDeps): Promise<string> {
  const fresh = await quoteCredBuy(input, deps);
  const venue = deps.venue();
  const fill: Fill = await venue.execute({
    walletId: input.walletId,
    quote: fresh.quote,
    onSigned: async (hash: Hex, nonce: number) => {
      await audit({ userId: input.userId, walletId: input.walletId, type: "wallet.swap_signed", actor: "user", summary: `Signed a swap of ${input.usdg} USDG for CRED`, data: { hash, nonce, usdg: input.usdg, token: CRED.address, via: "telegram" } });
    },
  });
  if (!fill.ok) {
    await audit({ userId: input.userId, walletId: input.walletId, type: "wallet.swap_failed", actor: "user", summary: `Swap of ${input.usdg} USDG for CRED failed at ${fill.stage}: ${fill.reason}`, data: { ...fill, via: "telegram" } });
    if (fill.uncertain && fill.txHash) {
      return `The swap was sent but the chain has not confirmed it yet: ${EXPLORER_URL}/tx/${fill.txHash}. Check that link in a minute; nothing will be sent twice.`;
    }
    throw new CredBuyError(`The swap did not go through (${fill.stage}): ${fill.reason}${fill.gasUsd > 0 ? ` About ${fmtUsd(fill.gasUsd)} of network fee was spent.` : ""}`);
  }
  const received = Number(formatUnits(fill.outRaw, CRED.decimals));
  const spent = Number(formatUnits(fill.inRaw, USDG.decimals));
  await audit({
    userId: input.userId,
    walletId: input.walletId,
    type: "wallet.swap_filled",
    actor: "user",
    summary: `Bought ${tokens(received)} CRED for ${spent.toFixed(2)} USDG`,
    data: { txHash: fill.txHash, approveTxHash: fill.approveTxHash, usdg: spent, cred: received, gasUsd: fill.gasUsd, via: "telegram" },
  });
  return [
    `Done. Bought ${tokens(received)} CRED for ${spent.toFixed(2)} USDG (${fmtPrice(spent / received)} each), network fee ${fmtUsd(fill.gasUsd)}.`,
    `Transaction: ${EXPLORER_URL}/tx/${fill.txHash}`,
    `The CRED sits in the trading wallet ${input.walletAddress}. Holding 100,000 CRED unlocks the Accred mobile app; paying for credits with CRED earns a 10% bonus and burns the CRED paid.`,
  ].join("\n");
}

export interface CredSellQuote {
  quote: LiveQuote;
  cred: number;
  expectedUsdg: number;
  minUsdg: number;
  impliedPriceUsd: number;
  walletCred: number;
  text: string;
}

/** Quotes and simulates a CRED → USDG swap. `cred` may be "all" for the whole balance. */
export async function quoteCredSell(input: { walletAddress: string; cred: number | "all"; slippagePercent: number }, deps: CredDeps = defaultCredDeps): Promise<CredSellQuote> {
  if (!(input.slippagePercent >= 0.1 && input.slippagePercent <= 5)) throw new CredBuyError("Slippage must be between 0.1% and 5%.");
  const held = await deps.balance(input.walletAddress);
  const cred = input.cred === "all" ? held : input.cred;
  if (!(cred > 0)) throw new CredBuyError("Say how much CRED to sell.");
  if (held <= 0) throw new CredBuyError("The wallet holds no CRED.");
  if (cred > held) throw new CredBuyError(`The wallet holds ${tokens(held)} CRED, less than the ${tokens(cred)} asked for.`);
  const venue = deps.venue();
  const funds = await venue.funds(input.walletAddress);
  if (!funds) throw new CredBuyError("The wallet's balance could not be read from the chain right now.");
  if (funds.ethWei < MIN_GAS_WEI) throw new CredBuyError("The wallet needs a little ETH for network fees (about $0.50 worth). Send some ETH to it on Robinhood Chain first.");
  const snapshot = await deps.snapshot();
  const quote = await venue.quote({
    side: "sell",
    wallet: input.walletAddress,
    token: CRED.address,
    amountInRaw: parseUnits(cred.toFixed(CRED.decimals), CRED.decimals),
    slippagePercent: input.slippagePercent,
    market: snapshot ?? null,
    now: deps.now(),
  });
  if (!quote.simulation.ok) throw new CredBuyError(`The swap could not be simulated: ${quote.simulation.detail}`);
  const expectedUsdg = quote.notionalUsd;
  const minUsdg = Number(formatUnits(BigInt(quote.minOutRaw), USDG.decimals));
  const impliedPriceUsd = cred > 0 ? expectedUsdg / cred : NaN;
  const text = [
    `Sell ${tokens(cred)} CRED${input.cred === "all" ? " (everything)" : ""} from the wallet ${input.walletAddress}?`,
    bullet([
      `You receive about ${expectedUsdg.toFixed(2)} USDG (simulated on the chain), at least ${minUsdg.toFixed(2)} with the ${input.slippagePercent}% slippage limit`,
      `Implied price ${fmtPrice(impliedPriceUsd)}${snapshot ? `, market ${fmtPrice(snapshot.priceUsd)} (impact ${quote.priceImpactPercent.toFixed(2)}%)` : ""}`,
      `Network fee about ${fmtUsd(quote.networkFeeUsd)} in ETH, paid by the wallet`,
      `Wallet holds ${tokens(held)} CRED now`,
    ]),
    "The swap goes through the pinned router with an approval for exactly this amount. It cannot be undone once sent.",
  ].join("\n");
  return { quote, cred, expectedUsdg, minUsdg, impliedPriceUsd, walletCred: held, text };
}

export async function executeCredSell(input: { userId: string; walletId: string; walletAddress: string; cred: number | "all"; slippagePercent: number }, deps: CredDeps = defaultCredDeps): Promise<string> {
  const fresh = await quoteCredSell(input, deps);
  const venue = deps.venue();
  const fill: Fill = await venue.execute({
    walletId: input.walletId,
    quote: fresh.quote,
    onSigned: async (hash: Hex, nonce: number) => {
      await audit({ userId: input.userId, walletId: input.walletId, type: "wallet.swap_signed", actor: "user", summary: `Signed a swap of ${tokens(fresh.cred)} CRED for USDG`, data: { hash, nonce, cred: fresh.cred, token: CRED.address, via: "telegram" } });
    },
  });
  if (!fill.ok) {
    await audit({ userId: input.userId, walletId: input.walletId, type: "wallet.swap_failed", actor: "user", summary: `Swap of ${tokens(fresh.cred)} CRED for USDG failed at ${fill.stage}: ${fill.reason}`, data: { ...fill, via: "telegram" } });
    if (fill.uncertain && fill.txHash) return `The swap was sent but the chain has not confirmed it yet: ${EXPLORER_URL}/tx/${fill.txHash}. Check that link in a minute; nothing will be sent twice.`;
    throw new CredBuyError(`The swap did not go through (${fill.stage}): ${fill.reason}${fill.gasUsd > 0 ? ` About ${fmtUsd(fill.gasUsd)} of network fee was spent.` : ""}`);
  }
  const sold = Number(formatUnits(fill.inRaw, CRED.decimals));
  const received = Number(formatUnits(fill.outRaw, USDG.decimals));
  await audit({
    userId: input.userId,
    walletId: input.walletId,
    type: "wallet.swap_filled",
    actor: "user",
    summary: `Sold ${tokens(sold)} CRED for ${received.toFixed(2)} USDG`,
    data: { txHash: fill.txHash, approveTxHash: fill.approveTxHash, usdg: received, cred: sold, gasUsd: fill.gasUsd, via: "telegram" },
  });
  return [`Done. Sold ${tokens(sold)} CRED for ${received.toFixed(2)} USDG (${fmtPrice(received / sold)} each), network fee ${fmtUsd(fill.gasUsd)}.`, `Transaction: ${EXPLORER_URL}/tx/${fill.txHash}`].join("\n");
}

export { signedUsd };
