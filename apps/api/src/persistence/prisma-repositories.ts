// Prisma-backed implementations of the repository interfaces.
// Swap target for the in-memory repos once DATABASE_URL is live. Callers depend
// only on the interfaces, so no service changes are required.

import { PrismaClient } from "@prisma/client";
import type {
  StoreRecord,
  ProductRecord,
  CartRecord,
  OrderRecord,
  StoreRepository,
  CatalogRepository,
  CartRepository,
  OrderRepository,
  OrderSequenceRepository,
  AtomicCheckoutEffects,
} from "./repositories.js";
import { OrderStatus, PaymentStatus } from "@prisma/client";
import { InsufficientStockError } from "../domain/movements.js";

// Module 4/5 hardening: the managed Postgres pooler can take several seconds to
// hand out a connection (cold start), while Prisma's interactive-transaction
// defaults are 5s timeout / 2s max wait — a cold first request then dies with
// P2028 ("Transaction already closed"). Raise both globally so every interactive
// transaction in the codebase inherits a budget that fits remote latency.
export const prisma = new PrismaClient({
  transactionOptions: { timeout: 30_000, maxWait: 15_000 },
});

export const ORDER_SEQUENCE_KIND = "ORDER_SEQ";
export const CLAIM_TOKEN_TTL_DAYS = 30;

type StoreWithSettings = NonNullable<Awaited<ReturnType<PrismaClient["store"]["findUnique"]>>> & {
  settings: {
    allowGuestOrders: boolean;
    orderingPaused: boolean;
    closedStoreMessage: string | null;
    deliveryFeeMinor: number;
    deliveryEnabled: boolean;
    pickupEnabled: boolean;
    minOrderAmountMinor: number;
    // M4: VAT configuration travels with the store record so checkout never needs a second read.
    vatEnabled: boolean;
    vatRateBp: number;
    pricesIncludeVat: boolean;
  } | null;
};

export class PrismaStoreRepository implements StoreRepository {
  private static toRecord(s: StoreWithSettings | null): StoreRecord | null {
    if (!s) return null;
    const settings = s.settings;
    return {
      id: s.id,
      slug: s.slug,
      name: s.name,
      description: s.description,
      currencyCode: s.currencyCode,
      timezone: s.timezone,
      status: s.status,
      guestOrderingEnabled: settings?.allowGuestOrders ?? true,
      orderingPaused: settings?.orderingPaused ?? false,
      closedStoreMessage: settings?.closedStoreMessage ?? null,
      deliveryFeeMinor: settings?.deliveryFeeMinor ?? 0,
      deliveryEnabled: settings?.deliveryEnabled ?? true,
      pickupEnabled: settings?.pickupEnabled ?? false,
      minOrderAmountMinor: settings?.minOrderAmountMinor ?? 0,
      vatEnabled: settings?.vatEnabled ?? true,
      vatRateBp: settings?.vatRateBp ?? 1200,
      pricesIncludeVat: settings?.pricesIncludeVat ?? true,
      accentColor: s.accentColor,
      bannerText: s.bannerText,
      logoUrl: s.logoUrl,
    };
  }

  async findBySlug(slug: string): Promise<StoreRecord | null> {
    const s = await prisma.store.findUnique({
      where: { slug },
      include: { settings: true },
    });
    return PrismaStoreRepository.toRecord(s);
  }

  async findById(id: string): Promise<StoreRecord | null> {
    const s = await prisma.store.findUnique({
      where: { id },
      include: { settings: true },
    });
    return PrismaStoreRepository.toRecord(s);
  }
}

export class PrismaCatalogRepository implements CatalogRepository {
  private static toRecord(
    p: Awaited<ReturnType<PrismaClient["product"]["findFirst"]>> & {
      category: { name: string } | null;
      images: { url: string; sortOrder: number }[];
      stockLevels: { quantityOnHand: number; quantityReserved: number }[];
    },
  ): ProductRecord {
    const onHand = p.stockLevels.reduce((s, l) => s + l.quantityOnHand, 0);
    const reserved = p.stockLevels.reduce((s, l) => s + l.quantityReserved, 0);
    return {
      id: p.id,
      storeId: p.storeId,
      sku: p.sku,
      name: p.name,
      description: p.description,
      priceMinor: p.priceMinor,
      isActive: p.isActive,
      categoryName: p.category?.name ?? null,
      images: p.images.map((i) => i.url),
      quantityOnHand: onHand,
      quantityReserved: reserved,
    };
  }

