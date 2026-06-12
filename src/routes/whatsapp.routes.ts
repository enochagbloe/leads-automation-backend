import { Router } from "express";
import { whatsappController } from "../controllers/whatsapp.controller";
import { mutationLimiter } from "../middleware/rate-limit";
import { validate } from "../middleware/validate";
import { mockWhatsAppInboundSchema, mockWhatsAppStatusSchema } from "../validation/whatsapp.schemas";

export const whatsappWebhookRouter = Router();
whatsappWebhookRouter.get("/", whatsappController.verify);
whatsappWebhookRouter.post("/", whatsappController.receive);

export const mockWhatsAppRouter = Router();
mockWhatsAppRouter.post("/inbound-message", mutationLimiter, validate(mockWhatsAppInboundSchema), whatsappController.mockInbound);
mockWhatsAppRouter.post("/status-update", mutationLimiter, validate(mockWhatsAppStatusSchema), whatsappController.mockStatus);
