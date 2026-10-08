import { and, count, desc, eq, gte, inArray, lt, sum } from "drizzle-orm";
import { botActions, botChats, botTurns, connections, db, runs, tradingRuns, users, type BotAction, type BotChat, type User } from "@lib/db";
import { dayStart } from "@lib/trading/portfolio";

/** Database access for the Telegram agent: chats, turns and pending actions. */

export const TRANSCRIPT_BYTES = 16_000;
export const TRANSCRIPT_MESSAGES = 30;
export const MEMORY_CHARS = 2_000;
const ACTION_MINUTES = 10;

export type Transcript = BotChat["transcript"];

export async function getChat(chatId: string): Promise<BotChat | undefined> {
  const [chat] = await db.select().from(botChats).where(eq(botChats.chatId, chatId));
  return chat;
}

/** The chat row, created in the awaiting-key state on first contact. */
export async function ensureChat(chatId: string): Promise<BotChat> {
  const existing = await getChat(chatId);
  if (existing) return existing;
  const [created] = await db.insert(botChats).values({ chatId }).onConflictDoNothing().returning();
  return created ?? (await getChat(chatId))!;
}

export async function updateChat(chatId: string, patch: Partial<typeof botChats.$inferInsert>): Promise<void> {
  await db.update(botChats).set({ ...patch, updatedAt: new Date() }).where(eq(botChats.chatId, chatId));
}

export async function linkChat(chatId: string, userId: string): Promise<void> {
  await db
    .insert(botChats)
    .values({ chatId, userId, state: "linked", lastMessageAt: new Date() })
    .onConflictDoUpdate({ target: botChats.chatId, set: { userId, state: "linked", transcript: [], updatedAt: new Date() } });
}

export async function unlinkChat(chatId: string): Promise<void> {
  await db.delete(botChats).where(eq(botChats.chatId, chatId));
}

/** A linked chat with its account. Undefined while the chat is still waiting for a key. */
export async function loadLinkedChat(chatId: string): Promise<{ chat: BotChat; user: User } | undefined> {
  const [row] = await db
    .select({ chat: botChats, user: users })
    .from(botChats)
    .innerJoin(users, eq(users.id, botChats.userId))
    .where(and(eq(botChats.chatId, chatId), eq(botChats.state, "linked")));
  return row;
}

export async function listLinkedChats(): Promise<Array<{ chat: BotChat; user: User }>> {
  return db
    .select({ chat: botChats, user: users })
    .from(botChats)
    .innerJoin(users, eq(users.id, botChats.userId))
    .where(eq(botChats.state, "linked"));
}

/** Keeps the conversation short enough for the request limit and the budget. Oldest turns go first. */
export function trimTranscript(transcript: Transcript, maxBytes = TRANSCRIPT_BYTES, maxMessages = TRANSCRIPT_MESSAGES): Transcript {
  let kept = transcript.slice(-maxMessages);
  const size = () => Buffer.byteLength(JSON.stringify(kept));
  while (kept.length > 2 && size() > maxBytes) kept = kept.slice(1);
  if (size() > maxBytes) kept = kept.map((message) => ({ ...message, content: message.content.slice(0, Math.floor(maxBytes / Math.max(1, kept.length) / 2)) }));
  return kept;
}

export async function saveTranscript(chatId: string, transcript: Transcript): Promise<void> {
  await updateChat(chatId, { transcript: trimTranscript(transcript), lastMessageAt: new Date() });
}

export async function recordTurn(turn: typeof botTurns.$inferInsert): Promise<void> {
  await db.insert(botTurns).values(turn);
}

/** Credits the chat has spent since local midnight. */
export async function creditsToday(chat: Pick<BotChat, "chatId" | "timezone">, now = Date.now()): Promise<bigint> {
  const [row] = await db
    .select({ total: sum(botTurns.creditsMicro) })
    .from(botTurns)
    .where(and(eq(botTurns.chatId, chat.chatId), gte(botTurns.createdAt, new Date(dayStart(now, chat.timezone)))));
  return BigInt(row?.total ?? 0);
}

