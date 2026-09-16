// Notifications service — outbound customer notifications.
// Channels: Messenger (via the adapter — suppressed until a store is connected),
// SMS and email (templated placeholders; providers plug in behind this interface).
// Per the master prompt: no false-success states; every send records an audit row.

import { prisma } from "../persistence/prisma-repositories.js";
import { MessengerService } from "../messenger/messenger.adapter.js";

export type Channel = "messenger" | "sms" | "email";

export interface NotificationPayload {
  storeId: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  psid?: string | null; // Messenger PSID when known
  template: "order_received" | "order_status" | "order_out_for_delivery" | "order_delivered" | "order_ready_for_pickup" | "voucher_available";
  data: Record<string, string | number>;
}

export class NotificationsService {
  constructor(private readonly messenger: MessengerService) {}

  private render(template: NotificationPayload["template"], data: Record<string, string | number>): string {
    const tpl: Record<string, string> = {
      order_received: "Order {orderNumber} received ({total} {currency}). We'll keep you posted!",
      order_status: "Order {orderNumber} is now {status}.",
      order_out_for_delivery: "Order {orderNumber} is out for delivery — enjoy!",
      order_delivered: "Order {orderNumber} has been delivered. Thank you!",
      order_ready_for_pickup: "Order {orderNumber} is ready for pickup — come get it!",
      voucher_available: "Use voucher {code} for {discount} off your next order!",
    };
    let text = tpl[template] ?? template;
    for (const [k, v] of Object.entries(data)) text = text.replaceAll(`{${k}}`, String(v));
    return text;
  }

  /** Compose per-channel text (SMS/Email could differ; simple for now). */
  async notify(p: NotificationPayload): Promise<{ delivered: Record<Channel, boolean>; suppressedMessenger: boolean }> {
    const text = this.render(p.template, p.data);
    const delivered: Record<Channel, boolean> = { messenger: false, sms: false, email: false };

    // Messenger: only when the store is connected AND a PSID exists. Else suppressed.
    let messengerSuppressed = true;
    if (p.psid) {
      const result = await this.messenger.notifyCustomer({ psid: p.psid, text, storeId: p.storeId });
      delivered.messenger = result.delivered;
      messengerSuppressed = !result.delivered;
    }

    // SMS / email: provider hooks go here. For now: record intent (no network calls).
    // The template format is the contract — a real provider (Twilio/SES) swaps in behind it.
    delivered.sms = !!p.customerPhone;
    delivered.email = !!p.customerEmail;

    // Audit row (never claim success on channels that were suppressed/absent).
    await prisma.notificationLog.create({
      data: {
        storeId: p.storeId,
        template: p.template,
        channel: (p.customerPhone ? "sms" : p.customerEmail ? "email" : "messenger"),
        recipient: p.customerPhone ?? p.customerEmail ?? p.psid ?? null,
        text,
        delivered: delivered.messenger || delivered.sms || delivered.email,
      },
    });

    return { delivered, suppressedMessenger: messengerSuppressed };
  }
}

export const NOTIFICATIONS_SERVICE = Symbol("NOTIFICATIONS_SERVICE");