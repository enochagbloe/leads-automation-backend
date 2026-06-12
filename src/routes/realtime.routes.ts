import { Router } from "express";
import { realtimeController } from "../controllers/realtime.controller";
import { authenticate } from "../middleware/auth";
import { requireBusiness } from "../middleware/rbac";

export const realtimeRouter = Router();
realtimeRouter.get("/events", authenticate, requireBusiness, realtimeController.events);
