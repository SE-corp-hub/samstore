import { Controller, Get, HttpException, HttpStatus } from "@nestjs/common";
import { prisma } from "../persistence/prisma-repositories.js";
import { metricsSnapshot } from "../security/observability.js";

/** Module 11 — liveness/readiness: /health (no DB), /health/ready (DB ping), /health/metrics. */
@Controller("health")
export class HealthController {
  @Get()
  async liveness() {
    return { status: "ok", uptimeSec: Math.round(process.uptime?.() ?? 0) };
  }

  @Get("ready")
  async readiness() {
    try {
      await prisma.$queryRawUnsafe("SELECT 1");
      return { status: "ready", db: "ok" };
    } catch {
      throw new HttpException({ status: "degraded", db: "error" }, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  /** Counters + the outbox backlog (a stuck PENDING count is the alarm to watch). */
  @Get("metrics")
  async metrics() {
    const snapshot = metricsSnapshot();
    let outbox = { pending: 0, processed: 0, failed: 0, oldestPendingSec: null as number | null };
    try {
      const grouped = await prisma.outboxEvent.groupBy({ by: ["status"], _count: { _all: true } });
      for (const g of grouped) {
        if (g.status === "PENDING") outbox.pending = g._count._all;
        if (g.status === "PROCESSED") outbox.processed = g._count._all;
        if (g.status === "FAILED") outbox.failed = g._count._all;
      }
      const oldest = await prisma.outboxEvent.findFirst({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
      outbox.oldestPendingSec = oldest ? Math.round((Date.now() - oldest.createdAt.getTime()) / 1000) : null;
    } catch {
      // metrics must never fail the health surface — report what we have
    }
    return { ...snapshot, outbox };
  }
}