  async listActiveProducts(storeId: string): Promise<ProductRecord[]> {
    const rows = await prisma.product.findMany({
      where: { storeId, isActive: true },
      include: {
        category: { select: { name: true } },
        images: { orderBy: { sortOrder: "asc" }, select: { url: true, sortOrder: true } },
        stockLevels: { select: { quantityOnHand: true, quantityReserved: true } },
      },
    });
    return rows.map(PrismaCatalogRepository.toRecord);
  }

  async getProductsByIds(storeId: string, ids: string[]): Promise<ProductRecord[]> {
    const rows = await prisma.product.findMany({
      where: { storeId, id: { in: ids } },
      include: {
        category: { select: { name: true } },
        images: { orderBy: { sortOrder: "asc" }, select: { url: true, sortOrder: true } },
        stockLevels: { select: { quantityOnHand: true, quantityReserved: true } },
      },
    });
    return rows.map(PrismaCatalogRepository.toRecord);
  }

  async getProductById(id: string): Promise<ProductRecord | null> {
    const row = await prisma.product.findUnique({
      where: { id },
      include: {
        category: { select: { name: true } },
        images: { orderBy: { sortOrder: "asc" }, select: { url: true, sortOrder: true } },
        stockLevels: { select: { quantityOnHand: true, quantityReserved: true } },
      },
    });
    return row ? PrismaCatalogRepository.toRecord(row) : null;
  }
}

export class PrismaCartRepository implements CartRepository {
  async findByToken(token: string): Promise<CartRecord | null> {
    const c = await prisma.cart.findUnique({
      where: { token },
      include: {
        items: { include: { product: { select: { id: true } } } },
      },
    });
    if (!c) return null;
    return {
      id: c.id,
      storeId: c.storeId ?? "",
      token: c.token,
      status: c.status,
      expiresAt: c.expiresAt,
      lines: c.items.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
        unitPriceMinor: i.unitPriceMinor,
      })),
    };
  }

  async create(cart: CartRecord): Promise<CartRecord> {
    await prisma.cart.create({
      data: {
        id: cart.id,
        storeId: cart.storeId || null,
        token: cart.token,
        status: cart.status,
        expiresAt: cart.expiresAt ?? null,
      },
    });
    return cart;
  }

  async addItem(cartId: string, storeId: string, productId: string, quantity: number, unitPriceMinor: number): Promise<void> {
    // A single atomic upsert on the (cartId, productId) unique key. The previous
    // find-then-create raced: two quick adds of the same product (double-tap, two tabs)
    // made the second create violate the constraint → P2002 → HTTP 500 to the customer.
    await prisma.cartItem.upsert({
      where: { cartId_productId: { cartId, productId } },
      update: { quantity: { increment: quantity } },
      create: { cartId, storeId, productId, quantity, unitPriceMinor },
    });
  }

  async updateItemQuantity(cartId: string, productId: string, quantity: number): Promise<void> {
    await prisma.cartItem.update({
      where: { cartId_productId: { cartId, productId } },
      data: { quantity },
    });
  }

  async removeItem(cartId: string, productId: string): Promise<void> {
    await prisma.cartItem.deleteMany({
      where: { cartId, productId },
    });
  }

  async save(cart: CartRecord): Promise<void> {
    // Replace line items + status atomically (status transition e.g. OPEN → CONVERTED).
    await prisma.$transaction(async (tx) => {
      await tx.cart.update({
        where: { id: cart.id },
        data: { status: cart.status, ...(cart.storeId ? { storeId: cart.storeId } : {}) },
      });
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      if (cart.lines.length > 0) {
        await tx.cartItem.createMany({
          data: cart.lines.map((l) => ({
            cartId: cart.id,
            storeId: cart.storeId,
            productId: l.productId,
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
          })),
        });
      }
    }, { timeout: 30_000 }); // remote managed Postgres: a cold pooler connection can exceed the 5s default
  }
}

export class PrismaOrderSequenceRepository implements OrderSequenceRepository {
  async nextOrderSequence(storeId: string): Promise<number> {
    const counter = await prisma.storeCounter.upsert({
      where: { storeId_kind: { storeId, kind: ORDER_SEQUENCE_KIND } },
      update: { value: { increment: 1 } },
      create: { storeId, kind: ORDER_SEQUENCE_KIND, value: 1 },
    });
    return counter.value;
  }
}

