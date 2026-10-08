import type { ChatCompletion } from "accred";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TEST_APP_SECRET } from "@lib/trading/test-helpers";

/**
 * The Telegram agent against a real Postgres, with Telegram, Accred and the
 * model replaced by stand-ins. Opt-in, like the trading tests:
 *   TRADING_TEST_DATABASE_URL=postgres://localhost:5432/accred_automation_trading pnpm vitest run src/lib/bot/bot-db.test.ts
 */
const url = process.env.TRADING_TEST_DATABASE_URL;

vi.mock("@lib/accred", async (importOriginal) => {
  const original = await importOriginal<typeof import("@lib/accred")>();
  const { FAKE_MODEL } = await import("@lib/trading/test-helpers");
  return {
    ...original,
    checkApiKey: async () => "valid" as const,
    listModels: async () => [FAKE_MODEL],
    fetchBalance: async () => ({ status: "ok" as const, exact: "1200.5" }),
    // Only reached by an automation run that continues after an approval; it answers at once.
    accredFor: () => ({ chat: { create: async () => completion('{"thought": "done", "final": "Finished."}') } }),
  };
});

vi.mock("@lib/telegram", async (importOriginal) => {
  const original = await importOriginal<typeof import("@lib/telegram")>();
  return { ...original, saveSharedChat: async () => "created" as const, getBotUsername: async () => "AccredTestBot" };
});

