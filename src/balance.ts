import { eq } from "drizzle-orm";
import { fetchBalance } from "@lib/accred";
import { balanceToMicro } from "@lib/credits";
import { decrypt } from "@lib/crypto";
import { db, users, type User } from "@lib/db";

/** The user's credit balance, as the web app reads it, without React's request cache. */

export interface Balance {
  micro: bigint;
  at: Date;
  /** "live" was read from Accred's balance endpoint; "reported" is what the most recent model call returned. */
  source: "live" | "reported";
}

const FRESH_MS = 30_000;
const RETRY_UNSUPPORTED_MS = 10 * 60_000;
let unsupportedUntil = 0;

function stored(user: User): Balance | null {
  if (user.balanceExact === null || user.balanceAt === null) return null;
  try {
    return { micro: balanceToMicro(user.balanceExact), at: user.balanceAt, source: user.balanceSource ?? "reported" };
  } catch {
    return null;
  }
}

/** The balance, refreshed from Accred when the stored figure is older than 30 seconds. */
export async function getBalance(user: User): Promise<Balance | null> {
  const known = stored(user);
  if (known && Date.now() - known.at.getTime() < FRESH_MS) return known;
  if (Date.now() < unsupportedUntil) return known;
  const result = await fetchBalance(decrypt(user.keyEnc));
  if (result.status === "unsupported") {
    unsupportedUntil = Date.now() + RETRY_UNSUPPORTED_MS;
    return known;
  }
  if (result.status !== "ok") return known;
  const at = new Date();
  await db.update(users).set({ balanceExact: result.exact, balanceAt: at, balanceSource: "live" }).where(eq(users.id, user.id));
  return { micro: balanceToMicro(result.exact), at, source: "live" };
}
