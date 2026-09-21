// P8: CRM — customer aggregates (LTV/AOV/recency/favorite), segmentation, campaigns.
// Campaigns enqueue ONE `campaign.send` OutboxEvent per OPTED-IN Messenger user
// (idempotent via CampaignRecipient); sends stay suppressed until a live provider
// is approved.

import { prisma } from "../persistence/prisma-repositories.js";
import { enqueueOutboxEvent } from "../notifications/outbox.service.js";
import type { ApiError } from "@sam-store/contracts";

export type CrmResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface SegmentRule {
  minOrders?: number;
  minLtvMinor?: number;
  maxDaysSinceLastOrder?: number;
  hasCredit?: boolean;
  tag?: string;
  messengerOnly?: boolean; // only customers with an opted-in Messenger PSID
}

export interface CustomerAggregate {
  storeCustomerId: string;
  customerId: string;
  name: string | null;
  phone: string | null;
  ltvMinor: number;
  orders: number;
  aovMinor: number;
  lastOrderAt: string | null;
  daysSinceLastOrder: number | null;
  favoriteProduct: string | null;
  tags: string[];
  psid: string | null;
  creditBalanceMinor: number;
}

const FULFILLED = new Set(["COMPLETED", "DELIVERED"]);

export class CrmService {
  /** Compute aggregates for every store customer (on-demand, live data only). */
  async aggregates(storeId: string): Promise<CustomerAggregate[]> {
    const customers = await prisma.storeCustomer.findMany({
      where: { storeId },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        orders: { select: { totalMinor: true, createdAt: true, status: true, items: { select: { productName: true } } } },
      },
    });
    const messenger = await prisma.messengerUser.findMany({ where: { storeId, optedIn: true } });
    const psidByCustomer = new Map<string, string>();
    for (const m of messenger) if (m.customerId) psidByCustomer.set(m.customerId, m.psid);
    const now = Date.now();
    const out: CustomerAggregate[] = [];
    for (const sc of customers) {
      const orders = (sc.orders ?? []).filter((o) => FULFILLED.has(o.status));
      const ltv = orders.reduce((s, o) => s + o.totalMinor, 0);
      const last = orders.reduce<Date | null>((acc, o) => (!acc || o.createdAt > acc ? o.createdAt : acc), null);
      const fav = new Map<string, number>();
      for (const o of orders) for (const it of o.items) fav.set(it.productName, (fav.get(it.productName) ?? 0) + 1);
      const favorite = [...fav.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      out.push({
        storeCustomerId: sc.id,
        customerId: sc.customerId,
        name: sc.customer.name,
        phone: sc.customer.phone,
        ltvMinor: ltv,
        orders: orders.length,
        aovMinor: orders.length ? Math.round(ltv / orders.length) : 0,
        lastOrderAt: last?.toISOString() ?? null,
        daysSinceLastOrder: last ? Math.floor((now - last.getTime()) / 86_400_000) : null,
        favoriteProduct: favorite,
        tags: sc.tags ?? [],
        psid: psidByCustomer.get(sc.customerId) ?? null,
        creditBalanceMinor: sc.creditBalanceMinor,
      });
    }
    return out;
  }

  /** Evaluate a segment rule against live aggregates. */
  segment(rows: CustomerAggregate[], rule: SegmentRule): CustomerAggregate[] {
    const now = Date.now();
    const days = rule.maxDaysSinceLastOrder;
    return rows.filter((r) => {
      if (rule.minOrders !== undefined && r.orders < rule.minOrders) return false;
      if (rule.minLtvMinor !== undefined && r.ltvMinor < rule.minLtvMinor) return false;
      if (rule.hasCredit !== undefined && (r.creditBalanceMinor > 0) !== rule.hasCredit) return false;
      if (rule.tag && !r.tags.includes(rule.tag)) return false;
      if (rule.messengerOnly && !r.psid) return false;
      // maxDaysSinceLastOrder = "at risk/inactive": match customers who ordered AT
      // LEAST N days ago (never-ordered customers are new, not at risk).
      if (days !== undefined && days > 0) {
        if (r.daysSinceLastOrder === null) return false;
        if (r.daysSinceLastOrder < days) return false;
      }
      return true;
    });
  }

