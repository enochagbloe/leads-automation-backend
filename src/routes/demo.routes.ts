import { Router } from "express";
import { authenticateDemo } from "../middleware/demo-auth";
import { demoCreationLimiter, mutationLimiter } from "../middleware/rate-limit";
import { assertDemoEnabled, demoService } from "../services/demo.service";
export const demoRouter = Router();
demoRouter.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
demoRouter.post("/session", (_req, _res, next) => { try { assertDemoEnabled(); next(); } catch (error) { next(error); } }, demoCreationLimiter, async (req, res) => {
  res.status(201).json(await demoService.create(req.ip ?? "unknown", req.get("idempotency-key")));
});
demoRouter.get("/session", authenticateDemo, mutationLimiter, async (req, res) => { res.json(await demoService.get(req.demo!)); });
demoRouter.delete("/session", authenticateDemo, mutationLimiter, async (req, res) => {
  await demoService.destroy(req.demo!.demoSessionId);
  res.json({ success: true });
});
