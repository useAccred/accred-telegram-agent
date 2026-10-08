import { createServer } from "node:http";
import { env } from "@lib/env";
import { startTelegramPolling } from "@lib/telegram";
import { botHeartbeat } from "./bot/heartbeat";
import { handleBotUpdate } from "./bot/router";

/**
 * The Accred Telegram agent as its own process: polls the bot, answers, runs
 * confirmations, and does its background work. It shares the database with
 * agent.accred.sh, so a chat and the web app are one account. The web app
 * must not poll the same bot (TELEGRAM_POLLING=off there).
 */

const HEARTBEAT_MS = 30_000;
const started = Date.now();

function main(): void {
  if (!env.telegramBotToken) {
    console.error("TELEGRAM_BOT_TOKEN is not set. Nothing to do.");
    process.exit(1);
  }
  // Read eagerly so a missing secret fails at start, not on the first message.
  void env.databaseUrl;
  void env.appSecret;

  const port = Number(process.env.PORT ?? 8080);
  createServer((request, response) => {
    if (request.url === "/api/health" || request.url === "/") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, uptimeSeconds: Math.round((Date.now() - started) / 1000) }));
      return;
    }
    response.writeHead(404);
    response.end();
  }).listen(port, () => console.log(`[bot] Health endpoint on :${port}`));

  startTelegramPolling(handleBotUpdate);
  // On a free Render instance, inbound traffic is what keeps the process awake. A ping every five
  // minutes from inside counts, so polling never stops. Harmless on a paid instance.
  const self = process.env.RENDER_EXTERNAL_URL;
  if (self) setInterval(() => fetch(`${self}/api/health`).catch(() => {}), 5 * 60_000).unref();
  const heartbeat = setInterval(() => botHeartbeat().catch((error) => console.error("[bot] heartbeat", error instanceof Error ? error.message : error)), HEARTBEAT_MS);
  heartbeat.unref();
  console.log(`[bot] Live trading on this server: ${env.liveTrading ? "on" : "off"}`);
}

main();
