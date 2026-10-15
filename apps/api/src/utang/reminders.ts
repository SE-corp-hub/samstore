// Rice Ops M6 — the hourly reminder tick. Queues the utang reminders that are due, for
// every store, between 8 am and 8 pm Manila time. Idempotent (one text per customer per
// period), so restarts and several workers never double-send.
import { prisma } from "../persistence/prisma-repositories.js";
import { UtangService } from "./utang.service.js";

export function startUtangReminders(intervalMs = 3_600_000): () => void {
  if (process.env.UTANG_REMINDERS === "false") return () => {};
  const svc = new UtangService();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    const hour = new Date(Date.now() + 8 * 3_600_000).getUTCHours(); // Manila (UTC+8, no DST)
    if (hour < 8 || hour >= 20) return;
    busy = true;
    try {
      const stores = await prisma.storeCustomer.findMany({ where: { creditBalanceMinor: { gt: 0 } }, distinct: ["storeId"], select: { storeId: true } });
      for (const s of stores) {
        try {
          await svc.runReminders(s.storeId);
        } catch {
          /* one store's failure never stops the others; it is retried next hour */
        }
      }
    } catch {
      /* database hiccup: try again next tick */
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  setTimeout(() => void tick(), 60_000).unref?.();
  return () => clearInterval(timer);
}
