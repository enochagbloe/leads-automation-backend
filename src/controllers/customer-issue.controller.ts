import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { customerIssueService } from "../services/customer-issue.service";
import { premiumComplaintInsightsService } from "../services/premium-complaint-insights.service";
import { ComplaintInsightQuery, CustomerIssueListQuery, CustomerIssueMetricsQuery } from "../validation/customer-issue.schemas";

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
  metrics: async (req, res) => res.json(await customerIssueService.metrics(actor(req), res.locals.validatedQuery as CustomerIssueMetricsQuery)),
  listInsights: async (req, res) => res.json(await premiumComplaintInsightsService.list(actor(req), res.locals.validatedQuery as ComplaintInsightQuery)),
  latestInsight: async (req, res) => res.json(await premiumComplaintInsightsService.latest(actor(req), res.locals.validatedQuery as ComplaintInsightQuery)),
  generateInsight: async (req, res) => res.status(201).json(await premiumComplaintInsightsService.generate(actor(req), req.body)),
  insightMemory: async (req, res) => res.json(await premiumComplaintInsightsService.memory(actor(req))),
  detail: async (req, res) => res.json(await customerIssueService.detail(actor(req), issueId(req))),
  updateIntelligence: async (req, res) => res.json(await customerIssueService.updateIntelligence(actor(req), issueId(req), req.body)),
  updateStatus: async (req, res) => res.json(await customerIssueService.updateStatus(actor(req), issueId(req), req.body.status)),
} satisfies Record<string, RequestHandler>;
