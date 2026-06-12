import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { RequestHandler } from "express";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { MockWhatsAppInboundInput, MockWhatsAppStatusInput } from "../validation/whatsapp.schemas";
import { parseMetaStatusWebhook, parseMetaWebhook, whatsappService } from "../services/whatsapp.service";

function queryValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export const whatsappController = {
  verify: ((req, res) => {
    const mode = queryValue(req.query["hub.mode"]);
    const token = queryValue(req.query["hub.verify_token"]);
    const challenge = queryValue(req.query["hub.challenge"]);
    if (!challenge || !whatsappService.verifyWebhook(mode, token)) throw new AppError(403, "Webhook verification failed", "WHATSAPP_WEBHOOK_VERIFICATION_FAILED");
    res.type("text/plain").send(challenge);
  }) satisfies RequestHandler,

  receive: (async (req, res) => {
    if (!whatsappService.verifySignature(req.rawBody, req.get("x-hub-signature-256"))) {
      throw new AppError(403, "Invalid webhook signature", "INVALID_WEBHOOK_SIGNATURE");
    }
    const inboundEvents = parseMetaWebhook(req.body);
    const statusEvents = parseMetaStatusWebhook(req.body);
    if (inboundEvents.length === 0 && statusEvents.length === 0) await whatsappService.logIgnoredWebhook(req.body as Prisma.InputJsonValue);
    const results = await Promise.allSettled([
      ...inboundEvents.map((event) => whatsappService.processInbound(event)),
      ...statusEvents.map((event) => whatsappService.processStatusUpdate(event)),
    ]);
    const failed = results.filter((result) => result.status === "rejected").length;
    res.json({ received: true, processed: results.length - failed, failed });
  }) satisfies RequestHandler,

  mockInbound: (async (req, res) => {
    if (env.NODE_ENV === "production" || (!env.ENABLE_DEV_TOOLS && env.NODE_ENV !== "development" && env.NODE_ENV !== "test")) {
      throw new AppError(404, "Route not found", "NOT_FOUND");
    }
    const input = req.body as MockWhatsAppInboundInput;
    const integration = await whatsappService.ensureMockIntegration(input.businessId);
    const result = await whatsappService.processInbound({
      businessId: input.businessId,
      phoneNumberId: integration.phoneNumberId,
      customerPhone: input.customerPhone,
      customerName: input.customerName,
      text: input.message,
      providerMessageId: input.providerMessageId ?? `mock-${crypto.randomUUID()}`,
      rawWebhookEventId: `mock-${crypto.randomUUID()}`,
      rawPayload: input as Prisma.InputJsonValue,
    });
    res.status(result.duplicate ? 200 : 201).json(result);
  }) satisfies RequestHandler,

  mockStatus: (async (req, res) => {
    if (env.NODE_ENV === "production" || (!env.ENABLE_DEV_TOOLS && env.NODE_ENV !== "development" && env.NODE_ENV !== "test")) {
      throw new AppError(404, "Route not found", "NOT_FOUND");
    }
    const input = req.body as MockWhatsAppStatusInput;
    const result = await whatsappService.processStatusUpdate({
      providerMessageId: input.providerMessageId,
      status: input.status,
      timestamp: new Date(),
      rawPayload: input as Prisma.InputJsonValue,
    });
    res.json(result);
  }) satisfies RequestHandler,
};