function completion(content: string): ChatCompletion {
  return {
    content,
    creditsChargedExact: "0.05",
    remainingCreditsExact: "1000",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as unknown as ChatCompletion;
}

interface Sent {
  chatId: string;
  text: string;
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
}

function fakeApi() {
  const sent: Sent[] = [];
  const deleted: string[] = [];
  let nextId = 100;
  return {
    sent,
    deleted,
    api: {
      async sendMessage(chatId: string | number, text: string, options: { buttons?: Sent["buttons"] } = {}) {
        sent.push({ chatId: String(chatId), text, buttons: options.buttons });
        return nextId++;
      },
      async editButtons() {},
      async deleteMessage(chatId: string | number, messageId: number) {
        deleted.push(`${chatId}:${messageId}`);
        return true;
      },
      async answerCallback() {},
      async typing() {},
    },
  };
}

describe.skipIf(!url)("telegram agent against the database", () => {
  let app: typeof import("@lib/db") & typeof import("./router") & typeof import("./agent") & typeof import("./store") & typeof import("./heartbeat") & { eq: typeof import("drizzle-orm").eq; and: typeof import("drizzle-orm").and };
  const chatIds: string[] = [];
  const userIds = new Set<string>();

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.APP_SECRET ??= TEST_APP_SECRET;
    vi.setConfig({ testTimeout: 30_000 });
    const orm = await import("drizzle-orm");
    app = { ...(await import("@lib/db")), ...(await import("./router")), ...(await import("./agent")), ...(await import("./store")), ...(await import("./heartbeat")), eq: orm.eq, and: orm.and };
  });

  afterEach(async () => {
    for (const chatId of chatIds.splice(0)) await app.db.delete(app.botChats).where(app.eq(app.botChats.chatId, chatId));
    for (const userId of [...userIds]) await app.db.delete(app.users).where(app.eq(app.users.id, userId));
    userIds.clear();
  });

  const newChatId = () => {
    const id = String(900_000_000 + Math.floor(Math.random() * 1_000_000));
    chatIds.push(id);
    return id;
  };

  const deps = (replies: string[], api: ReturnType<typeof fakeApi>["api"]) => {
    const queue = [...replies];
    return {
      api,
      catalog: async () => [(await import("@lib/trading/test-helpers")).FAKE_MODEL],
      complete: async () => completion(queue.length > 1 ? queue.shift()! : queue[0]!),
      now: () => Date.now(),
    };
  };

  /** A linked chat with a fresh account. */
  const linkedChat = async () => {
    const chatId = newChatId();
    const { api, sent, deleted } = fakeApi();
    const key = `ct_live_${"k".repeat(20)}${chatId}`;
    await app.handleBotUpdate({ update_id: 1, message: { message_id: 7, text: key, chat: { id: Number(chatId), type: "private" } } }, deps([], api));
    const chat = (await app.getChat(chatId))!;
    userIds.add(chat.userId!);
    return { chatId, chat, api, sent, deleted, key };
  };

  it("links a chat from a pasted key, deletes the message and welcomes the user", async () => {
    const { chat, sent, deleted, chatId, key } = await linkedChat();
    expect(chat.state).toBe("linked");
    expect(deleted).toEqual([`${chatId}:7`]);
    const [user] = await app.db.select().from(app.users).where(app.eq(app.users.id, chat.userId!));
    expect(user?.keyHint).toBe(key.slice(-4));
    expect(sent[0]?.text).toContain("Connected to your Accred account");
    expect(sent[0]?.text).toContain("1,200.50 credits");
  });

  it("asks for a key first and ignores chatter until one arrives", async () => {
    const chatId = newChatId();
    const { api, sent } = fakeApi();
    await app.handleBotUpdate({ update_id: 1, message: { message_id: 1, text: "hello there", chat: { id: Number(chatId), type: "private" } } }, deps([], api));
    expect(sent[0]?.text).toContain("Paste your Accred API key");
    expect((await app.getChat(chatId))?.state).toBe("awaiting_key");
  });

  it("answers a question after a read tool, records the turn and its credits, and keeps the transcript", async () => {
    const { chatId, api, sent } = await linkedChat();
    sent.length = 0;
    await app.chatTurn(
      chatId,
      "what is my balance?",
      deps(['{"thought": "check", "tool": "account.balance", "args": {}}', '{"thought": "answer", "final": "You have 1,200.50 credits, about $12."}'], api),
    );
    expect(sent.map((message) => message.text)).toEqual(["You have 1,200.50 credits, about $12."]);
    const turns = await app.db.select().from(app.botTurns).where(app.eq(app.botTurns.chatId, chatId));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.creditsMicro).toBe(100_000n);
    expect(turns[0]!.toolCalls).toBe(1);
    expect(turns[0]!.outcome).toBe("answered");
    const chat = (await app.getChat(chatId))!;
    expect(chat.transcript.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("stops before calling the model when the daily cap is spent", async () => {
    const { chatId, chat, api, sent } = await linkedChat();
    sent.length = 0;
    await app.db.insert(app.botTurns).values({ chatId, userId: chat.userId!, creditsMicro: chat.maxPerDayMicro, outcome: "answered" });
    let calls = 0;
    await app.chatTurn(chatId, "hi", { ...deps(['{"final": "never"}'], api), complete: async () => (calls++, completion('{"final": "x"}')) });
    expect(calls).toBe(0);
    expect(sent[0]?.text).toContain("today's limit");
  });

  it("turns a write tool into a confirmation, and the tap creates the automation", async () => {
    const { chatId, chat, api, sent } = await linkedChat();
    sent.length = 0;
    const call = JSON.stringify({ thought: "set it up", tool: "automations.create", args: { name: "Morning news", instruction: "Read https://example.com/feed.xml and send me the three most important items.", cron: "0 8 * * *" } });
    await app.chatTurn(chatId, "every morning at 8 send me the news", deps([call], api));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Create automation "Morning news"?');
    expect(sent[0]!.buttons?.[0]?.map((button) => button.text)).toEqual(["Confirm", "Cancel"]);
    const [action] = await app.pendingActions(chatId);
    expect(action?.tool).toBe("automations.create");
    const before = await app.db.select().from(app.automations).where(app.eq(app.automations.userId, chat.userId!));
    expect(before).toHaveLength(0);

    await app.handleBotUpdate({ update_id: 2, callback_query: { id: "cb1", data: `a:${action!.id}:y`, message: { message_id: 100, chat: { id: Number(chatId), type: "private" } } } }, deps([], api));
    const after = await app.db.select().from(app.automations).where(app.eq(app.automations.userId, chat.userId!));
    expect(after).toHaveLength(1);
    expect(after[0]!.cron).toBe("0 8 * * *");
    expect(after[0]!.triggerType).toBe("schedule");
    expect(after[0]!.requireApproval).toBe(true);
    expect(sent[1]!.text).toContain('Automation "Morning news" created');
    expect((await app.pendingActions(chatId))).toHaveLength(0);

    // Tapping again does nothing more.
    await app.handleBotUpdate({ update_id: 3, callback_query: { id: "cb2", data: `a:${action!.id}:y`, message: { message_id: 100, chat: { id: Number(chatId), type: "private" } } } }, deps([], api));
    expect(await app.db.select().from(app.automations).where(app.eq(app.automations.userId, chat.userId!))).toHaveLength(1);
  });

  it("cancelling a confirmation runs nothing", async () => {
    const { chatId, chat, api, sent } = await linkedChat();
    const call = JSON.stringify({ tool: "trading.create_wallet", args: { name: "Spare" } });
    await app.chatTurn(chatId, "make me a wallet", deps([call], api));
    const [action] = await app.pendingActions(chatId);
    await app.handleBotUpdate({ update_id: 2, callback_query: { id: "cb", data: `a:${action!.id}:n`, message: { message_id: 1, chat: { id: Number(chatId), type: "private" } } } }, deps([], api));
    expect(sent[sent.length - 1]!.text).toContain("Cancelled");
    expect(await app.db.select().from(app.tradingWallets).where(app.eq(app.tradingWallets.userId, chat.userId!))).toHaveLength(0);
  });

  it("tells the chat about a run waiting for approval, and a decline ends the wait", async () => {
    const { chatId, chat, api, sent } = await linkedChat();
    sent.length = 0;
    const [automation] = await app.db
      .insert(app.automations)
      .values({ userId: chat.userId!, name: "Mailer", instruction: "Send a message.", triggerType: "manual", webhookToken: `t-${chatId}`, maxPerRunMicro: 1_000_000n, maxPerMonthMicro: 10_000_000n })
      .returning({ id: app.automations.id });
    const [run] = await app.db
      .insert(app.runs)
      .values({ automationId: automation!.id, userId: chat.userId!, trigger: "manual", status: "waiting_approval", budgetMicro: 1_000_000n })
      .returning({ id: app.runs.id });
    const [step] = await app.db
      .insert(app.runSteps)
      .values({ runId: run!.id, idx: 0, kind: "approval", title: 'Send Telegram message "Hello"', tool: "telegram.send_message", status: "waiting" })
      .returning({ id: app.runSteps.id });
    await app.db
      .update(app.runs)
      .set({ state: { messages: [], toolCalls: 1, modelCalls: 1, formatErrors: 0, downgraded: false, pending: { tool: "telegram.send_message", args: { text: "Hello" }, stepId: step!.id } } })
      .where(app.eq(app.runs.id, run!.id));

    await app.botHeartbeat(api, Date.now() + 10 * 60_000);
    const request = sent.find((message) => message.buttons);
    expect(request?.text).toContain('"Mailer" wants to: Send Telegram message "Hello"');
    expect(request?.buttons?.[0]?.map((button) => button.text)).toEqual(["Approve", "Decline"]);
    expect((await app.getChat(chatId))!.notifiedRunIds).toEqual([run!.id]);

    const [action] = await app.pendingActions(chatId);
    await app.handleBotUpdate({ update_id: 5, callback_query: { id: "cb", data: `a:${action!.id}:n`, message: { message_id: 1, chat: { id: Number(chatId), type: "private" } } } }, deps([], api));
    expect(sent[sent.length - 1]!.text).toContain("Declined");
    const [claimed] = await app.db.select({ status: app.runs.status }).from(app.runs).where(app.eq(app.runs.id, run!.id));
    expect(claimed!.status).not.toBe("waiting_approval");
  });

  it("sends the daily brief once at the chosen hour", async () => {
    const { chatId, api, sent } = await linkedChat();
    sent.length = 0;
    const now = Date.now() + 20 * 60_000;
    const { localHour, localDate } = await import("./format");
    await app.updateChat(chatId, { briefHour: localHour(now, "UTC"), timezone: "UTC" });
    await app.botHeartbeat(api, now);
    expect(sent.map((message) => message.text.split("\n")[0])).toEqual([expect.stringContaining("Good morning")]);
    expect((await app.getChat(chatId))!.lastBriefOn).toBe(localDate(now, "UTC"));
    await app.botHeartbeat(api, now + 2 * 60_000);
    expect(sent).toHaveLength(1);
  });

  it("commands change settings without a model call", async () => {
    const { chatId, api, sent } = await linkedChat();
    sent.length = 0;
    const send = (text: string) => app.handleBotUpdate({ update_id: 9, message: { message_id: 9, text, chat: { id: Number(chatId), type: "private" } } }, deps([], api));
    await send("/brief 7");
    await send("/budget 2 20");
    await send("/timezone Asia/Kolkata");
    const chat = (await app.getChat(chatId))!;
    expect(chat.briefHour).toBe(7);
    expect(chat.maxPerMessageMicro).toBe(2_000_000n);
    expect(chat.maxPerDayMicro).toBe(20_000_000n);
    expect(chat.timezone).toBe("Asia/Kolkata");
    await send("/stop");
    expect(await app.getChat(chatId)).toBeUndefined();
    expect(sent[sent.length - 1]!.text).toContain("unlinked");
  });
});
