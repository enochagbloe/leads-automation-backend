import { demoMessageService } from "../services/demo-message.service";
import { processLatestDemoReply } from "../services/demo-ai-processing.service";
import { AppError } from "../utils/errors";
import { Router } from "express";
import { authenticateDemo } from "../middleware/demo-auth";
import { demoSetupService } from "../services/demo-setup.service";
import { demoCreationLimiter, demoSetupIpLimiter, demoSetupSessionLimiter, demoMessageLimiter, mutationLimiter } from "../middleware/rate-limit";
import { assertDemoEnabled, demoService } from "../services/demo.service";
export const demoRouter = Router();

demoRouter.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
demoRouter.post("/session", (_req, _res, next) => { try { assertDemoEnabled(); next(); } catch (error) { next(error); } }, demoCreationLimiter, async (req, res) => {
  res.status(201).json(await demoService.create(req.ip ?? "unknown", req.get("idempotency-key")));
});
demoRouter.get("/session", authenticateDemo, async (req, res) => { res.json(await demoService.get(req.demo!)); });
demoRouter.delete("/session", authenticateDemo, mutationLimiter, async (req, res) => {
  await demoService.destroy(req.demo!.demoSessionId);
  res.json({ success: true });
});

demoRouter.post("/session/setup", authenticateDemo, demoSetupIpLimiter, demoSetupSessionLimiter, async (req, res) => {
  res.json(await demoSetupService.setup(req.demo!, req.body));
});

demoRouter.post("/session/messages", authenticateDemo, demoMessageLimiter, async (req, res) => {
  res.json(await demoMessageService.create(req.demo!, req.body));
});
demoRouter.get("/session/messages", authenticateDemo, async (req, res) => {
  res.json(await demoMessageService.list(req.demo!));
});

demoRouter.post("/session/ai/process-latest", authenticateDemo, demoMessageLimiter, async (req, res) => {
  if (Object.keys(req.body ?? {}).length || Object.keys(req.query).length) throw new AppError(400, "Demo AI processing accepts no resource parameters", "DEMO_AI_INPUT_INVALID");
  res.json(await processLatestDemoReply(req.demo!));
});
