import {
  AuditAction,
  ConversationStatus,
  FollowUpContextType,
  FollowUpJobStatus,
  FollowUpRuleType,
  LeadStatus,
  MessageDirection,
  MessageSenderType,
  PlanCode,
  PremiumFollowUpDecision,
  PremiumFollowUpSequenceStage,
  AiPromptScope,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { aiProvider } from "../ai-provider.service";
import { aiUsageService } from "../ai-usage.service";
import { auditService } from "../audit.service";
import { realtimeService } from "../realtime.service";
import { subscriptionService } from "../subscription.service";
import { aiPromptResolverService } from "../ai-prompt/resolution/ai-prompt-resolver.service";
import { FollowUpPromptCompiled } from "../ai-prompt/core/ai-prompt.types";
import { scheduleFollowUpAutomationJob } from "./follow-up-basic.service";
import { FOLLOW_UP_SUCCESSFUL_ATTEMPT_DELIVERY_STATUSES, json, jsonObject } from "./follow-up.shared";

export const PREMIUM_NO_RESPONSE_MAX_ATTEMPTS = 3;

type PremiumDecisionShape = {
  decision: PremiumFollowUpDecision;
  customerGoal: string | null;
  customerObjection: string | null;
  preferredFollowUpAt: string | null;
  preferredFollowUpText: string | null;
  conversationStillActive: boolean;
  staffRecentlyActive: boolean;
  shouldStopAutomation: boolean;
  stopReason: string | null;
  recommendedMessageAngle: string | null;
  confidence: number;
  generatedMessage?: string | null;
};

type PremiumPromptRuntime = {
  maxAttempts: number;
  promptLines: string[];
  followUpConfig: FollowUpPromptCompiled | null;
  promptVersionIds: string[];
};

function sequenceStageForAttempt(attemptNumber: number) {
  if (attemptNumber <= 1) return PremiumFollowUpSequenceStage.INITIAL_CHECK_IN;
  if (attemptNumber === 2) return PremiumFollowUpSequenceStage.HELPFUL_CLARIFICATION;
  return PremiumFollowUpSequenceStage.FINAL_POLITE_FOLLOW_UP;
}

function boundedConfidence(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0.5;
}

function cleanString(value: unknown, max = 500) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function parseJsonObject(rawText: string) {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced ?? (trimmed.startsWith("{") ? trimmed : trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1));
  return JSON.parse(candidate) as Record<string, unknown>;
}

function parseDecision(rawText: string, fallbackDecision: PremiumFollowUpDecision): PremiumDecisionShape {
  const object = parseJsonObject(rawText);
  const decision = typeof object.decision === "string" && object.decision in PremiumFollowUpDecision
    ? object.decision as PremiumFollowUpDecision
    : fallbackDecision;
  return {
    decision,
    customerGoal: cleanString(object.customerGoal, 220),
    customerObjection: cleanString(object.customerObjection, 220),
    preferredFollowUpAt: cleanString(object.preferredFollowUpAt, 80),
    preferredFollowUpText: cleanString(object.preferredFollowUpText, 180),
    conversationStillActive: object.conversationStillActive !== false,
    staffRecentlyActive: object.staffRecentlyActive === true,
    shouldStopAutomation: object.shouldStopAutomation === true || decision === PremiumFollowUpDecision.STOP,
    stopReason: cleanString(object.stopReason, 220),
    recommendedMessageAngle: cleanString(object.recommendedMessageAngle, 300),
    confidence: boundedConfidence(object.confidence),
    generatedMessage: cleanString(object.generatedMessage, 700),
  };
}

function safeFutureDate(value: string | null, now = new Date()) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const min = new Date(now.getTime() + 5 * 60_000);
  const max = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
  return parsed > min && parsed < max ? parsed : null;
}

function fallbackMessage(input: {
  businessName: string;
  customerGoal: string | null;
  customerObjection: string | null;
  stage: PremiumFollowUpSequenceStage;
}) {
  const goal = input.customerGoal ? ` about ${input.customerGoal}` : "";
  if (input.stage === PremiumFollowUpSequenceStage.FINAL_POLITE_FOLLOW_UP) {
    return `Hi, just checking one final time if you'd still like help${goal}. If now is not a good time, no problem.`;
  }
  if (input.stage === PremiumFollowUpSequenceStage.HELPFUL_CLARIFICATION) {
    const objection = input.customerObjection ? ` If ${input.customerObjection.toLowerCase()} is the main concern, we can clarify that for you.` : "";
    return `Hi, following up to see if you still need help${goal}.${objection}`;
  }
  return `Hi, just checking if you'd still like help${goal}.`;
}