  /** Set CRM tags on a store customer. */
  async setTags(storeId: string, storeCustomerId: string, tags: string[]): Promise<CrmResult<{ tags: string[] }>> {
    const sc = await prisma.storeCustomer.findFirst({ where: { id: storeCustomerId, storeId } });
    if (!sc) return { ok: false, error: { type: "not_found", message: "Customer not found" } };
    const clean = [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0))].slice(0, 20);
    await prisma.storeCustomer.update({ where: { id: sc.id }, data: { tags: clean } });
    await prisma.customer.update({ where: { id: sc.customerId }, data: {} });
    return { ok: true, value: { tags: clean } };
  }

  // ─────────────────────────────── Campaigns ───────────────────────────────

  async createCampaign(storeId: string, name: string, rule: SegmentRule, message: string): Promise<CrmResult<{ id: string }>> {
    const n = name?.trim();
    const m = message?.trim();
    if (!n || n.length > 80) return { ok: false, error: { type: "validation", errors: ["name is required (max 80)"] } };
    if (!m || m.length > 640) return { ok: false, error: { type: "validation", errors: ["message is required (max 640)"] } };
    if (!rule || typeof rule !== "object") return { ok: false, error: { type: "validation", errors: ["rule is required"] } };
    const dup = await prisma.campaign.findFirst({ where: { storeId, name: n } });
    if (dup) return { ok: false, error: { type: "conflict", message: "A campaign with this name already exists" } };
    const created = await prisma.campaign.create({ data: { storeId, name: n, rule: rule as object, message: m } });
    return { ok: true, value: { id: created.id } };
  }

  async listCampaigns(storeId: string) {
    return prisma.campaign.findMany({ where: { storeId }, orderBy: { createdAt: "desc" } });
  }

  /** Run a campaign: evaluate the segment, enqueue one campaign.send per OPTED-IN
   *  Messenger user (idempotent via CampaignRecipient), mark the campaign SENT. */
  async runCampaign(storeId: string, campaignId: string): Promise<CrmResult<{ id: string; recipients: number }>> {
    const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, storeId } });
    if (!campaign) return { ok: false, error: { type: "not_found", message: "Campaign not found" } };
    if (campaign.status === "SENT") return { ok: false, error: { type: "conflict", message: "Campaign already sent" } };

    const rule = (campaign.rule ?? {}) as SegmentRule;
    const matches = this.segment(await this.aggregates(storeId), { ...rule, messengerOnly: true });

    let recipients = 0;
    for (const row of matches) {
      if (!row.psid) continue;
      const upserted = await prisma.campaignRecipient.upsert({
        where: { storeId_campaignId_storeCustomerId: { storeId, campaignId, storeCustomerId: row.storeCustomerId } },
        update: {},
        create: { storeId, campaignId, storeCustomerId: row.storeCustomerId, psid: row.psid },
      });
      if (upserted.sent) continue; // idempotent — already enqueued
      await enqueueOutboxEvent({
        storeId,
        aggregateType: "Campaign",
        aggregateId: campaign.id,
        eventType: "campaign.send",
        payload: { psid: row.psid, message: campaign.message, campaignId: campaign.id },
      });
      await prisma.campaignRecipient.update({ where: { id: upserted.id }, data: { sent: true } });
      recipients += 1;
    }

    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "SENT", sentAt: new Date(), recipientCount: recipients } });
    return { ok: true, value: { id: campaign.id, recipients } };
  }

  async deleteCampaign(storeId: string, campaignId: string): Promise<CrmResult<{ ok: true }>> {
    const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, storeId } });
    if (!campaign) return { ok: false, error: { type: "not_found", message: "Campaign not found" } };
    await prisma.campaignRecipient.deleteMany({ where: { campaignId } });
    await prisma.campaign.delete({ where: { id: campaignId } });
    return { ok: true, value: { ok: true } };
  }
}