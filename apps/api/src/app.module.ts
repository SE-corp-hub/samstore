import { freeOnShelves } from "./domain/sources.js";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { WallInterceptor } from "./auth/wall.interceptor.js";
import { Module } from "@nestjs/common";
import { claimSecret, jwtSecret } from "./security/secrets.js";
import { CHECKOUT_SERVICE, CheckoutService } from "./checkout/checkout.service.js";
import { CheckoutController } from "./checkout/checkout.controller.js";
import { HubOrdersController } from "./integrations/hub-orders.controller.js";
import { HUB_ORDER_SERVICE, HubOrderService } from "./integrations/hub-orders.service.js";
import { PublicStoreController } from "./public/public-store.controller.js";
import { PublicStoreService } from "./public/public-store.service.js";
import { CartController } from "./cart/cart.controller.js";
import { CartService, CART_SERVICE } from "./cart/cart.service.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthService, AUTH_SERVICE } from "./auth/auth.service.js";
import { PrismaAuthRepository } from "./auth/auth.repository.js";
import { AdminController } from "./admin/admin.controller.js";
import { PeopleController } from "./people/people.controller.js";
import { TransferFlowController } from "./transfers/transfer-flow.controller.js";
import { ResackController } from "./resack/resack.controller.js";
import { BentaController } from "./selling/benta.controller.js";
import { UtangController } from "./utang/utang.controller.js";
import { AgentOrderController } from "./agent/agent-order.controller.js";
import { CountController } from "./counts/count.controller.js";
import { RiceReportsController } from "./reports/rice-reports.controller.js";
import { PayableController } from "./payable/payable.controller.js";
import { PurchaseOrderController } from "./purchase-orders/purchase-order.controller.js";
import { JwtAuthGuard } from "./auth/auth.guard.js";
import type { AuthConfig } from "./auth/auth.domain.js";
import { MessengerService, SuppressedMessengerProvider } from "./messenger/messenger.adapter.js";
import { OrderLookupService, ORDER_LOOKUP_SERVICE } from "./orders/order-lookup.service.js";
import { OrderLookupController } from "./orders/order-lookup.controller.js";
import { VoucherPublicService } from "./voucher/voucher-public.service.js";
import { CustomerAuthService, CUSTOMER_AUTH_SERVICE } from "./auth/customer-auth.service.js";
import { CustomerAuthController } from "./auth/customer-auth.controller.js";
import { LoyaltyService, LOYALTY_SERVICE } from "./loyalty/loyalty.service.js";
import { NotificationsService, NOTIFICATIONS_SERVICE } from "./notifications/notifications.service.js";
import { PosService, POS_SERVICE } from "./pos/pos.service.js";
import { PosController } from "./pos/pos.controller.js";
import { RegisterController } from "./registers/register.controller.js";
import { RegisterService, REGISTER_SERVICE } from "./registers/register.service.js";
import { SplitPaymentService, SPLIT_PAYMENT_SERVICE } from "./payments/split-payment.service.js";
import { PaymentsService, PAYMENTS_SERVICE } from "./payments/payments.service.js";
import { PaymentsController } from "./payments/payments.controller.js";
import { PaymentsWebhookController } from "./payments/payments-webhook.controller.js";
import { DeliveryZonesAdminController } from "./delivery/zones-admin.controller.js";
import { DeliveryBookingsAdminController } from "./delivery/delivery-booking-admin.controller.js";
import { MessengerConnectionAdminController } from "./messenger/connection-admin.controller.js";
import { ChatbotAdminController } from "./chatbot/chatbot-admin.controller.js";
import { ChatAgentAdminController } from "./chatbot/agent-admin.controller.js";
import { CrmAdminController } from "./crm/crm-admin.controller.js";
import { ErpAdminController } from "./erp/erp-admin.controller.js";
import { BirAdminController } from "./erp/bir-admin.controller.js";
import { SecurityIncidentAdminController } from "./security/breach-admin.controller.js";
import { CreditService, CREDIT_SERVICE } from "./credit/credit.service.js";
import { CreditController } from "./credit/credit.controller.js";
import { ExpensesService, EXPENSES_SERVICE } from "./expenses/expenses.service.js";
import { ExpensesController } from "./expenses/expenses.controller.js";
import { DataExportController } from "./export/data-export.controller.js";
import { PurchasesService, PURCHASES_SERVICE } from "./purchases/purchases.service.js";
import { PurchasesController } from "./purchases/purchases.controller.js";
import { SUPPLIERS_SERVICE, SuppliersService } from "./purchases/suppliers.service.js";
import { RolePermissionsController } from "./admin/role-permissions.controller.js";
import { InventoryService, INVENTORY_SERVICE } from "./inventory/inventory.service.js";
import { InventoryController } from "./inventory/inventory.controller.js";
import { ReportsService, REPORTS_SERVICE } from "./reports/reports.service.js";
import { ReportsController } from "./reports/reports.controller.js";
import { DeliveryService, DELIVERY_SERVICE } from "./delivery/delivery.service.js";
import { DeliveryController } from "./delivery/delivery.controller.js";
import { AddressService, ADDRESS_GATEWAY } from "./address/address.service.js";
import { AddressController } from "./address/address.controller.js";
import { HealthController } from "./health/health.controller.js";
import { verifyToken } from "./auth/auth.domain.js";
import {
  PrismaStoreRepository,
  PrismaCatalogRepository,
  PrismaCartRepository,
  PrismaOrderRepository,
  PrismaOrderSequenceRepository,
  prisma,
} from "./persistence/prisma-repositories.js";