/** Credits a user spent between two instants, by product. */
export async function creditsBetween(userId: string, from: Date, to: Date): Promise<{ automations: bigint; trading: bigint; chat: bigint; runs: number; cycles: number }> {
  const [[a], [t], [c]] = await Promise.all([
    db
      .select({ total: sum(runs.creditsMicro), count: count() })
      .from(runs)
      .where(and(eq(runs.userId, userId), gte(runs.createdAt, from), lt(runs.createdAt, to))),
    db
      .select({ total: sum(tradingRuns.creditsMicro), count: count() })
      .from(tradingRuns)
      .where(and(eq(tradingRuns.userId, userId), gte(tradingRuns.createdAt, from), lt(tradingRuns.createdAt, to))),
    db
      .select({ total: sum(botTurns.creditsMicro) })
      .from(botTurns)
      .where(and(eq(botTurns.userId, userId), gte(botTurns.createdAt, from), lt(botTurns.createdAt, to))),
  ]);
  return { automations: BigInt(a?.total ?? 0), trading: BigInt(t?.total ?? 0), chat: BigInt(c?.total ?? 0), runs: a?.count ?? 0, cycles: t?.count ?? 0 };
}

// ── Pending actions ─────────────────────────────────────────────────────────

export async function createAction(
  action: Pick<BotAction, "chatId" | "userId" | "kind" | "title"> & Partial<Pick<BotAction, "tool" | "args" | "runId">>,
): Promise<BotAction> {
  const [row] = await db
    .insert(botActions)
    .values({ ...action, expiresAt: new Date(Date.now() + ACTION_MINUTES * 60_000) })
    .returning();
  return row!;
}

export async function setActionMessage(id: string, messageId: number | null): Promise<void> {
  await db.update(botActions).set({ messageId }).where(eq(botActions.id, id));
}

/**
 * Claims a pending action for one outcome. Returns it only to the first caller,
 * so a button tapped twice, or two taps racing, act once.
 */
export async function claimAction(id: string, chatId: string, outcome: "confirmed" | "cancelled"): Promise<BotAction | "expired" | undefined> {
  const [action] = await db.select().from(botActions).where(and(eq(botActions.id, id), eq(botActions.chatId, chatId)));
  if (!action || action.status !== "pending") return undefined;
  if (action.expiresAt.getTime() < Date.now()) {
    await db.update(botActions).set({ status: "expired" }).where(eq(botActions.id, id));
    return "expired";
  }
  const [claimed] = await db
    .update(botActions)
    .set({ status: outcome })
    .where(and(eq(botActions.id, id), eq(botActions.status, "pending")))
    .returning();
  return claimed;
}

/** Pending actions older than their expiry, so their buttons can be removed. */
export async function expireActions(): Promise<BotAction[]> {
  return db
    .update(botActions)
    .set({ status: "expired" })
    .where(and(eq(botActions.status, "pending"), lt(botActions.expiresAt, new Date())))
    .returning();
}

/** Any pending action for the chat, newest first. */
export async function pendingActions(chatId: string): Promise<BotAction[]> {
  return db
    .select()
    .from(botActions)
    .where(and(eq(botActions.chatId, chatId), eq(botActions.status, "pending")))
    .orderBy(desc(botActions.createdAt));
}

/** The shared-bot Telegram connection for this chat, which automations and trading agents message through. */
export async function chatConnectionId(userId: string, chatId: string): Promise<string | undefined> {
  const rows = await db
    .select({ id: connections.id, display: connections.display })
    .from(connections)
    .where(and(eq(connections.userId, userId), eq(connections.kind, "telegram")));
  return rows.find((row) => row.display.chatId === chatId && !row.display.owner)?.id;
}

export async function connectionsOfKinds(userId: string, kinds: string[]): Promise<Array<{ id: string; kind: string; name: string }>> {
  if (kinds.length === 0) return [];
  return db
    .select({ id: connections.id, kind: connections.kind, name: connections.name })
    .from(connections)
    .where(and(eq(connections.userId, userId), inArray(connections.kind, kinds)));
}
