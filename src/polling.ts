import type { TelegramUpdate } from "@lib/telegram";

/**
 * Long polling with a pulse. The loop records when Telegram last answered, so
 * the health endpoint can show it and the watchdog in server.ts can restart the
 * process if the connection goes quiet. Handlers queue their own work per chat,
 * so this loop is never held up by a slow turn.
 */

const API = "https://api.telegram.org";

export interface PollingHealth {
  /** When getUpdates last succeeded. 0 before the first success. */
  lastOkAt: number;
  consecutiveFailures: number;
  updates: number;
  stopped: string | null;
}

const health: PollingHealth = { lastOkAt: 0, consecutiveFailures: 0, updates: 0, stopped: null };

export function pollingHealth(): PollingHealth {
  return { ...health };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getUpdates(token: string, offset: number | undefined): Promise<TelegramUpdate[]> {
  const response = await fetch(`${API}/bot${token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ timeout: 25, offset, allowed_updates: ["message", "callback_query"] }),
    signal: AbortSignal.timeout(40_000),
  });
  const payload = (await response.json()) as { ok: boolean; result?: TelegramUpdate[]; description?: string };
  if (!payload.ok) throw Object.assign(new Error(payload.description ?? "getUpdates failed"), { status: response.status });
  return payload.result ?? [];
}

export function startPolling(token: string, onUpdate: (update: TelegramUpdate) => Promise<void>, botName: string): void {
  console.log(`[telegram] Listening for messages to @${botName}`);
  void (async () => {
    let offset: number | undefined;
    for (;;) {
      try {
        const updates = await getUpdates(token, offset);
        health.lastOkAt = Date.now();
        health.consecutiveFailures = 0;
        for (const update of updates) {
          offset = update.update_id + 1;
          health.updates++;
          await onUpdate(update).catch((error) => console.error("[telegram]", error instanceof Error ? error.message : error));
        }
      } catch (error) {
        const status = (error as { status?: number }).status;
        health.consecutiveFailures++;
        if (status === 401 || status === 404) {
          health.stopped = "The bot token was rejected.";
          console.error("[telegram] The bot token was rejected. Polling stopped.");
          return;
        }
        if (health.consecutiveFailures === 1 || health.consecutiveFailures % 10 === 0) {
          console.error(`[telegram] getUpdates failed (${health.consecutiveFailures} in a row): ${error instanceof Error ? error.message : error}`);
        }
        // 409 means another process is polling the same bot, or a webhook is set. Back off and retry.
        await sleep(status === 409 ? 15_000 : Math.min(5_000 * health.consecutiveFailures, 30_000));
      }
    }
  })();
}
