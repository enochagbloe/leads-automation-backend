import { RequestHandler } from "express";
import { businessService } from "../services/business.service";

export const meController = {
  businessMemberships: async (req, res) => res.json(await businessService.listMemberships(req.auth!.userId)),
} satisfies Record<string, RequestHandler>;