export class PrismaOrderRepository implements OrderRepository {
  private static toRecord(
    o: Awaited<ReturnType<PrismaClient["order"]["findFirst"]>> & {
      items: {
        productId: string | null;
        productName: string;
        sku: string;
        unitPriceMinor: number;
        quantity: number;
        lineTotalMinor: number;
      }[];
      claimTokens: { token: string; usedAt: Date | null }[];
    },
  ): OrderRecord {
    const liveClaim = o.claimTokens
      .filter((t) => !t.usedAt)
      .sort((a, b) => (a.token < b.token ? -1 : 1))[0];
    return {
      id: o.id,
      orderNumber: o.orderNumber,
      storeId: o.storeId,
      status: o.status,
      currencyCode: o.currencyCode,
      subtotalMinor: o.subtotalMinor,
      deliveryFeeMinor: o.deliveryFeeMinor,
      discountMinor: o.discountMinor,
      totalMinor: o.totalMinor,
      snapshot: o.snapshot,
      paymentMethod: o.paymentMethod,
      paymentStatus: o.paymentStatus,
      idempotencyKey: o.idempotencyKey ?? "",
      cartToken: o.cartToken,
      customerName: o.customerName,
      customerPhone: o.customerPhone,
      deliveryAddressLine1: o.deliveryAddressLine1,
      deliveryAddressLine2: o.deliveryAddressLine2,
      landmark: o.landmark,
      deliverySchedule: o.deliverySchedule,
      notes: o.notes,
      claimToken: liveClaim?.token ?? null,
      storeCustomerId: o.storeCustomerId ?? null,
      items: o.items,
      createdAt: o.createdAt,
    };
  }

