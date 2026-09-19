import type pino from "pino";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default";
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface ExpoPushReceipt {
  status: "ok" | "error";
  message?: string;
  details?: { error?: string };
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPT_URL = "https://exp.host/--/api/v2/push/getReceipts";
const MAX_RECEIPT_IDS = 1000;
// Expo recommends checking receipts ~15 min after send; receipts clear after 24h.
const DEFAULT_RECEIPT_DELAY_MS = 15 * 60 * 1000;

export interface PushServiceOptions {
  fetchImpl?: typeof fetch;
  schedule?: (callback: () => void, delayMs: number) => void;
  receiptDelayMs?: number;
}

/**
 * Service for sending Expo push notifications.
 * Handles per-token sends, invalid token removal, and delivery-receipt checks.
 *
 * One request per token: tokens may belong to different Expo projects
 * (fork vs upstream). A mixed-project batch fails the whole request
 * (HTTP 400), so a bad project would poison delivery to good tokens.
 * Per-token sends isolate each project's failure to its own ticket.
 *
 * A ticket `ok` only means Expo accepted the message. Delivery to FCM/APNs
 * (e.g. MismatchSenderId when google-services.json and the EAS FCM credential
 * belong to different sender IDs) surfaces later in push receipts, so every
 * accepted ticket is followed up with a getReceipts poll.
 */
export class PushService {
  private readonly logger: pino.Logger;
  private readonly revokeToken: (token: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly schedule: (callback: () => void, delayMs: number) => void;
  private readonly receiptDelayMs: number;

  constructor(
    logger: pino.Logger,
    revokeToken: (token: string) => void,
    options: PushServiceOptions = {},
  ) {
    this.logger = logger.child({ component: "push-service" });
    this.revokeToken = revokeToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.schedule = options.schedule ?? ((callback, delayMs) => {
      setTimeout(() => callback(), delayMs);
    });
    this.receiptDelayMs = options.receiptDelayMs ?? DEFAULT_RECEIPT_DELAY_MS;
  }

  async sendPush(tokens: string[], payload: PushPayload): Promise<void> {
    if (tokens.length === 0) {
      return;
    }

    const messages: ExpoPushMessage[] = tokens.map((token) => ({
      to: token,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      sound: "default",
    }));

    await Promise.all(messages.map((message) => this.sendSingle(message)));
  }

  private async sendSingle(message: ExpoPushMessage): Promise<void> {
    try {
      const response = await this.fetchImpl(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        this.logger.error(
          { token: message.to, status: response.status, statusText: response.statusText },
          "Expo push API error",
        );
        return;
      }

      const result = (await response.json()) as {
        data: ExpoPushTicket[] | ExpoPushTicket;
      };
      // Single-message sends return a single ticket object, not an array.
      const tickets = Array.isArray(result.data) ? result.data : [result.data];
      const pending = this.handleTickets([message], tickets);
      if (pending.size > 0) {
        const snapshot = new Map(pending);
        this.schedule(() => {
          void this.checkReceipts(snapshot);
        }, this.receiptDelayMs);
      }
    } catch (error) {
      this.logger.error({ err: error, token: message.to }, "Failed to send push notifications");
    }
  }

  /**
   * Logs ticket errors and returns accepted ticket IDs mapped to their token,
   * so the receipt poll can attribute delivery failures per device.
   *
   * DeviceNotRegistered revokes (device gone). InvalidCredentials is kept:
   * it means the Expo project's FCM/APNs credential is missing or revoked,
   * which is recoverable by uploading a key — deleting the token would force
   * every device to re-register after the credential fix.
   */
  private handleTickets(
    messages: ExpoPushMessage[],
    tickets: ExpoPushTicket[],
  ): Map<string, string> {
    const pending = new Map<string, string>();
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      const message = messages[i];
      if (!ticket || !message) continue;

      if (ticket.status === "error") {
        this.logger.error(
          { token: message.to, message: ticket.message, details: ticket.details },
          "Push failed for token",
        );

        if (ticket.details?.error === "DeviceNotRegistered") {
          this.revokeToken(message.to);
        }
      } else if (ticket.id) {
        pending.set(ticket.id, message.to);
      }
    }
    return pending;
  }

  private async checkReceipts(idToToken: Map<string, string>): Promise<void> {
    const ids = Array.from(idToToken.keys());
    for (let i = 0; i < ids.length; i += MAX_RECEIPT_IDS) {
      const chunk = ids.slice(i, i + MAX_RECEIPT_IDS);
      try {
        const response = await this.fetchImpl(EXPO_RECEIPT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ ids: chunk }),
        });

        if (!response.ok) {
          this.logger.error(
            { status: response.status, statusText: response.statusText },
            "Expo push receipt API error",
          );
          continue;
        }

        const result = (await response.json()) as {
          data?: Record<string, ExpoPushReceipt>;
        };
        const receipts = result.data ?? {};
        for (const id of chunk) {
          const receipt = receipts[id];
          // Missing receipt = not yet available (or cleared after 24h).
          if (!receipt) {
            this.logger.debug({ receiptId: id }, "Push receipt not yet available");
            continue;
          }
          if (receipt.status === "error") {
            const token = idToToken.get(id);
            this.logger.error(
              { token, receiptId: id, message: receipt.message, details: receipt.details },
              "Push delivery failed",
            );
            if (receipt.details?.error === "DeviceNotRegistered" && token) {
              this.revokeToken(token);
            }
          }
        }
      } catch (error) {
        this.logger.error({ err: error }, "Failed to check push receipts");
      }
    }
  }
}
