import { describe, expect, it } from "vitest";
import type { BotWatch } from "@lib/db";
import { toCsv } from "./export";
import { addressedToBot } from "./router";
import { parseWatch, pricesCrossed } from "./watches";

describe("alert parsing", () => {
  it("reads price thresholds in several spellings", () => {
    expect(parseWatch("ETH below 2000")).toEqual({ kind: "price_below", symbol: "ETH", threshold: 2000 });
    expect(parseWatch("btc > 70k")).toEqual({ kind: "price_above", symbol: "BTC", threshold: 70_000 });
    expect(parseWatch("CRED drops to 0.05")).toEqual({ kind: "price_below", symbol: "CRED", threshold: 0.05 });
    expect(parseWatch("$eth above $2,500")).toEqual({ kind: "price_above", symbol: "ETH", threshold: 2500 });
  });
  it("ignores case and chatty phrasing", () => {
    expect(parseWatch("eth below 2000")).toEqual({ kind: "price_below", symbol: "ETH", threshold: 2000 });
    expect(parseWatch("Eth Below 2000")).toEqual({ kind: "price_below", symbol: "ETH", threshold: 2000 });
    expect(parseWatch("alert me when eth goes below 2000")).toEqual({ kind: "price_below", symbol: "ETH", threshold: 2000 });
    expect(parseWatch("tell me if BTC rises above 70k usd")).toEqual({ kind: "price_above", symbol: "BTC", threshold: 70_000 });
    expect(parseWatch("cred falls to 0.05")).toEqual({ kind: "price_below", symbol: "CRED", threshold: 0.05 });
    expect(parseWatch("cred reaches 0.1")).toEqual({ kind: "price_above", symbol: "CRED", threshold: 0.1 });
    expect(parseWatch("when a position is closed")).toEqual({ kind: "position_closed", agent: undefined });
    expect(parseWatch("Run Failed")).toEqual({ kind: "run_failed", agent: undefined });
    expect(parseWatch("agent paused for momentum a")).toEqual({ kind: "agent_paused", agent: "momentum a" });
  });
  it("reads event watches, with an optional agent", () => {
    expect(parseWatch("position closed")).toEqual({ kind: "position_closed", agent: undefined });
    expect(parseWatch("run failed")).toEqual({ kind: "run_failed", agent: undefined });
    expect(parseWatch("agent paused Momentum A")).toEqual({ kind: "agent_paused", agent: "Momentum A" });
  });
  it("rejects what it cannot read", () => {
    expect(parseWatch("tell me stuff")).toBeNull();
    expect(parseWatch("ETH below")).toBeNull();
  });
});

describe("price watches", () => {
  const watch = (over: Partial<BotWatch>): BotWatch =>
    ({ id: "w", chatId: "c", userId: "u", kind: "price_below", assetAddress: "0xabc", assetSymbol: "ETH", thresholdUsd: 2000, agentId: null, status: "active", firedCount: 0, lastFiredAt: null, createdAt: new Date(), ...over }) as BotWatch;
  it("fires below and above, once, only while active", () => {
    const prices = new Map([["0xabc", 1999]]);
    expect(pricesCrossed([watch({})], prices)).toHaveLength(1);
    expect(pricesCrossed([watch({ status: "fired" })], prices)).toHaveLength(0);
    expect(pricesCrossed([watch({ kind: "price_above" })], prices)).toHaveLength(0);
    expect(pricesCrossed([watch({ kind: "price_above", thresholdUsd: 1500 })], prices)).toHaveLength(1);
  });
  it("ignores a missing or broken price", () => {
    expect(pricesCrossed([watch({})], new Map())).toHaveLength(0);
    expect(pricesCrossed([watch({})], new Map([["0xabc", Number.NaN]]))).toHaveLength(0);
  });
});

describe("group addressing", () => {
  it("recognises a mention and strips it", () => {
    expect(addressedToBot({ text: "@AccredAgentbot how are my agents?" }, "AccredAgentbot")).toEqual({ addressed: true, text: "how are my agents?" });
    expect(addressedToBot({ text: "hey @accredagentbot status" }, "AccredAgentbot")).toEqual({ addressed: true, text: "hey status" });
  });
  it("recognises a reply to the bot and a suffixed command", () => {
    expect(addressedToBot({ text: "and then?", reply_to_message: { from: { username: "AccredAgentbot" } } }, "AccredAgentbot").addressed).toBe(true);
    expect(addressedToBot({ text: "/status@AccredAgentbot" }, "AccredAgentbot").addressed).toBe(true);
  });
  it("stays quiet otherwise", () => {
    expect(addressedToBot({ text: "lunch?" }, "AccredAgentbot").addressed).toBe(false);
    expect(addressedToBot({ text: "@AccredAgentbotty hi" }, "AccredAgentbot").addressed).toBe(false);
    expect(addressedToBot({ text: "@AccredAgentbot hi" }, "").addressed).toBe(false);
  });
});

describe("csv", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(toCsv(["a", "b"], [["x,y", 'say "hi"'], ["line\nbreak", null]])).toBe('a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",\r\n');
  });
});
