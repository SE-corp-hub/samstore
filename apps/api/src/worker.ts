// Standalone transactional-outbox worker for container deployments.
// Live providers remain suppressed/mock until operator credentials are approved.
import "reflect-metadata";
import { OutboxWorker } from "./notifications/outbox.service.js";

const worker = new OutboxWorker();
worker.start(Number(process.env.OUTBOX_POLL_MS ?? 5000));

const stop = () => {
  worker.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
