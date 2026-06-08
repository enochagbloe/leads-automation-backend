import { RequestHandler } from "express";
import { AuditAction } from "@prisma/client";
import { auditService } from "../services/audit.service";
import { subscriptionService } from "../services/subscription.service";
import { requestMetadata } from "../utils/request";

export const subscriptionController = {
  current: async (req, res) => res.json(await subscriptionService.getCurrent(req.auth!.businessAccountId!, req.auth!.businessId, req.auth!.userId)),
  plans: async (_req, res) => res.json(await subscriptionService.listPlans()),
  changePlan: async (req, res) => {
    await auditService.log({
      ...requestMetadata(req),
      action: AuditAction.PLAN_CHANGED_PLACEHOLDER,
      businessId: req.auth!.businessId,
      userId: req.auth!.userId,
    });
    res.status(501).json({
      error: { code: "NOT_IMPLEMENTED", message: "Plan changes will be enabled when billing integration is added." },
    });
  },
} satisfies Record<string, RequestHandler>;
