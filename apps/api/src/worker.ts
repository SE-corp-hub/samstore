// Standalone transactional-outbox worker for container deployments.
// Live providers remain suppressed/mock until operator credentials are approved.
import "reflect-metadata";
import { OutboxWorker } from "./notifications/outbox.service.js";
import { startUtangReminders } from "./utang/reminders.js";

const worker = new OutboxWorker();
worker.start(Number(process.env.OUTBOX_POLL_MS ?? 5000));
// Rice Ops M6: utang reminder texts, hourly.
const stopReminders = startUtangReminders();

const stop = () => {
  worker.stop();
  stopReminders();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
