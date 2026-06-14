import cors from "cors";
import express from "express";
import helmet from "helmet";
import { corsOrigins } from "./config/env";
import { errorHandler, notFound } from "./middleware/error";
import { authRouter } from "./routes/auth.routes";
import { subscriptionRouter } from "./routes/subscription.routes";
import { subscriptionController } from "./controllers/subscription.controller";
import { businessRouter } from "./routes/business.routes";
import { leadRouter } from "./routes/lead.routes";
import { prisma } from "./config/prisma";
import { conversationRouter } from "./routes/conversation.routes";
import { env } from "./config/env";
import { mockWhatsAppRouter, whatsappWebhookRouter } from "./routes/whatsapp.routes";
import { realtimeRouter } from "./routes/realtime.routes";
import { whatsappConnectionRouter } from "./routes/whatsapp-connection.routes";
import { businessSetupRouter } from "./routes/business-setup.routes";
import { serviceRouter } from "./routes/service.routes";
import { availabilityRouter } from "./routes/availability.routes";
import { policyRouter } from "./routes/policy.routes";

export const app = express();

app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(express.json({
  limit: "100kb",
  verify: (req, _res, buffer) => {
    (req as express.Request).rawBody = buffer;
  },
}));

app.get("/api", (_req, res) => res.json({
  name: "BizReply AI API",
  version: "1.0.0",
  status: "ok",
  endpoints: {
    health: "/api/health",
    auth: "/api/auth",
    businesses: "/api/businesses",
    businessSetupStatus: "/api/business/setup-status",
    businessProfile: "/api/business/profile",
    businessKnowledgePreview: "/api/business/knowledge-preview",
    businessServices: "/api/business/services",
    businessAvailability: "/api/business/availability",
    businessPolicies: "/api/business/policies",
    leads: "/api/leads",
    conversations: "/api/conversations",
    realtime: "/api/realtime/events",
    whatsAppWebhook: "/api/webhooks/whatsapp",
    whatsAppConnection: "/api/business/whatsapp",
    mockWhatsApp: env.NODE_ENV === "production" ? undefined : "/api/dev/mock-whatsapp/inbound-message",
    plans: "/api/plans",
    subscription: "/api/subscription",
  },
}));
app.get("/api/health", async (_req, res) => {
  const timestamp = new Date().toISOString();

  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", database: "connected", whatsapp: { mode: env.WHATSAPP_PROVIDER_MODE, configured: env.WHATSAPP_PROVIDER_MODE === "mock" || Boolean(env.META_APP_ID && env.META_APP_SECRET && env.META_WHATSAPP_VERIFY_TOKEN) }, timestamp });
  } catch {
    res.status(503).json({ status: "degraded", database: "unavailable", timestamp });
  }
});
app.get("/api/plans", subscriptionController.plans);
app.use("/api/webhooks/whatsapp", whatsappWebhookRouter);
app.use("/api/dev/mock-whatsapp", mockWhatsAppRouter);
app.use("/api/auth", authRouter);
app.use("/api/businesses", businessRouter);
app.use("/api/business/whatsapp", whatsappConnectionRouter);
app.use("/api/business", businessSetupRouter);
app.use("/api/business/services", serviceRouter);
app.use("/api/business/availability", availabilityRouter);
app.use("/api/business/policies", policyRouter);
app.use("/api/leads", leadRouter);
app.use("/api/conversations", conversationRouter);
app.use("/api/realtime", realtimeRouter);
app.use("/api/subscription", subscriptionRouter);

app.use(notFound);
app.use(errorHandler);
