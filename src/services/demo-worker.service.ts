import { env } from "../config/env";
import { demoService } from "./demo.service";
let timer: NodeJS.Timeout | undefined;
let running: Promise<void> | undefined;
export const demoWorkerService = {
  start() {
    if (timer) return;
    const tick = () => {
      if (!running) running = demoService.cleanup().catch(() => { console.error("Demo cleanup sweep failed"); }).finally(() => { running = undefined; });
    };
    tick();
    timer = setInterval(tick, env.DEMO_CLEANUP_INTERVAL_SECONDS * 1000);
    timer.unref();
  },
  async stop() { clearInterval(timer); timer = undefined; await running; },
};
