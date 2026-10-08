import { formatCredits, formatUsd } from "@lib/credits";

/** Text helpers for the Telegram agent. Plain text only: the bot never uses a parse mode. */

export const MESSAGE_LIMIT = 4000;

/** Splits text into messages Telegram accepts, breaking at paragraph or line ends where it can. */
export function splitMessage(text: string, limit = MESSAGE_LIMIT): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return ["(empty reply)"];
  const parts: string[] = [];
  let rest = clean;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit / 2) cut = window.lastIndexOf("\n");
    if (cut < limit / 2) cut = window.lastIndexOf(" ");
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** A hex private key or seed-like secret, which must never sit in a chat. */
export function looksLikePrivateKey(text: string): boolean {
  const value = text.trim();
  return /^(0x)?[0-9a-fA-F]{64}$/.test(value) || /^(\w+\s+){11,23}\w+$/.test(value) && value.split(/\s+/).every((word) => /^[a-z]{3,8}$/.test(word));
}

/** An Accred platform key, as a user would paste it. Keys start with ct_live_ and carry no spaces. */
export function looksLikeKey(text: string): boolean {
  const value = text.trim();
  if (/^ct_(live|test)_[A-Za-z0-9_-]{16,}$/.test(value)) return true;
  // Something key-shaped without the prefix, but never an address, a hash or a private key.
  if (value.length < 24 || value.length > 256 || !/^[A-Za-z0-9_.-]+$/.test(value) || !/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
  if (/^(0x)?[0-9a-fA-F]{40}$/.test(value) || /^(0x)?[0-9a-fA-F]{64}$/.test(value)) return false;
  return true;
}

export function credits(micro: bigint): string {
  return `${formatCredits(micro)} credits (${formatUsd(micro)})`;
}

/** "/brief 8" → { command: "brief", arg: "8" }. Handles the "@botname" suffix Telegram adds in some clients. */
export function parseCommand(text: string): { command: string; arg: string } | null {
  const match = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { command: match[1]!.toLowerCase(), arg: (match[2] ?? "").trim() } : null;
}

/** The calendar date, as YYYY-MM-DD, at an instant in a timezone. */
export function localDate(instant: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

/** The hour of the day, 0 to 23, at an instant in a timezone. */
export function localHour(instant: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(instant));
  return Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
}

/** Weekday at an instant in a timezone, 0 is Sunday. */
export function localDay(instant: number, timezone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(new Date(instant));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

/** The ISO week of a calendar date, as "2026-W41". */
export function isoWeek(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(year, month - 1, day));
  const weekday = at.getUTCDay() || 7;
  at.setUTCDate(at.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(at.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((at.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${at.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function bullet(lines: string[]): string {
  return lines.map((line) => `• ${line}`).join("\n");
}
