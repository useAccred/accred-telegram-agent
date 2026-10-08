import { describe, expect, it } from "vitest";
import { actionButtons } from "./actions";
import { buildBotSystemPrompt } from "./agent";
import { localDate, localHour, looksLikeKey, looksLikePrivateKey, parseCommand, splitMessage } from "./format";
import { trimTranscript } from "./store";
import { BOT_TOOLS } from "./tools";
import { assetsBlockedBy, buildMandate, describeMandate } from "@lib/trading/create";
import type { AssetOption } from "@lib/trading/market-data";

describe("splitMessage", () => {
  it("keeps short text whole", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
    expect(splitMessage("   ")).toEqual(["(empty reply)"]);
  });

  it("breaks long text at paragraph ends under the limit", () => {
    const paragraph = "word ".repeat(100).trim();
    const text = Array.from({ length: 12 }, () => paragraph).join("\n\n");
    const parts = splitMessage(text, 1200);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(1200);
    expect(parts.join("\n\n").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("cuts a single unbroken word at the limit", () => {
    expect(splitMessage("x".repeat(9000), 4000).map((part) => part.length)).toEqual([4000, 4000, 1000]);
  });
});

describe("looksLikeKey", () => {
  it("accepts platform keys and refuses sentences", () => {
    expect(looksLikeKey("ct_live_abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
    expect(looksLikeKey("  ct_test_abcdefghijklmnopqrstuvwxyz123456 ")).toBe(true);
    expect(looksLikeKey("how are my agents doing")).toBe(false);
    expect(looksLikeKey("pause Momentum A")).toBe(false);
    expect(looksLikeKey("https://example.com/some/long/path/with/numbers/1234")).toBe(false);
    expect(looksLikeKey("short")).toBe(false);
  });

  it("never mistakes an address, a hash or a private key for an API key", () => {
    expect(looksLikeKey("0x854Af176109Cf2b377E2f90C25e57F4A67f10cf4")).toBe(false);
    expect(looksLikeKey("854Af176109Cf2b377E2f90C25e57F4A67f10cf4")).toBe(false);
    expect(looksLikeKey(`0x${"ab12".repeat(16)}`)).toBe(false);
    expect(looksLikeKey("1234567890123456789012345678")).toBe(false);
  });
});

describe("looksLikePrivateKey", () => {
  it("spots hex keys and seed phrases", () => {
    expect(looksLikePrivateKey(`0x${"ab12".repeat(16)}`)).toBe(true);
    expect(looksLikePrivateKey("ab12".repeat(16))).toBe(true);
    expect(looksLikePrivateKey("abandon ability able about above absent absorb abstract absurd abuse access accident")).toBe(true);
    expect(looksLikePrivateKey("ct_live_abcdefghijklmnopqrstuvwxyz123456")).toBe(false);
    expect(looksLikePrivateKey("please pause my agent and close every position that is open right now ok")).toBe(false);
    expect(looksLikePrivateKey("0x854Af176109Cf2b377E2f90C25e57F4A67f10cf4")).toBe(false);
  });
});

describe("parseCommand", () => {
  it("reads the command and its argument", () => {
    expect(parseCommand("/brief 8")).toEqual({ command: "brief", arg: "8" });
    expect(parseCommand("/Budget 5 100")).toEqual({ command: "budget", arg: "5 100" });
    expect(parseCommand("/start@AccredBot abc")).toEqual({ command: "start", arg: "abc" });
    expect(parseCommand("/status")).toEqual({ command: "status", arg: "" });
    expect(parseCommand("what is /status")).toBeNull();
    expect(parseCommand("hello")).toBeNull();
  });
});

describe("local time", () => {
  it("reads the date and hour in a timezone", () => {
    const instant = Date.UTC(2026, 9, 8, 2, 30); // 02:30 UTC on 8 Oct 2026
    expect(localDate(instant, "UTC")).toBe("2026-10-08");
    expect(localHour(instant, "UTC")).toBe(2);
    expect(localDate(instant, "Asia/Kolkata")).toBe("2026-10-08");
    expect(localHour(instant, "Asia/Kolkata")).toBe(8);
    expect(localDate(instant, "America/Los_Angeles")).toBe("2026-10-07");
    expect(localHour(instant, "America/Los_Angeles")).toBe(19);
  });
});

describe("trimTranscript", () => {
  it("drops the oldest turns first and keeps the newest", () => {
    const transcript = Array.from({ length: 50 }, (_, index) => ({ role: (index % 2 ? "assistant" : "user") as "user" | "assistant", content: `turn ${index} ${"x".repeat(900)}` }));
    const kept = trimTranscript(transcript, 8000, 30);
    expect(kept.length).toBeLessThanOrEqual(30);
    expect(kept[kept.length - 1]!.content.startsWith("turn 49")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(8000);
  });

  it("keeps a short transcript as it is", () => {
    const transcript = [{ role: "user" as const, content: "hi" }, { role: "assistant" as const, content: "hello" }];
    expect(trimTranscript(transcript)).toEqual(transcript);
  });
});

describe("actionButtons", () => {
  it("carries only the action id", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect(actionButtons(id)).toEqual([[{ text: "Confirm", callback_data: `a:${id}:y` }, { text: "Cancel", callback_data: `a:${id}:n` }]]);
    expect(actionButtons(id, "Approve and start trading")[0]![0]!.text).toBe("Approve and start trading");
  });
});

describe("buildBotSystemPrompt", () => {
  it("lists every tool, marks the ones that need confirmation, and quotes memory as data", () => {
    const prompt = buildBotSystemPrompt({ tools: BOT_TOOLS, memory: "Likes short answers.", account: "Balance: 10 credits.", now: new Date("2026-10-08T08:00:00Z"), timezone: "Asia/Kolkata" });
    for (const tool of BOT_TOOLS) expect(prompt).toContain(`- ${tool.name}`);
    expect(prompt).toContain("trading.close_all [needs the user's confirmation]");
    expect(prompt).not.toContain("trading.overview [needs");
    expect(prompt).toContain("<memory>\nLikes short answers.\n</memory>");
    expect(prompt).toContain("Asia/Kolkata");
  });

  it("every write tool has a prepare step and every read tool does not need one", () => {
    for (const tool of BOT_TOOLS) {
      if (tool.effect === "write") expect(typeof tool.prepare).toBe("function");
      else expect(tool.prepare).toBeUndefined();
    }
  });
});

describe("creating an agent from a profile", () => {
  const token = (overrides: Partial<AssetOption> = {}): AssetOption => ({
    address: "0x1111111111111111111111111111111111111111",
    symbol: "TOKEN",
    name: "Token",
    liquidityUsd: 400_000,
    volumeH24: 50_000,
    marketCapUsd: 20_000_000,
    pairCreatedAt: Date.now() - 400 * 3_600_000,
    ...overrides,
  });

  it("builds a live mandate from the profile with the chosen assets", () => {
    const mandate = buildMandate({ allocationUsd: 250, profile: "balanced", assets: [token()], lowerMinimums: false });
    expect(mandate.mode).toBe("live");
    expect(mandate.agentAllocationUsd).toBe(250);
    expect(mandate.maxPositionPercent).toBe(10);
    expect(mandate.maxPositionUsd).toBe(25);
    expect(mandate.allowedAssets).toEqual([{ address: "0x1111111111111111111111111111111111111111", symbol: "TOKEN" }]);
    expect(assetsBlockedBy(mandate, [token()])).toEqual([]);
  });

  it("names assets the profile's minimums would block, and lowers them only when asked", () => {
    const thin = token({ symbol: "THIN", liquidityUsd: 30_000, marketCapUsd: 200_000 });
    const strict = buildMandate({ allocationUsd: 100, profile: "conservative", assets: [thin], lowerMinimums: false });
    expect(assetsBlockedBy(strict, [thin]).map((asset) => asset.symbol)).toEqual(["THIN"]);
    const loosened = buildMandate({ allocationUsd: 100, profile: "conservative", assets: [thin], lowerMinimums: true });
    expect(loosened.minimumLiquidityUsd).toBeLessThanOrEqual(30_000);
    expect(assetsBlockedBy(loosened, [thin])).toEqual([]);
  });

  it("describes the mandate in sentences", () => {
    const mandate = buildMandate({ allocationUsd: 1000, profile: "balanced", assets: [token()], lowerMinimums: false });
    const lines = describeMandate(mandate, "balanced");
    expect(lines[0]).toContain("$1,000");
    expect(lines.join("\n")).toContain("2% stop loss");
    expect(lines.join("\n")).toContain("may trade: TOKEN");
  });
});
