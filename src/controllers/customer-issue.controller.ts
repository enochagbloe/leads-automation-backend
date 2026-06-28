import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { customerIssueService } from "../services/customer-issue.service";
import { CustomerIssueListQuery } from "../validation/customer-issue.schemas";

function actor(req: Request) {
  return {
    userId: req.auth!.userId,
    businessAccountId: req.auth!.businessAccountId!,
    businessId: req.auth!.businessId!,
    membershipId: req.auth!.membershipId!,
    role: req.auth!.role as BusinessRole,
  };
}

function issueId(req: Request) {
  const value = req.params.issueId;
  return Array.isArray(value) ? value[0]! : value!;
}

export const customerIssueController = {
  list: async (req, res) => res.json(await customerIssueService.list(actor(req), res.locals.validatedQuery as CustomerIssueListQuery)),
  detail: async (req, res) => res.json(await customerIssueService.detail(actor(req), issueId(req))),
  updateStatus: async (req, res) => res.json(await customerIssueService.updateStatus(actor(req), issueId(req), req.body.status)),
} satisfies Record<string, RequestHandler>;
