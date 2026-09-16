// Transactional OUTBOX worker (Module 9).
// External side effects (notifications) are NEVER called synchronously inside a
// commerce command. Instead the command enqueues an OutboxEvent in its own
// transaction; this worker drains PENDING events with retries/backoff and marks
// them PROCESSED (or FAILED after max attempts). Idempotent: a PROCESSED row is
// never re-processed.

import { prisma } from "../persistence/prisma-repositories.js";

export interface OutboxEventInput {
  storeId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/** Enqueue a side-effect event (fire-and-forget; failures are swallowed by the caller). */
export async function enqueueOutboxEvent(input: OutboxEventInput): Promise<void> {
  await prisma.outboxEvent.create({ data: { ...input, payload: input.payload as object } });
}

const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5_000;

export class OutboxWorker {
  private timer: NodeJS.Timeout | null = null;

  /** Process one batch of due PENDING events. Returns how many were processed. */
  async poll(batchSize = 20): Promise<number> {
    const due = await prisma.outboxEvent.findMany({
      where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: "asc" },
      take: batchSize,
    });
    let done = 0;
    for (const ev of due) {
      try {
        await this.handle(ev);
        await prisma.outboxEvent.update({
          where: { id: ev.id },
          data: { status: "PROCESSED", processedAt: new Date() },
        });
        done += 1;
      } catch (e) {
        const attempts = ev.attempts + 1;
        const failed = attempts >= MAX_ATTEMPTS;
        await prisma.outboxEvent.update({
          where: { id: ev.id },
          data: {
            attempts,
            status: failed ? "FAILED" : "PENDING",
            nextAttemptAt: new Date(Date.now() + BACKOFF_BASE_MS * Math.pow(2, attempts)),
            lastError: e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500),
          },
        });
      }
    }
    return done;
  }

  /** Handle a single event type. Extend here for new side effects. */
  private async handle(ev: { id: string; storeId: string; eventType: string; payload: unknown }): Promise<void> {
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    switch (ev.eventType) {
      case "order.received":
      case "notification.send":
        if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
          throw new Error("notification.send payload requires non-empty text");
        }
        // The Messenger bridge is a suppressed/mock provider until a store is
        // connected (AGENTS.md). Writing the NotificationLog row IS the side
        // effect for now — a real provider would be called here.
        await prisma.notificationLog.create({
          data: {
            storeId: ev.storeId,
            template: "order.received",
            channel: "messenger",
            recipient: typeof payload.psid === "string" ? payload.psid : null,
            text: typeof payload.text === "string" ? payload.text : "Order received",
            delivered: false,
          },
        });
        return;
      default:
        // Unknown event types are treated as already-handled (no-op) so the
        // queue never gets stuck on an event this build doesn't understand.
        return;
    }
  }

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.timer = setInterval(() => {
      void this.poll().catch(() => {
        /* transient db errors: try again next tick */
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
