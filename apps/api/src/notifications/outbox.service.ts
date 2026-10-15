// Transactional OUTBOX worker (Module 9).
// External side effects (notifications) are NEVER called synchronously inside a
// commerce command. Instead the command enqueues an OutboxEvent in its own
// transaction; this worker drains PENDING events with retries/backoff and marks
// them PROCESSED (or FAILED after max attempts). Idempotent: a PROCESSED row is
// never re-processed.

import { prisma } from "../persistence/prisma-repositories.js";
import { handleSmsEvent } from "../sms/sms.service.js";

export interface OutboxEventInput {
  storeId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/** Registered by a running worker; lets an enqueue drain immediately instead of waiting a tick. */
let wake: (() => void) | null = null;
export function wakeOutbox(): void {
  wake?.();
}

/** Enqueue a side-effect event (fire-and-forget; failures are swallowed by the caller). */
export async function enqueueOutboxEvent(input: OutboxEventInput): Promise<void> {
  await prisma.outboxEvent.create({ data: { ...input, payload: input.payload as object } });
  // Drain now: with the idle backoff below, waiting for the next tick could mean 30 s.
  wakeOutbox();
}

const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5_000;

export class OutboxWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private idleStreak = 0;
  private baseMs = 5_000;
  private maxIdleMs = 30_000;

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
      case "cart.abandoned":
        // P3j: abandoned-cart follow-up. Same suppressed side effect — the row is
        // the audit trail until a live Messenger/SMS provider is operator-approved.
        await prisma.notificationLog.create({
          data: {
            storeId: ev.storeId,
            template: "cart.abandoned",
            channel: "messenger",
            recipient: typeof payload.customerId === "string" ? payload.customerId : null,
            text: `Reminder: you have ${payload.itemCount ?? 0} item(s) waiting in your cart.`,
            delivered: false,
          },
        });
        return;
      case "campaign.send":
        // P8: follow-up campaign broadcast (suppressed side effect until approved).
        await prisma.notificationLog.create({
          data: {
            storeId: ev.storeId,
            template: "campaign.send",
            channel: "messenger",
            recipient: typeof payload.psid === "string" ? payload.psid : null,
            text: typeof payload.message === "string" ? payload.message : "Update from the store",
            delivered: false,
          },
        });
        return;
      case "sms.send":
        // Rice Ops M6: utang texts — mock provider until the SMS account is approved.
        await handleSmsEvent(payload);
        return;
      default:
        // Unknown event types are treated as already-handled (no-op) so the
        // queue never gets stuck on an event this build doesn't understand.
        return;
    }
  }

  /**
   * Self-scheduling drain loop. An empty outbox is the normal state, so after two empty
   * ticks the delay backs off to `maxIdleMs` — measured, the old fixed 5 s interval ran
   * 12 idle queries a minute (~17k/day per process) against a pooler with 4 slots.
   * `enqueueOutboxEvent` wakes the loop, so a real event drains immediately rather than
   * waiting out the backoff.
   */
  start(intervalMs = 5_000, maxIdleMs = 30_000): void {
    if (this.running) return;
    this.running = true;
    this.baseMs = intervalMs;
    this.maxIdleMs = maxIdleMs;
    wake = () => {
      this.idleStreak = 0;
      this.schedule(0);
    };
    this.schedule(intervalMs);
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    let processed = 0;
    try {
      processed = await this.poll();
    } catch {
      /* transient db errors: try again next tick */
    }
    this.idleStreak = processed > 0 ? 0 : this.idleStreak + 1;
    this.schedule(this.idleStreak >= 2 ? this.maxIdleMs : this.baseMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    wake = null;
  }
}
