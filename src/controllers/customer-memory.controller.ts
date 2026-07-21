import { BusinessRole, CustomerMemorySourceType, CustomerMemoryTruthType } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { customerMemoryManagementService } from "../services/customer-memory/customer-memory-management.service";
import { CustomerMemoryDetailQuery } from "../validation/customer-memory.schemas";

function actor(req: Request) {
  return {
    userId: req.auth!.userId,
    businessId: req.auth!.businessId!,
    membershipId: req.auth!.membershipId!,
    role: req.auth!.role as BusinessRole,
  };
}

function params(req: Request) {
  return req.params as Record<string, string>;
}

export const customerMemoryController = {
  detail: async (req, res) => {
    const query = res.locals.validatedQuery as CustomerMemoryDetailQuery;
    res.json(await customerMemoryManagementService.detail(actor(req), params(req).leadId!, query.includeHistory));
  },
  correct: async (req, res) => {
    const input = req.body;
    res.json(await customerMemoryManagementService.correct(actor(req), params(req).leadId!, params(req).memoryId!, {
      ...input,
      truthType: CustomerMemoryTruthType.STAFF_CONFIRMED,
      sourceType: CustomerMemorySourceType.MANUAL_CORRECTION,
    }));
  },
  archiveItem: async (req, res) => res.json(await customerMemoryManagementService.archiveItem(actor(req), params(req).leadId!, params(req).memoryId!)),
  deleteItem: async (req, res) => res.json(await customerMemoryManagementService.deleteItem(actor(req), params(req).leadId!, params(req).memoryId!)),
  deleteCustomer: async (req, res) => res.json(await customerMemoryManagementService.deleteCustomerMemory(actor(req), params(req).leadId!)),
  deleteConversation: async (req, res) => res.json(await customerMemoryManagementService.deleteConversationMemory(actor(req), params(req).leadId!, params(req).conversationId!)),
  regenerateSummary: async (req, res) => res.json(await customerMemoryManagementService.regenerateSummary(actor(req), params(req).leadId!)),
} satisfies Record<string, RequestHandler>;