  async create(order: OrderRecord): Promise<OrderRecord> {
    const created = await prisma.$transaction(async (tx) => {
      const o = await tx.order.create({
        data: {
          id: order.id,
          orderNumber: order.orderNumber,
          storeId: order.storeId,
          status: order.status as OrderStatus,
          currencyCode: order.currencyCode,
          deliveryType: order.deliveryType ?? "delivery",
          fulfillmentType: order.deliveryType === "pickup" ? "PICKUP" : "DELIVERY", // M3: explicit
          subtotalMinor: order.subtotalMinor,
          deliveryFeeMinor: order.deliveryFeeMinor,
          discountMinor: order.discountMinor,
          totalMinor: order.totalMinor,
          // M4: the tax breakdown travels with the order into the DB (not just the domain record).
          vatableMinor: order.vatableMinor ?? 0,
          vatMinor: order.vatMinor ?? 0,
          vatExemptMinor: order.vatExemptMinor ?? 0,
          vatRateBp: order.vatRateBp ?? 0,
          snapshot: order.snapshot as object,
          paymentMethod: order.paymentMethod,
          paymentStatus: order.paymentStatus as PaymentStatus,
          idempotencyKey: order.idempotencyKey,
          cartToken: order.cartToken,
          customerName: order.customerName,
          customerPhone: order.customerPhone,
          deliveryAddressLine1: order.deliveryAddressLine1,
          deliveryAddressLine2: order.deliveryAddressLine2,
          landmark: order.landmark,
          deliverySchedule: order.deliverySchedule,
          notes: order.notes,
          storeCustomerId: order.storeCustomerId ?? undefined,
        },
      });

      if (order.items.length > 0) {
        await tx.orderItem.createMany({
          data: order.items.map((i) => ({
            orderId: o.id,
            storeId: order.storeId,
            productId: i.productId,
            productName: i.productName,
            sku: i.sku,
            unitPriceMinor: i.unitPriceMinor,
            quantity: i.quantity,
            lineTotalMinor: i.lineTotalMinor,
          })),
        });
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId: o.id,
          storeId: order.storeId,
          toStatus: order.status as OrderStatus,
          actorType: "system",
        },
      });

      if (order.claimToken) {
        await tx.orderClaimToken.create({
          data: {
            orderId: o.id,
            storeId: order.storeId,
            token: order.claimToken,
            expiresAt: new Date(Date.now() + CLAIM_TOKEN_TTL_DAYS * 86_400_000),
          },
        });
      }

      return o;
    });

    return {
      ...order,
      id: created.id,
    };
  }

  /** Module 5 — checkout order + ALL side effects in ONE transaction (no partial outcomes). */
  async createAtomic(order: OrderRecord, effects: AtomicCheckoutEffects): Promise<OrderRecord> {
    const created = await prisma.$transaction(async (tx) => {
      const o = await tx.order.create({
        data: {
          id: order.id,
          orderNumber: order.orderNumber,
          storeId: order.storeId,
          status: order.status as OrderStatus,
          currencyCode: order.currencyCode,
          deliveryType: order.deliveryType ?? "delivery",
          fulfillmentType: order.deliveryType === "pickup" ? "PICKUP" : "DELIVERY",
          subtotalMinor: order.subtotalMinor,
          deliveryFeeMinor: order.deliveryFeeMinor,
          discountMinor: order.discountMinor,
          totalMinor: order.totalMinor,
          // M4: the tax breakdown travels with the order into the DB (not just the domain record).
          vatableMinor: order.vatableMinor ?? 0,
          vatMinor: order.vatMinor ?? 0,
          vatExemptMinor: order.vatExemptMinor ?? 0,
          vatRateBp: order.vatRateBp ?? 0,
          snapshot: order.snapshot as object,
          paymentMethod: order.paymentMethod,
          paymentStatus: order.paymentStatus as PaymentStatus,
          idempotencyKey: order.idempotencyKey,
          cartToken: order.cartToken,
          customerName: order.customerName,
          customerPhone: order.customerPhone,
          deliveryAddressLine1: order.deliveryAddressLine1,
          deliveryAddressLine2: order.deliveryAddressLine2,
          landmark: order.landmark,
          deliverySchedule: order.deliverySchedule,
          notes: order.notes,
          storeCustomerId: order.storeCustomerId ?? undefined,
        },
      });

      if (order.items.length > 0) {
        await tx.orderItem.createMany({
          data: order.items.map((i) => ({
            orderId: o.id,
            storeId: order.storeId,
            productId: i.productId,
            productName: i.productName,
            sku: i.sku,
            unitPriceMinor: i.unitPriceMinor,
            quantity: i.quantity,
            lineTotalMinor: i.lineTotalMinor,
          })),
        });
      }

      await tx.orderStatusHistory.create({
        data: { orderId: o.id, storeId: order.storeId, toStatus: order.status as OrderStatus, actorType: "system" },
      });

      if (order.claimToken) {
        await tx.orderClaimToken.create({
          data: { orderId: o.id, storeId: order.storeId, token: order.claimToken, expiresAt: new Date(Date.now() + CLAIM_TOKEN_TTL_DAYS * 86_400_000) },
        });
      }

      // 1) Reserve stock — CONDITIONAL WRITE at the database boundary. The guard
      //    (`available = quantityOnHand - quantityReserved >= qty`) is what makes
      //    "two buyers, one last unit" safe: the loser's UPDATE matches 0 rows and
      //    the whole transaction rolls back. Products with NO level rows are
      //    untracked and keep the legacy no-op.
      for (const r of effects.stockReservations ?? []) {
        if (r.quantity <= 0) continue;
        const levels = await tx.stockLevel.findMany({ where: { storeId: order.storeId, productId: r.productId } });
        if (levels.length === 0) continue;
        levels.sort((a, b) => (a.warehouseId ? 0 : 1) - (b.warehouseId ? 0 : 1));
        let remaining = r.quantity;
        for (const lvl of levels) {
          if (remaining <= 0) break;
          const rows = await tx.$executeRawUnsafe(
            'UPDATE "StockLevel" SET "quantityReserved" = "quantityReserved" + $2 WHERE "id" = $1 AND ("quantityOnHand" - "quantityReserved") >= $2',
            lvl.id,
            remaining,
          );
          if (rows === 1) {
            const fresh = await tx.stockLevel.findUnique({ where: { id: lvl.id }, select: { quantityReserved: true } });
            await tx.stockMovement.create({
              data: { storeId: order.storeId, productId: r.productId, warehouseId: lvl.warehouseId, delta: remaining, type: "RESERVE", orderId: o.id, createdBy: "checkout", balanceAfter: fresh?.quantityReserved ?? null },
            });
            remaining = 0;
          }
        }
        if (remaining > 0) {
          throw new InsufficientStockError(r.productId, remaining);
        }
      }
      // 2) Convert the cart (guarded to OPEN — a concurrent retry is a no-op here)
      if (effects.cart) {
        await tx.cart.updateMany({
          where: { token: effects.cart.token, storeId: effects.cart.storeId, status: "OPEN" },
          data: { status: "CONVERTED" },
        });
      }

      // 3) Voucher redemption row (GUAURDED atomic counter — single UPDATE, safe under
      // the transaction pooler; two concurrent checkouts CANNOT both pass the limit)
      if (effects.voucherRedemption) {
        const consumed = await tx.$executeRawUnsafe(
          'UPDATE "Voucher" SET "usedCount" = "usedCount" + 1 WHERE "id" = $1 AND ("maxRedemptions" IS NULL OR "usedCount" < "maxRedemptions")',
          effects.voucherRedemption.voucherId,
        );
        if (consumed === 0) throw new Error("Voucher redemption limit reached");
        await tx.voucherRedemption.create({
          data: { voucherId: effects.voucherRedemption.voucherId, storeId: order.storeId, orderId: o.id },
        });
      }

      // 4) Loyalty: guarded atomic deduction (single UPDATE) + ledger entry
      if (effects.loyalty) {
        const consumed = await tx.$executeRawUnsafe(
          'UPDATE "StoreCustomer" SET "loyaltyBalancePoints" = "loyaltyBalancePoints" - $2 WHERE "id" = $1 AND "loyaltyBalancePoints" >= $2',
          effects.loyalty.storeCustomerId,
          effects.loyalty.points,
        );
        if (consumed === 0) throw new Error("Insufficient loyalty points");
        const sc = await tx.storeCustomer.findUnique({ where: { id: effects.loyalty.storeCustomerId } });
        await tx.loyaltyEntry.create({
          data: {
            storeId: order.storeId,
            customerId: effects.loyalty.customerId,
            storeCustomerId: effects.loyalty.storeCustomerId,
            type: "REDEEM",
            points: -effects.loyalty.points,
            balanceAfter: sc?.loyaltyBalancePoints ?? 0,
            orderId: o.id,
            description: "checkout redemption",
          },
        });
      }

      // 5) Credit purchase: guarded atomic balance increment (single UPDATE) + ledger entry
      if (effects.credit) {
        const consumed = await tx.$executeRawUnsafe(
          'UPDATE "StoreCustomer" SET "creditBalanceMinor" = "creditBalanceMinor" + $2 WHERE "id" = $1 AND ("creditLimitMinor" IS NULL OR "creditLimitMinor" <= 0 OR "creditBalanceMinor" + $2 <= "creditLimitMinor")',
          effects.credit.storeCustomerId,
          effects.credit.amountMinor,
        );
        if (consumed === 0) throw new Error("Credit limit exceeded");
        const sc = await tx.storeCustomer.findUnique({ where: { id: effects.credit.storeCustomerId } });
        if (!sc) throw new Error("Credit customer not found");
        await tx.creditEntry.create({
          data: {
            storeId: order.storeId,
            storeCustomerId: sc.id,
            orderId: o.id,
            type: "purchase",
            amountMinor: effects.credit.amountMinor,
            startAt: new Date(),
            dueAt: new Date(Date.now() + 30 * 86_400_000),
            createdBy: "checkout",
          },
        });
      }

      // 6) Outbox (Module 9 fix): the notification event is written INSIDE this
      //    transaction, so a committed order ALWAYS has its event — there is no
      //    crash window where the order exists but the notification was never
      //    enqueued. The worker drains it asynchronously with retries.
      await tx.outboxEvent.create({
        data: {
          storeId: order.storeId,
          aggregateType: "order",
          aggregateId: o.id,
          eventType: "order.received",
          payload: {
            orderNumber: o.orderNumber,
            psid: null,
            text: `Order ${o.orderNumber} received — total ${(order.totalMinor / 100).toFixed(2)} ${order.currencyCode}.`,
          } as object,
        },
      });

      return o;
    }, { timeout: 30_000 });

    return { ...order, id: created.id };
  }

  async findByIdempotencyKey(key: string): Promise<OrderRecord | null> {
    const o = await prisma.order.findUnique({
      where: { idempotencyKey: key },
      include: {
        items: true,
        claimTokens: { select: { token: true, usedAt: true } },
      },
    });
    return o ? PrismaOrderRepository.toRecord(o) : null;
  }

  async markClaimTokenUsed(orderId: string, token: string): Promise<void> {
    await prisma.orderClaimToken.updateMany({
      where: { orderId, token },
      data: { usedAt: new Date() },
    });
  }
}