import { Module } from "@nestjs/common";
import { CHECKOUT_SERVICE, CheckoutService } from "./checkout/checkout.service.js";
import { CheckoutController } from "./checkout/checkout.controller.js";
import { PublicStoreController } from "./public/public-store.controller.js";
import { PublicStoreService } from "./public/public-store.service.js";
import { CartController } from "./cart/cart.controller.js";
import { CartService, CART_SERVICE } from "./cart/cart.service.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthService, AUTH_SERVICE } from "./auth/auth.service.js";
import { PrismaAuthRepository } from "./auth/auth.repository.js";
import { AdminController } from "./admin/admin.controller.js";
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
import { CreditService, CREDIT_SERVICE } from "./credit/credit.service.js";
import { CreditController } from "./credit/credit.controller.js";
import { ExpensesService, EXPENSES_SERVICE } from "./expenses/expenses.service.js";
import { ExpensesController } from "./expenses/expenses.controller.js";
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
} from "./persistence/prisma-repositories.js";

const CLAIM_SECRET = process.env.CLAIM_SIGNING_SECRET ?? "dev-only-in-memory-secret-0123456789";

@Module({
  controllers: [CheckoutController, PublicStoreController, CartController, AuthController, AdminController, OrderLookupController, CustomerAuthController, PosController, PaymentsController, CreditController, ExpensesController, PurchasesController, InventoryController, ReportsController, DeliveryController, HealthController, RegisterController, RolePermissionsController, AddressController],
  providers: [
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
            jwtSecret: process.env.JWT_SECRET ?? "dev-jwt-secret-change-me-0123456789",
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
            jwtSecret: process.env.JWT_SECRET ?? "dev-jwt-secret-change-me-0123456789",
            jwtExpiresIn: "7d",
          } as AuthConfig,
        ),
    },
    {
      provide: "AUTH_CONFIG",
      useValue: { jwtSecret: process.env.JWT_SECRET ?? "dev-jwt-secret-change-me-0123456789" },
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
                jwtSecret: process.env.JWT_SECRET ?? "dev-jwt-secret-change-me-0123456789",
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
  ],
  exports: [CHECKOUT_SERVICE, "MESSENGER_SERVICE"],
})
export class AppModule {}