const CLAIM_SECRET = claimSecret(); // M11: no committed fallback (see security/secrets.ts)

@Module({
    controllers: [CheckoutController, HubOrdersController, PublicStoreController, CartController, AuthController, AdminController, PeopleController, TransferFlowController, ResackController, BentaController, UtangController, AgentOrderController, CountController, RiceReportsController, PayableController, PurchaseOrderController, OrderLookupController, CustomerAuthController, PosController, PaymentsController, PaymentsWebhookController, DeliveryZonesAdminController, DeliveryBookingsAdminController, MessengerConnectionAdminController, ChatbotAdminController, ChatAgentAdminController, CrmAdminController, ErpAdminController, BirAdminController, SecurityIncidentAdminController, CreditController, ExpensesController, DataExportController, PurchasesController, InventoryController, ReportsController, DeliveryController, HealthController, RegisterController, RolePermissionsController, AddressController],
  providers: [
    // Per-store build, step 6: every signed-in request runs behind its store's wall.
    { provide: APP_INTERCEPTOR, useClass: WallInterceptor },
    {
      provide: DELIVERY_SERVICE,
      useFactory: () => new DeliveryService(),
    },
    {
      provide: ADDRESS_GATEWAY,
      useFactory: () => new AddressService(),
    },
    {
      provide: REPORTS_SERVICE,
      useFactory: () => new ReportsService(),
    },
    {
      provide: INVENTORY_SERVICE,
      useFactory: () => new InventoryService(),
    },
    {
      provide: EXPENSES_SERVICE,
      useFactory: () => new ExpensesService(),
    },
    {
      provide: PURCHASES_SERVICE,
      useFactory: () => new PurchasesService(),
    },
    {
      provide: SUPPLIERS_SERVICE,
      useFactory: () => new SuppliersService(),
    },
    {
      provide: CREDIT_SERVICE,
      useFactory: () => new CreditService(),
    },
    {
      provide: PAYMENTS_SERVICE,
      useFactory: () => new PaymentsService(),
    },
    {
      provide: POS_SERVICE,
      useFactory: (registers: RegisterService) => new PosService(new LoyaltyService(), registers),
      inject: [REGISTER_SERVICE],
    },
    {
      provide: REGISTER_SERVICE,
      useFactory: () => new RegisterService(),
    },
    {
      provide: SPLIT_PAYMENT_SERVICE,
      useFactory: () => new SplitPaymentService(),
    },
    {
      provide: CUSTOMER_AUTH_SERVICE,
      useFactory: () =>
        new CustomerAuthService(
          {
            jwtSecret: jwtSecret(),
            jwtExpiresIn: "30d",
          },
          new AddressService(),
        ),
    },
    {
      provide: LOYALTY_SERVICE,
      useFactory: () => new LoyaltyService(),
    },
    {
      provide: NOTIFICATIONS_SERVICE,
      inject: ["MESSENGER_SERVICE"],
      useFactory: (messenger: MessengerService) => new NotificationsService(messenger),
    },
    {
      provide: ORDER_LOOKUP_SERVICE,
      useFactory: () => new OrderLookupService(CLAIM_SECRET),
    },
    {
      provide: AUTH_SERVICE,
      useFactory: () =>
        new AuthService(
          new PrismaAuthRepository(),
          {
            jwtSecret: jwtSecret(),
            // Staff phones stay signed in for 30 days. A PIN reset or deactivating
            // the person still cuts the old token off at once (tokenVersion / active check).
            jwtExpiresIn: "30d",
          } as AuthConfig,
        ),
    },
    {
      provide: "AUTH_CONFIG",
      useValue: { jwtSecret: jwtSecret() },
    },
    JwtAuthGuard,
    PublicStoreService,
    {
      provide: CART_SERVICE,
      useFactory: () => new CartService(new PrismaCartRepository(), new PrismaCatalogRepository()),
    },
    {
      provide: "MESSENGER_SERVICE",
      // No store is connected yet → all sends suppressed (spec-mandated default).
      useFactory: () => new MessengerService(new SuppressedMessengerProvider(), () => false),
    },
    {
      provide: "VOUCHER_PUBLIC_SERVICE",
      useFactory: () => new VoucherPublicService(),
    },
    {
      // CheckoutService is framework-free by design (tests construct it directly).
      // Prisma-backed repositories hit the real Postgres (Supabase).
      provide: CHECKOUT_SERVICE,
      inject: ["MESSENGER_SERVICE", "VOUCHER_PUBLIC_SERVICE", LOYALTY_SERVICE, ADDRESS_GATEWAY],
      useFactory: (messenger: MessengerService, voucher: VoucherPublicService, loyalty: LoyaltyService, address: AddressService) => {
      const creditSvc = new CreditService();
      return new CheckoutService(
          new PrismaStoreRepository(),
          new PrismaCatalogRepository(),
          new PrismaCartRepository(),
          new PrismaOrderRepository(),
          new PrismaOrderSequenceRepository(),
          CLAIM_SECRET,
          async (order) => {
            // Post-order Messenger notification (suppressed until a store is connected).
            await messenger.notifyCustomer({
              psid: `order_${order.orderNumber}`,
              text: `Order ${order.orderNumber} received (${order.totalMinor / 100} ${order.currencyCode}).`,
              storeId: order.storeId,
            });
          },
          voucher, // VoucherGateway — validate + redeem at checkout
          loyalty, // LoyaltyGateway — ensure profile, redeem, record
          async (customerToken: string) => {
            // Resolve a customer JWT to a customer id (role must be CUSTOMER).
            try {
              const decoded = verifyToken(customerToken, {
                jwtSecret: jwtSecret(),
                jwtExpiresIn: "30d",
              });
              return decoded.role === "CUSTOMER" ? decoded.sub : null;
            } catch {
              return null;
            }
          },
          {
            // CreditGateway — approved customers pay on utang up to the store limit.
            check: (storeId, storeCustomerId, amountMinor) => creditSvc.checkCredit(storeId, storeCustomerId, amountMinor),
            record: (orderId, storeId, storeCustomerId, amountMinor) => creditSvc.recordPurchase(orderId, storeId, storeCustomerId, amountMinor),
          },
          address, // AddressGateway — PH hierarchy validate + snapshot (P1)
        );
      },
    },
    {
      // The hub door reuses the checkout path, so a hub order reserves stock and numbers itself like any other.
      provide: HUB_ORDER_SERVICE,
      inject: [CHECKOUT_SERVICE],
      useFactory: (checkout: CheckoutService) =>
        new HubOrderService(
          new PrismaStoreRepository(),
          new PrismaCatalogRepository(),
          new PrismaCartRepository(),
          checkout,
          // Placed in the last week or changed lately: an order edited here shows edited in the hub.
          async (storeId, since) =>
            (
              await prisma.order.findMany({
                where: { storeId, source: "hub", OR: [{ updatedAt: { gte: since } }, { createdAt: { gte: new Date(since.getTime() - 4 * 86_400_000) } }] },
                include: {
                  items: true,
                  // The last cancel / failed-delivery reason, so the hub can tell why.
                  statusHistory: { where: { toStatus: { in: ["CANCELLED", "FAILED_DELIVERY"] } }, orderBy: { createdAt: "desc" }, take: 1, select: { reason: true } },
                },
                orderBy: { createdAt: "desc" },
                take: 200,
              })
            ).map((o) => ({
              orderNumber: o.orderNumber,
              status: o.status,
              deliveryType: o.deliveryType,
              totalMinor: o.totalMinor,
              deliveryFeeMinor: o.deliveryFeeMinor,
              discountMinor: o.discountMinor,
              paymentStatus: o.paymentStatus,
              reason: o.statusHistory[0]?.reason ?? null,
              items: o.items.map((i) => ({ name: i.productName, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor })),
            })),
          // The hub link names the selling location by its code (samrice=bigasan@S2).
          async (storeId, code) =>
            (await prisma.warehouse.findFirst({ where: { storeId, code: { equals: code.trim(), mode: "insensitive" }, isActive: true }, select: { id: true } }))?.id ?? null,
          async (storeId, warehouseId) =>
            new Map((await prisma.locationPrice.findMany({ where: { storeId, warehouseId }, select: { productId: true, priceMinor: true } })).map((p) => [p.productId, p.priceMinor])),
          // What the Page's store can still sell: its own shelf and the places on its take-rice-from list.
          (storeId, locationId) => freeOnShelves(prisma, storeId, locationId),
          // The hub's Customers list follows this store's customers: a change to the person (name, phone, address)
          // or to their place in this store (utang, points) counts, whichever came last.
          async (storeId, after, limit) => {
            // The columns hold UTC without a zone, so the point is passed the same way.
            const since = (after.at && !Number.isNaN(Date.parse(after.at)) ? new Date(after.at) : new Date(0)).toISOString().replace("Z", "");
            const rows = await prisma.$queryRaw<
              { id: string; changedAt: Date; name: string | null; phone: string | null; address: string | null; credit: number; points: number }[]
            >`
              SELECT sc."id", GREATEST(sc."updatedAt", c."updatedAt") AS "changedAt", c."name", c."phone", c."address",
                     sc."creditBalanceMinor" AS "credit", sc."loyaltyBalancePoints" AS "points"
                FROM "StoreCustomer" sc JOIN "Customer" c ON c."id" = sc."customerId"
               WHERE sc."storeId" = ${storeId}
                 AND (GREATEST(sc."updatedAt", c."updatedAt"), sc."id") > (CAST(${since} AS timestamp(3)), ${after.id})
               ORDER BY 2, 1
               LIMIT ${limit}`;
            return rows.map((r) => ({
              id: r.id,
              changedAt: r.changedAt.toISOString(),
              name: r.name ?? "",
              phone: r.phone ?? "",
              address: r.address ?? "",
              utangMinor: Math.max(0, r.credit),
              points: r.points,
            }));
          },
        ),
    },
  ],
  exports: [CHECKOUT_SERVICE, "MESSENGER_SERVICE"],
})
export class AppModule {}
