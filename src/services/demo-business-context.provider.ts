import { Message } from "@prisma/client";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { AiBusinessContext, loadAiConversationHistory } from "./ai-context-builder.service";
import { demoContextService } from "./demo-context.service";
import { DemoActor } from "./demo.service";

/** Temporary facts adapter; deliberately never loads production knowledge or memory. */
export async function buildDemoBusinessContext(actor: DemoActor, message: Message): Promise<AiBusinessContext> {
  const context = await demoContextService.getBusinessContext(actor);
  const history = await loadAiConversationHistory(actor.businessId, message.conversationId, message, env.AI_MAX_CONTEXT_MESSAGES);
  // Keep normalized JSON intact (including nulls); never truncate into invalid JSON.
  if (JSON.stringify(context.facts).length > env.AI_MAX_BUSINESS_CONTEXT_TOKENS * 2) throw new AppError(503, "Demo context exceeds runtime budget", "DEMO_AI_UNAVAILABLE");
  return {
    demoFacts: { facts: context.facts, unknowns: context.unknowns },
    business: { id: actor.businessId, name: context.businessName, industry: context.facts.industry, description: context.facts.description, website: context.sourceWebsite },
    readiness: { isAiReady: true, readinessStatus: "DEMO_READY", completionPercentage: 100, missingItems: context.unknowns, warnings: [] },
    services: [], availability: null, policies: [], knowledgeArticles: [], knowledgeDocumentChunks: [], approvedKnowledgeFacts: [], runtimeKnowledgeGuards: [],
    lead: { id: message.leadId }, conversation: { id: message.conversationId, channel: "DEMO", status: "OPEN", aiEnabled: true, humanTakeover: false },
    triggerMessage: { id: message.id, text: message.content, createdAt: message.createdAt.toISOString() },
    recentMessages: history.reverse().map(m => ({ id: m.id, text: m.content.slice(0, 1200), senderType: m.senderType, direction: m.direction, createdAt: m.createdAt.toISOString() })),
    existingCustomerIssues: [], pendingFollowUpContexts: [],
    customerMemory: { leadId: message.leadId, summary: null, activeGoal: null, serviceInterests: [], preferences: [], objections: [], timingStatements: [], missingDetails: [], unresolvedRequests: [], appointmentContext: null, leadContext: {}, lastImportantCustomerAction: null, lastStaffAction: null, humanTakeover: { active: false, aiEnabled: true, needsHumanReview: false }, memoryRevision: 0, memoryEnabled: false, memoryVersion: null },
    planCapabilities: { plan: null, aiReplies: true, teamRouting: false, safeAutoConfirm: false, tone: "PROFESSIONAL" },
    safetyInstructions: { canAnswerServiceQuestions: true, canAnswerPricingQuestions: true, canAnswerAvailabilityQuestions: true, canAnswerPolicyQuestions: true, canDetectBookingIntent: false, cannotConfirmAppointmentsWithoutBackend: true, mustRequestHumanReviewWhenUnsure: true },
  };
}
