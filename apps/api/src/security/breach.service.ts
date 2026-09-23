import { randomUUID } from "node:crypto";
import { prisma } from "../persistence/prisma-repositories.js";
import type { ApiError } from "@sam-store/contracts";

export type BreachResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

/** NPC notifier boundary. Live email/NPC portal integration is operator/deployment work. */
export interface NpcBreachNotifier {
  readonly name: string;
  ready(): boolean;
  notify(input: { reference: string; title: string; severity: string; details: unknown }): Promise<{ reference: string }>;
}

export class PendingNpcBreachNotifier implements NpcBreachNotifier {
  readonly name = "pending";
  ready(): boolean { return false; }
  async notify(): Promise<{ reference: string }> {
    throw new Error("NPC breach notification is PENDING_OPERATOR — configure the approved notification channel");
  }
}

export class SecurityIncidentService {
  constructor(private readonly notifier: NpcBreachNotifier = new PendingNpcBreachNotifier()) {}

  async create(storeId: string, actorId: string, input: { title: string; severity: string; details?: unknown }): Promise<BreachResult<{ id: string; status: string }>> {
    const title = input.title?.trim();
    const severity = input.severity?.toUpperCase();
    if (!title || title.length > 200) return { ok: false, error: { type: "validation", errors: ["title is required (max 200)"] } };
    if (!["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(severity)) return { ok: false, error: { type: "validation", errors: ["severity must be LOW, MEDIUM, HIGH, or CRITICAL"] } };
    const incident = await prisma.securityIncident.create({ data: { storeId, title, severity, details: input.details as object ?? undefined } });
    await prisma.auditLog.create({ data: { storeId, actorType: "store_owner", actorId, action: "security.incident.created", entityType: "SecurityIncident", entityId: incident.id, after: { severity, title } } });
    return { ok: true, value: { id: incident.id, status: incident.status } };
  }

  async list(storeId: string) {
    return prisma.securityIncident.findMany({ where: { storeId }, orderBy: { createdAt: "desc" }, take: 100 });
  }

  async contain(storeId: string, incidentId: string, actorId: string): Promise<BreachResult<{ id: string; status: string }>> {
    const incident = await prisma.securityIncident.findFirst({ where: { id: incidentId, storeId } });
    if (!incident) return { ok: false, error: { type: "not_found", message: "Security incident not found" } };
    await prisma.securityIncident.update({ where: { id: incidentId }, data: { status: "CONTAINED" } });
    await prisma.auditLog.create({ data: { storeId, actorType: "store_owner", actorId, action: "security.incident.contained", entityType: "SecurityIncident", entityId: incidentId, before: { status: incident.status }, after: { status: "CONTAINED" } } });
    return { ok: true, value: { id: incidentId, status: "CONTAINED" } };
  }

  async notifyNpc(storeId: string, incidentId: string, actorId: string): Promise<BreachResult<{ status: string; reference: string }>> {
    const incident = await prisma.securityIncident.findFirst({ where: { id: incidentId, storeId } });
    if (!incident) return { ok: false, error: { type: "not_found", message: "Security incident not found" } };
    const reference = `NPC-${randomUUID()}`;
    await prisma.auditLog.create({ data: { storeId, actorType: "store_owner", actorId, action: "security.incident.npc_notification_pending", entityType: "SecurityIncident", entityId: incidentId, after: { reference, notifier: this.notifier.name, ready: this.notifier.ready() } } });
    return { ok: true, value: { status: "PENDING_OPERATOR", reference } };
  }
}
