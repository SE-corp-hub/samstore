// Delivery taps from SE Corp Hub. The hub's delivery team (a driver and helpers) work from the hub's Deliveries
// page. An order that came from the hub is changed here, not there, so the hub keeps their "On the way" and
// "Delivered" taps and offers them on our usual beat (integrations/hub-orders.service.ts). Here a tap moves the
// order through the same steps the Orders and Delivery screens use, and the next `updates` we send tell the hub.

// Framework-free like the hub door itself: the app hands in how to find an order and the two services that move one.

import type { OrderAdminService } from "../admin/order-admin.service.js";
import type { DeliveryService } from "../delivery/delivery.service.js";

/** One tap as the hub offers it. `by` is the hub login that tapped, `cashMinor` the cash they typed (cash on delivery). */
export interface HubTap {
  orderNumber: string;
  status: "OUT_FOR_DELIVERY" | "DELIVERED";
  at?: string;
  by?: string;
  cashMinor?: number;
}

/** Acts on a tap for one store: null when done (or already so), else why not, in words for the delivery person. */
export type HubTapApplier = (storeId: string, tap: HubTap) => Promise<string | null>;

export type TapStep = "send" | "retry" | "deliver";

/**
 * What a tap asks of an order as it stands now: the steps to take, in order. No steps = the order is already
 * there, so the same tap offered twice changes nothing. A tap never confirms, un-cancels or un-delivers an order.
 */
export function tapSteps(orderStatus: string, tap: HubTap["status"]): { ok: true; steps: TapStep[] } | { ok: false; error: string } {
  const deliver: TapStep[] = tap === "DELIVERED" ? ["deliver"] : [];
  switch (orderStatus) {
    case "DELIVERED":
    case "COMPLETED":
      return { ok: true, steps: [] };
    case "OUT_FOR_DELIVERY":
      return { ok: true, steps: deliver };
    case "CONFIRMED":
    case "PREPARING":
    case "READY":
      return { ok: true, steps: ["send", ...deliver] };
    case "FAILED_DELIVERY":
      return { ok: true, steps: ["retry", ...deliver] };
    case "RECEIVED":
      return { ok: false, error: "Sam Store has not confirmed this order yet. Confirm it in Sam Store first" };
    case "CANCELLED":
      return { ok: false, error: "This order is cancelled in Sam Store" };
    default:
      return { ok: false, error: `This order is ${orderStatus.toLowerCase().replaceAll("_", " ")} in Sam Store` };
  }
}

/** The line on the order's history that says the step came from the hub, and who tapped. */
export function tapNote(tap: Pick<HubTap, "status" | "by">): string {
  return `Tapped ${tap.status === "DELIVERED" ? "Delivered" : "On the way"} in the hub${tap.by ? ` by ${tap.by}` : ""}`;
}

/** One of the store's own orders that the hub handed over, by its number: a number from elsewhere is simply not found. */
export type FindHubOrder = (storeId: string, orderNumber: string) => Promise<{ id: string; status: string } | null>;

/** Finds the store's own hub order by its number and walks it through the steps. */
export function hubTapApplier(
  find: FindHubOrder,
  admin: Pick<OrderAdminService, "sendForDelivery">,
  delivery: Pick<DeliveryService, "retryDelivery" | "markStatus">,
): HubTapApplier {
  return async (storeId, tap) => {
    const order = await find(storeId, tap.orderNumber);
    if (!order) return "Sam Store has no hub order with this number";
    const plan = tapSteps(order.status, tap.status);
    if (!plan.ok) return plan.error;
    const note = tapNote(tap);
    for (const step of plan.steps) {
      const r =
        step === "send"
          ? await admin.sendForDelivery(storeId, order.id, note)
          : step === "retry"
            ? await delivery.retryDelivery(storeId, order.id, note)
            : await delivery.markStatus(storeId, order.id, "DELIVERED", undefined, {
                ...(tap.cashMinor !== undefined ? { cashCollectedMinor: tap.cashMinor } : {}),
                via: note,
              });
      if (!r.ok) return "message" in r.error ? r.error.message : r.error.errors.join("; ");
    }
    return null;
  };
}
