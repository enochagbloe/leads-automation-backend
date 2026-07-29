import "dotenv/config";

import { app } from "./app";
import { env } from "./config/env";
import { prisma } from "./config/prisma";
import { followUpWorkerService } from "./services/follow-up/follow-up-worker.service";
import { customerMemoryWorkerService } from "./services/customer-memory/customer-memory-worker.service";

const server = app.listen(env.PORT, () => console.info(`BizReply AI API listening on port ${env.PORT}`));
followUpWorkerService.start();
customerMemoryWorkerService.start();

async function shutdown(signal: string) {
  console.info(`${signal} received. Shutting down.`);
  followUpWorkerService.stop();
  customerMemoryWorkerService.stop();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
