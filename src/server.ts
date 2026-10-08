import { createServer } from "node:http";
import { env } from "@lib/env";
import { getBotUsername } from "@lib/telegram";
import { botHeartbeat } from "./bot/heartbeat";
import { registerMenu } from "./bot/menu";
import { handleBotUpdate, setBotIdentity } from "./bot/router";
import { telegramApi } from "./bot/telegram-api";
import { pollingHealth, startPolling } from "./polling";

/**
 * The Accred Telegram agent as its own process: polls the bot, answers, runs
 * confirmations, and does its background work. It shares the database with
 * agent.accred.sh, so a chat and the web app are one account. The web app
 * must not poll the same bot (TELEGRAM_POLLING=off there).
 */

const HEARTBEAT_MS = 30_000;
/** With no answer from Telegram for this long, the process exits and the host restarts it. */
const STALL_MS = 5 * 60_000;
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
      const polling = pollingHealth();
      const stalled = polling.stopped !== null || (polling.lastOkAt > 0 && Date.now() - polling.lastOkAt > STALL_MS);
      response.writeHead(stalled ? 503 : 200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: !stalled,
          uptimeSeconds: Math.round((Date.now() - started) / 1000),
          lastPollAgoSeconds: polling.lastOkAt ? Math.round((Date.now() - polling.lastOkAt) / 1000) : null,
          updates: polling.updates,
          stopped: polling.stopped,
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  }).listen(port, () => console.log(`[bot] Health endpoint on :${port}`));

  const token = env.telegramBotToken;
  getBotUsername()
    .catch(() => "AccredAgentbot")
    .then((name) => {
      setBotIdentity(name);
      startPolling(token, handleBotUpdate, name);
      void registerMenu(telegramApi(token)).then(() => console.log("[bot] Command menu registered"));
    });
  // Watchdog: a quiet connection to Telegram is not a working bot. Exit, and the host restarts the process.
  setInterval(() => {
    const polling = pollingHealth();
    const since = polling.lastOkAt || started;
    if (Date.now() - since > STALL_MS) {
      console.error(`[bot] No answer from Telegram for ${Math.round((Date.now() - since) / 1000)}s. Restarting.`);
      process.exit(1);
    }
  }, 60_000).unref();
  // On a free Render instance, inbound traffic is what keeps the process awake. A ping every five
  // minutes from inside counts, so polling never stops. Harmless on a paid instance.
  const self = process.env.RENDER_EXTERNAL_URL;
  if (self) setInterval(() => fetch(`${self}/api/health`).catch(() => {}), 5 * 60_000).unref();
  const heartbeat = setInterval(() => botHeartbeat().catch((error) => console.error("[bot] heartbeat", error instanceof Error ? error.message : error)), HEARTBEAT_MS);
  heartbeat.unref();
  console.log(`[bot] Live trading on this server: ${env.liveTrading ? "on" : "off"}`);
}

main();