function safeMessage(value: string | null | undefined) {
  const text = value?.replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ").trim();
  if (!text || text.length < 8 || text.length > 700) return null;
  return text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function followUpCompiled(value: unknown): FollowUpPromptCompiled | null {
  const record = asRecord(value);
  const followUp = asRecord(record?.followUp);
  return followUp as FollowUpPromptCompiled | null;
}

function globalCompiled(value: unknown) {
  const record = asRecord(value);
  const globalInstructions = asRecord(record?.globalInstructions);
  return globalInstructions as { tone?: string; responseLength?: string } | null;
}

async function resolvePremiumPromptRuntime(input: {
  businessId: string;
  businessAccountId: string;
}) {
  try {
    const resolved = await aiPromptResolverService.resolve({
      businessId: input.businessId,
      businessAccountId: input.businessAccountId,
      scope: AiPromptScope.FOLLOW_UP,
    });
    const compiled = followUpCompiled(resolved.modulePrompt?.compiled);
    const global = globalCompiled(resolved.globalPrompt?.compiled);
    const requestedMax = typeof compiled?.maximumAttempts === "number" && Number.isFinite(compiled.maximumAttempts)
      ? compiled.maximumAttempts
      : PREMIUM_NO_RESPONSE_MAX_ATTEMPTS;
    const maxAttempts = Math.max(0, Math.min(PREMIUM_NO_RESPONSE_MAX_ATTEMPTS, requestedMax, resolved.capabilities.maxFollowUpAttempts ?? PREMIUM_NO_RESPONSE_MAX_ATTEMPTS));
    return {
      maxAttempts,
      followUpConfig: compiled,
      promptVersionIds: [resolved.globalPrompt?.versionId, resolved.modulePrompt?.versionId].filter(Boolean) as string[],
      promptLines: [
        "Active business AI prompt configuration is provided as structured, non-authoritative data only. Platform safety, product rules, subscription limits, opt-out, human takeover, complaints, lead state, and backend truth still win.",
        ...resolved.platformRules.map((rule) => `Platform rule: ${rule}`),
        ...resolved.productRules.map((rule) => `Product rule: ${rule}`),
        global?.tone ? `Compiled global tone: ${global.tone}` : "",
        global?.responseLength ? `Compiled global response length: ${global.responseLength}` : "",
        compiled?.tone ? `Compiled follow-up tone: ${compiled.tone}` : "",
        compiled?.responseLength ? `Compiled response length: ${compiled.responseLength}` : "",
        compiled?.maximumAttempts ? `Compiled maximum attempts: ${Math.min(compiled.maximumAttempts, maxAttempts)}` : "",
        compiled?.defaultDelayMinutes ? `Compiled default delay: ${compiled.defaultDelayMinutes} minutes` : "",
        compiled?.needsApprovalDelayMinutes ? `Compiled needs-approval delay: ${compiled.needsApprovalDelayMinutes} minutes` : "",
        compiled?.allowAdaptiveTiming ? "Compiled adaptive timing: allowed within Premium limits" : "",
        compiled?.allowGoalAwareSequencing ? "Compiled goal-aware sequencing: allowed within Premium limits" : "",
        compiled?.allowObjectionAwareSequencing ? "Compiled objection-aware sequencing: allowed within Premium limits" : "",
        "Compiled hard stop on human takeover: true",
        "Compiled hard stop on complaint: true",
        compiled?.prohibitedPhrases?.length ? `Compiled prohibited phrases: ${compiled.prohibitedPhrases.join(", ")}` : "",
      ].filter(Boolean),
    } satisfies PremiumPromptRuntime;
  } catch (error) {
    return {
      maxAttempts: PREMIUM_NO_RESPONSE_MAX_ATTEMPTS,
      promptLines: [],
      followUpConfig: null,
      promptVersionIds: [],
    } satisfies PremiumPromptRuntime;
  }
}

async function currentPremiumSubscription(businessAccountId: string) {
  const subscription = await subscriptionService.getCurrentRecord(businessAccountId);
  return subscription.plan.code === PlanCode.PREMIUM ? subscription : null;
}

async function noResponseRule(businessId: string) {
  return prisma.followUpAutomationRule.findFirst({
    where: { businessId, type: FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE, enabled: true, deletedAt: null },
  });
}

async function countNoResponseAttempts(input: {
  businessId: string;
  ruleId: string;
  conversationId: string;
}) {
  return prisma.followUpSendLog.count({
    where: {
      businessId: input.businessId,
      ruleId: input.ruleId,
      conversationId: input.conversationId,
      deliveryStatus: { in: [...FOLLOW_UP_SUCCESSFUL_ATTEMPT_DELIVERY_STATUSES] },
    },
  });
}

async function recentConversationContext(businessId: string, conversationId: string) {
  const messages = await prisma.message.findMany({
    where: { businessId, conversationId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 14,
    select: {
      id: true,
      senderType: true,
      direction: true,
      content: true,
      createdAt: true,
    },
  });
  return messages.reverse();
}

async function analyze(input: {
  businessId: string;
  businessAccountId: string;
  businessName: string;
  conversationId: string;
  leadName: string | null;
  attemptNumber: number;
  sequenceStage: PremiumFollowUpSequenceStage;
  fallbackDecision: PremiumFollowUpDecision;
  source: "SCHEDULE" | "PRE_SEND" | "COMPOSE";
  fallbackMessageText?: string;
  promptRuntime?: PremiumPromptRuntime;
}) {
  const usage = await aiUsageService.assertCanUseAiReplies(input.businessAccountId);
  const messages = await recentConversationContext(input.businessId, input.conversationId);
  const result = await aiProvider.generateCompletion({
    businessId: input.businessId,
    responseFormat: { type: "json_object" },
    temperature: 0.15,
    maxTokens: input.source === "COMPOSE" ? 500 : 450,
    systemPrompt: [
      "You are BizReply AI Premium Follow-Up Intelligence.",
      "Analyze the conversation before deciding whether an automated WhatsApp follow-up should continue.",
      "Use only the conversation context. Do not invent prices, policies, availability, promises, discounts, or outcomes.",
      "Stop automation when the customer is no longer interested, asks not to be contacted, the issue is resolved, a human is actively handling it, or the follow-up would feel unnecessary.",
      "Return strict JSON only.",
    ].join("\n"),
    userPrompt: [
      `Business: ${input.businessName}`,
      `Customer: ${input.leadName ?? "Unknown customer"}`,
      `Attempt number: ${input.attemptNumber} of ${input.promptRuntime?.maxAttempts ?? PREMIUM_NO_RESPONSE_MAX_ATTEMPTS}`,
      `Sequence stage: ${input.sequenceStage}`,
      `Decision source: ${input.source}`,
      input.fallbackMessageText ? `Fallback message: ${input.fallbackMessageText}` : "",
      ...(input.promptRuntime?.promptLines ?? []),
      "Recent conversation:",
      ...messages.map((message) => {
        const speaker = message.senderType === MessageSenderType.CUSTOMER ? "Customer" : message.senderType;
        return `- ${speaker} (${message.createdAt.toISOString()}): ${message.content.slice(0, 700)}`;
      }),
      "Return JSON with these fields:",
      "{",
      '  "decision": "SCHEDULE" | "SEND" | "RESCHEDULE" | "CANCEL" | "STOP",',
      '  "customerGoal": string | null,',
      '  "customerObjection": string | null,',
      '  "preferredFollowUpAt": ISO datetime string | null,',
      '  "preferredFollowUpText": string | null,',
      '  "conversationStillActive": boolean,',
      '  "staffRecentlyActive": boolean,',
      '  "shouldStopAutomation": boolean,',
      '  "stopReason": string | null,',
      '  "recommendedMessageAngle": string | null,',
      '  "generatedMessage": string | null,',
      '  "confidence": number',
      "}",
      "For COMPOSE, generatedMessage must be one short natural WhatsApp message for this stage.",
    ].filter(Boolean).join("\n"),
    metadata: {
      source: "PREMIUM_FOLLOW_UP_INTELLIGENCE",
      decisionSource: input.source,
      conversationId: input.conversationId,
      attemptNumber: input.attemptNumber,
      sequenceStage: input.sequenceStage,
      promptVersionIds: input.promptRuntime?.promptVersionIds ?? [],
    },
  });
  await aiUsageService.trackRequest({ accountUsageId: usage.usage.id, tokens: result.totalTokens });
  return {
    decision: parseDecision(result.rawText, input.fallbackDecision),
    providerMetadata: {
      provider: result.provider,
      model: result.finalModelUsed,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: result.totalTokens,
      providerRequestCount: result.providerRequestCount,
    },
  };
}

async function createSnapshot(input: {
  businessId: string;
  leadId: string | null;
  conversationId: string | null;
  jobId?: string | null;
  sourceMessageId?: string | null;
  attemptNumber: number;
  sequenceStage: PremiumFollowUpSequenceStage;
  decision: PremiumDecisionShape;
  rawDecision?: Record<string, unknown>;
}) {
  return prisma.premiumFollowUpIntelligenceSnapshot.create({
    data: {
      businessId: input.businessId,
      leadId: input.leadId,
      conversationId: input.conversationId,
      jobId: input.jobId ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
      attemptNumber: input.attemptNumber,
      sequenceStage: input.sequenceStage,
      decision: input.decision.decision,
      customerGoal: input.decision.customerGoal,
      customerObjection: input.decision.customerObjection,
      preferredFollowUpAt: safeFutureDate(input.decision.preferredFollowUpAt),
      preferredFollowUpText: input.decision.preferredFollowUpText,
      conversationStillActive: input.decision.conversationStillActive,
      staffRecentlyActive: input.decision.staffRecentlyActive,
      shouldStopAutomation: input.decision.shouldStopAutomation,
      stopReason: input.decision.stopReason,
      recommendedMessageAngle: input.decision.recommendedMessageAngle,
      confidence: input.decision.confidence,
      rawDecision: input.rawDecision ? json(input.rawDecision) : json(input.decision),
    },
  });
}

async function publishEvaluated(input: {
  businessId: string;
  leadId?: string | null;
  conversationId?: string | null;
  snapshotId?: string | null;
  decision: PremiumDecisionShape;
  attemptNumber: number;
  sequenceStage: PremiumFollowUpSequenceStage;
}) {
  realtimeService.publish({
    type: "business.follow_up.premium.intelligence_evaluated",
    businessId: input.businessId,
    conversationId: input.conversationId ?? undefined,
    leadId: input.leadId ?? undefined,
    payload: {
      snapshotId: input.snapshotId ?? null,
      decision: input.decision.decision,
      customerGoal: input.decision.customerGoal,
      customerObjection: input.decision.customerObjection,
      stopReason: input.decision.stopReason,
      attemptNumber: input.attemptNumber,
      sequenceStage: input.sequenceStage,
    },
    broadcastToStaff: true,
  });
}

export const followUpPremiumIntelligenceService = {
  async scheduleNoResponseAfterOutboundMessage(input: {
    businessId: string;
    leadId: string;
    conversationId: string;
    messageId: string;
    messageCreatedAt: Date;
  }) {
    const [business, rule, lead, conversation] = await Promise.all([
      prisma.business.findFirst({
        where: { id: input.businessId, deletedAt: null },
        select: { id: true, name: true, businessAccountId: true, followUpAutomationEnabled: true },
      }),
      noResponseRule(input.businessId),
      prisma.lead.findFirst({ where: { id: input.leadId, businessId: input.businessId, deletedAt: null }, select: { id: true, fullName: true, status: true } }),
      prisma.conversation.findFirst({
        where: { id: input.conversationId, businessId: input.businessId, deletedAt: null },
        select: { id: true, status: true, humanTakeover: true, needsHumanReview: true },
      }),
    ]);
    if (!business || !business.followUpAutomationEnabled) return { scheduled: false, reason: "FOLLOW_UP_AUTOMATION_DISABLED" as const };
    const subscription = await currentPremiumSubscription(business.businessAccountId);
    if (!subscription) return { scheduled: false, reason: "PLAN_NOT_PREMIUM" as const };
    if (!rule) return { scheduled: false, reason: "FOLLOW_UP_RULE_DISABLED" as const };
    if (!lead || lead.status === LeadStatus.WON || lead.status === LeadStatus.LOST) return { scheduled: false, reason: "LEAD_CLOSED" as const };
    if (!conversation || conversation.status === ConversationStatus.CLOSED || conversation.status === ConversationStatus.PLAN_LIMIT_BLOCKED || conversation.humanTakeover || conversation.needsHumanReview) {
      return { scheduled: false, reason: "CONVERSATION_NOT_ELIGIBLE" as const };
    }

    const promptRuntime = await resolvePremiumPromptRuntime({ businessId: input.businessId, businessAccountId: business.businessAccountId });
    const attempts = await countNoResponseAttempts({ businessId: input.businessId, ruleId: rule.id, conversationId: input.conversationId });
    if (attempts >= promptRuntime.maxAttempts) return { scheduled: false, reason: "PREMIUM_MAX_NO_RESPONSE_ATTEMPTS_REACHED" as const };
    const attemptNumber = attempts + 1;
    const sequenceStage = sequenceStageForAttempt(attemptNumber);

    let decision: PremiumDecisionShape = {
      decision: PremiumFollowUpDecision.SCHEDULE,
      customerGoal: null,
      customerObjection: null,
      preferredFollowUpAt: null,
      preferredFollowUpText: null,
      conversationStillActive: true,
      staffRecentlyActive: false,
      shouldStopAutomation: false,
      stopReason: null,
      recommendedMessageAngle: null,
      confidence: 0.5,
    };
    let providerMetadata: Record<string, unknown> | undefined;
    try {
      const analyzed = await analyze({
        businessId: input.businessId,
        businessAccountId: business.businessAccountId,
        businessName: business.name,
        conversationId: input.conversationId,
        leadName: lead.fullName,
        attemptNumber,
        sequenceStage,
        fallbackDecision: PremiumFollowUpDecision.SCHEDULE,
        source: "SCHEDULE",
        promptRuntime,
      });
      decision = analyzed.decision;
      providerMetadata = analyzed.providerMetadata;
    } catch (error) {
      providerMetadata = { failed: true, reason: error instanceof Error ? error.message : "PREMIUM_FOLLOW_UP_AI_FAILED" };
    }

    if (decision.shouldStopAutomation || decision.decision === PremiumFollowUpDecision.STOP || decision.decision === PremiumFollowUpDecision.CANCEL) {
      const snapshot = await createSnapshot({
        businessId: input.businessId,
        leadId: input.leadId,
        conversationId: input.conversationId,
        sourceMessageId: input.messageId,
        attemptNumber,
        sequenceStage,
        decision: { ...decision, decision: decision.decision === PremiumFollowUpDecision.STOP ? PremiumFollowUpDecision.STOP : PremiumFollowUpDecision.CANCEL },
        rawDecision: { decision, providerMetadata },
      });
      await auditService.log({
        action: AuditAction.FOLLOW_UP_CONTEXT_EVALUATED,
        businessId: input.businessId,
        metadata: json({ usageEvent: "PREMIUM_FOLLOW_UP_STOPPED", snapshotId: snapshot.id, reason: decision.stopReason, attemptNumber, sequenceStage }),
      });
      await publishEvaluated({ businessId: input.businessId, leadId: input.leadId, conversationId: input.conversationId, snapshotId: snapshot.id, decision, attemptNumber, sequenceStage });
      return { scheduled: false, reason: decision.stopReason ?? "PREMIUM_FOLLOW_UP_STOPPED", snapshot };
    }

    const preferred = safeFutureDate(decision.preferredFollowUpAt, input.messageCreatedAt);
    const scheduledFor = preferred ?? new Date(input.messageCreatedAt.getTime() + rule.delayMinutes * 60_000);
    const scheduled = await scheduleFollowUpAutomationJob({
      businessId: input.businessId,
      type: FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE,
      contextType: FollowUpContextType.GENERAL_NO_RESPONSE,
      leadId: input.leadId,
      conversationId: input.conversationId,
      relatedMessageId: input.messageId,
      scheduledFor,
      pendingQuestion: [
        `Premium ${sequenceStage.toLowerCase()} follow-up.`,
        decision.customerGoal ? `Customer goal: ${decision.customerGoal}.` : "",
        decision.customerObjection ? `Customer objection: ${decision.customerObjection}.` : "",
        decision.recommendedMessageAngle ? `Message angle: ${decision.recommendedMessageAngle}.` : "",
      ].filter(Boolean).join(" "),
      expectedResponseType: "CUSTOMER_REPLY",
      replaceScheduledNoResponse: true,
    });

    const scheduledJob = scheduled.scheduled && "job" in scheduled && scheduled.job ? scheduled.job : null;
    const jobId = scheduledJob?.id ?? null;
    const snapshot = await createSnapshot({
      businessId: input.businessId,
      leadId: input.leadId,
      conversationId: input.conversationId,
      jobId,
      sourceMessageId: input.messageId,
      attemptNumber,
      sequenceStage,
      decision: { ...decision, decision: preferred ? PremiumFollowUpDecision.RESCHEDULE : PremiumFollowUpDecision.SCHEDULE },
      rawDecision: { decision, providerMetadata },
    });
    await auditService.log({
      action: AuditAction.FOLLOW_UP_CONTEXT_EVALUATED,
      businessId: input.businessId,
      metadata: json({
        usageEvent: "PREMIUM_FOLLOW_UP_SCHEDULED",
        snapshotId: snapshot.id,
        jobId,
        preferredFollowUpAt: preferred,
        attemptNumber,
        sequenceStage,
        promptVersionIds: promptRuntime.promptVersionIds,
      }),
    });
    await publishEvaluated({ businessId: input.businessId, leadId: input.leadId, conversationId: input.conversationId, snapshotId: snapshot.id, decision, attemptNumber, sequenceStage });
    if (scheduled.scheduled) {
      realtimeService.publish({
        type: "business.follow_up.premium.no_response.scheduled",
        businessId: input.businessId,
        conversationId: input.conversationId,
        leadId: input.leadId,
        payload: { job: scheduledJob, snapshot },
        broadcastToStaff: true,
      });
    }
    return { ...scheduled, snapshot };
  },

  async evaluateBeforeSend(jobId: string) {
    const job = await prisma.followUpJob.findUnique({
      where: { id: jobId },
      include: { rule: true, business: true, lead: true, conversation: true },
    });
    if (!job || job.rule.type !== FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE || !job.conversationId || !job.leadId) {
      return { action: "SEND" as const };
    }
    const subscription = await currentPremiumSubscription(job.business.businessAccountId);
    if (!subscription) return { action: "SEND" as const };
    const promptRuntime = await resolvePremiumPromptRuntime({ businessId: job.businessId, businessAccountId: job.business.businessAccountId });
    const attempts = await countNoResponseAttempts({ businessId: job.businessId, ruleId: job.ruleId, conversationId: job.conversationId });
    if (attempts >= promptRuntime.maxAttempts) {
      return { action: "CANCEL" as const, reason: "PREMIUM_MAX_NO_RESPONSE_ATTEMPTS_REACHED" };
    }

    const [staffMessage, customerReply] = await Promise.all([
      prisma.message.findFirst({
        where: {
          businessId: job.businessId,
          conversationId: job.conversationId,
          senderType: MessageSenderType.STAFF,
          direction: MessageDirection.OUTBOUND,
          createdAt: { gt: job.createdAt },
          deletedAt: null,
        },
        select: { id: true },
      }),
      job.relatedMessageId ? prisma.message.findFirst({
        where: {
          businessId: job.businessId,
          conversationId: job.conversationId,
          senderType: MessageSenderType.CUSTOMER,
          direction: MessageDirection.INBOUND,
          createdAt: { gt: job.createdAt },
          deletedAt: null,
        },
        select: { id: true },
      }) : Promise.resolve(null),
    ]);
    if (staffMessage) return { action: "CANCEL" as const, reason: "STAFF_CONTINUED_CONVERSATION", staffMessageId: staffMessage.id };
    if (customerReply) return { action: "CANCEL" as const, reason: "CUSTOMER_REPLIED_BEFORE_SEND", customerReplyId: customerReply.id };

    const attemptNumber = attempts + 1;
    const sequenceStage = sequenceStageForAttempt(attemptNumber);
    let decision: PremiumDecisionShape;
    let providerMetadata: Record<string, unknown> | undefined;
    try {
      const analyzed = await analyze({
        businessId: job.businessId,
        businessAccountId: job.business.businessAccountId,
        businessName: job.business.name,
        conversationId: job.conversationId,
        leadName: job.lead?.fullName ?? null,
        attemptNumber,
        sequenceStage,
        fallbackDecision: PremiumFollowUpDecision.SEND,
        source: "PRE_SEND",
        promptRuntime,
      });
      decision = analyzed.decision;
      providerMetadata = analyzed.providerMetadata;
    } catch (error) {
      decision = {
        decision: PremiumFollowUpDecision.SEND,
        customerGoal: null,
        customerObjection: null,
        preferredFollowUpAt: null,
        preferredFollowUpText: null,
        conversationStillActive: true,
        staffRecentlyActive: false,
        shouldStopAutomation: false,
        stopReason: null,
        recommendedMessageAngle: null,
        confidence: 0.4,
      };
      providerMetadata = { failed: true, reason: error instanceof Error ? error.message : "PREMIUM_FOLLOW_UP_AI_FAILED" };
    }
    const snapshot = await createSnapshot({
      businessId: job.businessId,
      leadId: job.leadId,
      conversationId: job.conversationId,
      jobId: job.id,
      sourceMessageId: job.relatedMessageId,
      attemptNumber,
      sequenceStage,
      decision,
      rawDecision: { decision, providerMetadata },
    });
    await publishEvaluated({ businessId: job.businessId, leadId: job.leadId, conversationId: job.conversationId, snapshotId: snapshot.id, decision, attemptNumber, sequenceStage });

    if (decision.shouldStopAutomation || decision.decision === PremiumFollowUpDecision.STOP || decision.decision === PremiumFollowUpDecision.CANCEL) {
      return { action: "CANCEL" as const, reason: decision.stopReason ?? "PREMIUM_FOLLOW_UP_STOPPED", snapshot };
    }
    if (decision.decision === PremiumFollowUpDecision.RESCHEDULE) {
      const rescheduledFor = safeFutureDate(decision.preferredFollowUpAt);
      if (rescheduledFor) return { action: "RESCHEDULE" as const, reason: "PREMIUM_FOLLOW_UP_PREFERRED_TIME", rescheduledFor, snapshot };
    }
    return { action: "SEND" as const, snapshot };
  },

  async composeMessage(input: {
    businessId: string;
    businessAccountId: string;
    businessName: string;
    conversationId: string;
    leadName: string | null;
    jobId: string;
    fallbackText: string;
  }) {
    const subscription = await currentPremiumSubscription(input.businessAccountId);
    if (!subscription) return { text: input.fallbackText, usedPremiumIntelligence: false as const };
    const promptRuntime = await resolvePremiumPromptRuntime({ businessId: input.businessId, businessAccountId: input.businessAccountId });
    const snapshot = await prisma.premiumFollowUpIntelligenceSnapshot.findFirst({
      where: { businessId: input.businessId, jobId: input.jobId },
      orderBy: { createdAt: "desc" },
    });
    const attemptNumber = snapshot?.attemptNumber ?? 1;
    const sequenceStage = snapshot?.sequenceStage ?? sequenceStageForAttempt(attemptNumber);
    try {
      const analyzed = await analyze({
        businessId: input.businessId,
        businessAccountId: input.businessAccountId,
        businessName: input.businessName,
        conversationId: input.conversationId,
        leadName: input.leadName,
        attemptNumber,
        sequenceStage,
        fallbackDecision: PremiumFollowUpDecision.SEND,
        source: "COMPOSE",
        fallbackMessageText: input.fallbackText,
        promptRuntime,
      });
      const text = safeMessage(analyzed.decision.generatedMessage) ?? safeMessage(analyzed.decision.recommendedMessageAngle) ?? fallbackMessage({
        businessName: input.businessName,
        customerGoal: analyzed.decision.customerGoal ?? snapshot?.customerGoal ?? null,
        customerObjection: analyzed.decision.customerObjection ?? snapshot?.customerObjection ?? null,
        stage: sequenceStage,
      });
      return {
        text,
        usedPremiumIntelligence: true as const,
        providerMetadata: analyzed.providerMetadata,
        snapshotId: snapshot?.id ?? null,
      };
    } catch {
      return {
        text: fallbackMessage({
          businessName: input.businessName,
          customerGoal: snapshot?.customerGoal ?? null,
          customerObjection: snapshot?.customerObjection ?? null,
          stage: sequenceStage,
        }),
        usedPremiumIntelligence: true as const,
        failed: true as const,
        snapshotId: snapshot?.id ?? null,
      };
    }
  },
};
