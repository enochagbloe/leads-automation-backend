import { RequestHandler } from "express";
import { businessSetupService } from "../services/business-setup.service";

export const businessSetupController = {
  status: async (req, res) => res.json(await businessSetupService.getStatus({
    businessAccountId: req.auth!.businessAccountId!,
    businessId: req.auth!.businessId!,
  })),
} satisfies Record<string, RequestHandler>;
