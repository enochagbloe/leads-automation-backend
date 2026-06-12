import { BusinessRole } from "@prisma/client";
import { Router } from "express";
import { whatsappConnectionController } from "../controllers/whatsapp-connection.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness, requireRole } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import {
  completeWhatsAppConnectionSchema,
  deactivateWhatsAppConnectionSchema,
  startWhatsAppConnectionSchema,
} from "../validation/whatsapp.schemas";

export const whatsappConnectionRouter = Router();

whatsappConnectionRouter.use(authenticate, requireBusiness);
whatsappConnectionRouter.get("/status", whatsappConnectionController.status);
whatsappConnectionRouter.get("/health", whatsappConnectionController.health);
whatsappConnectionRouter.post("/connect/start", requireRole(BusinessRole.BUSINESS_OWNER), mutationLimiter, validate(startWhatsAppConnectionSchema), whatsappConnectionController.start);
whatsappConnectionRouter.post("/connect/complete", requireRole(BusinessRole.BUSINESS_OWNER), mutationLimiter, validate(completeWhatsAppConnectionSchema), whatsappConnectionController.complete);
whatsappConnectionRouter.post("/deactivate", requireRole(BusinessRole.BUSINESS_OWNER), mutationLimiter, validate(deactivateWhatsAppConnectionSchema), whatsappConnectionController.deactivate);
whatsappConnectionRouter.post("/change/start", requireRole(BusinessRole.BUSINESS_OWNER), mutationLimiter, whatsappConnectionController.startChange);
