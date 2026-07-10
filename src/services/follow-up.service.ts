import {
  AuditAction,
  FollowUpJobStatus,
  FollowUpRuleType,
  PlanCode,
  Prisma,
  SubscriptionStatus,
} from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import {
  FollowUpJobListQuery,
  FollowUpJobRetryInput,
  FollowUpLogListQuery,
  FollowUpRuleCreateInput,
  FollowUpRuleListQuery,
  FollowUpRuleUpdateInput,
  FollowUpSettingsInput,
  FollowUpTestTriggerInput,
} from "../validation/follow-up.schemas";
import { realtimeService } from "./realtime.service";
import { followUpBasicService } from "./follow-up/follow-up-basic.service";
import { followUpCancellationService } from "./follow-up/follow-up-cancellation.service";
import { followUpEligibilityService } from "./follow-up/follow-up-eligibility.service";
import { followUpJobProcessorService } from "./follow-up/follow-up-processor.service";
import { followUpPlusService } from "./follow-up/follow-up-plus.service";
import {
  assertFollowUpRuleSettingsWithinPolicy,
  followUpPlanPolicyService,
  requiredPlanForRuleType,
} from "./follow-up/follow-up-policy.service";
import { followUpJobSchedulerService } from "./follow-up/follow-up-scheduler.service";
import {
  assertCanManage,
  assertCanView,
  audit,
  isManager,
  jobAccessWhere,
  jobInclude,
  jsonObject,
  logAccessWhere,
  ruleInclude,
  sendLogInclude,
} from "./follow-up/follow-up.shared";
import { FollowUpActor, FollowUpDb } from "./follow-up/follow-up.types";

export type { FollowUpActor, FollowUpDb } from "./follow-up/follow-up.types";
export { followUpCancellationService } from "./follow-up/follow-up-cancellation.service";
export { followUpContextEvaluationService } from "./follow-up/follow-up-context-evaluation.service";
export { followUpEligibilityService } from "./follow-up/follow-up-eligibility.service";
export { followUpJobProcessorService } from "./follow-up/follow-up-processor.service";
export { followUpJobSchedulerService } from "./follow-up/follow-up-scheduler.service";
export { followUpPlanPolicyService } from "./follow-up/follow-up-policy.service";
export { followUpPlusService } from "./follow-up/follow-up-plus.service";
export { followUpTemplateRendererService } from "./follow-up/follow-up-template.service";

export const followUpService = {
  async ensureDefaultRulesForBusiness(actor: FollowUpActor) {
    if (!isManager(actor)) return;
    await this.seedDefaultRulesForBusiness(actor.businessId, actor.membershipId);
  },

  async seedDefaultRulesForBusiness(businessId: string, createdByMembershipId: string, db: FollowUpDb = prisma) {
    const business = await db.business.findUnique({ where: { id: businessId }, select: { businessAccountId: true } });
    const subscription = business
      ? await db.subscription.findFirst({
        where: { businessAccountId: business.businessAccountId, status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] } },
        include: { plan: true },
        orderBy: { createdAt: "desc" },
      })
      : null;
    const plusDefaults = subscription?.plan.code === PlanCode.PLUS || subscription?.plan.code === PlanCode.PREMIUM;
    const defaults: Array<Pick<FollowUpRuleCreateInput, "type" | "name" | "delayMinutes" | "messageTemplate" | "useAiRewrite" | "maxSendsPerLead" | "maxSendsPerConversation">> = [
      {
        type: FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE,
        name: "No response follow-up",
        delayMinutes: 1440,
        messageTemplate: plusDefaults ? "Hi, just checking if you’d still like help with this." : "Hi {{customerName}}, just checking if you’d still like help with this.",
        useAiRewrite: plusDefaults,
        maxSendsPerLead: plusDefaults ? 2 : 1,
        maxSendsPerConversation: plusDefaults ? 2 : 1,
      },
      {
        type: FollowUpRuleType.CONTACT_EMAIL_REQUEST,
        name: "Ask for customer email",
        delayMinutes: 0,
        messageTemplate: "You can also share your email if you’d like us to send the details there. We can still continue here on WhatsApp.",
        useAiRewrite: plusDefaults,
        maxSendsPerLead: 1,
        maxSendsPerConversation: 1,
      },
      {
        type: FollowUpRuleType.BEFORE_APPOINTMENT,
        name: "Appointment reminder",
        delayMinutes: 1440,
        messageTemplate: "Reminder: your {{serviceName}} appointment is scheduled for {{appointmentDate}} at {{appointmentTime}}.",
        useAiRewrite: plusDefaults,
        maxSendsPerLead: 1,
        maxSendsPerConversation: 1,
      },
      {
        type: FollowUpRuleType.AFTER_APPOINTMENT,
        name: "Post-appointment follow-up",
        delayMinutes: 120,
        messageTemplate: "Thanks for your time today. Was everything okay with the {{serviceName}} appointment?",
        useAiRewrite: true,
        maxSendsPerLead: 1,
        maxSendsPerConversation: 1,
      },
      {
        type: FollowUpRuleType.STALE_LEAD,
        name: "Stale lead follow-up",
        delayMinutes: 4320,
        messageTemplate: "Hi, are you still interested in this service?",
        useAiRewrite: true,
        maxSendsPerLead: 1,
        maxSendsPerConversation: 1,
      },
    ];
    await Promise.all(defaults.map((rule) => db.followUpAutomationRule.upsert({
      where: { businessId_type: { businessId, type: rule.type } },
      create: {
        businessId,
        createdByMembershipId,
        type: rule.type,
        name: rule.name,
        enabled: false,
        delayMinutes: rule.delayMinutes,
        messageTemplate: rule.messageTemplate,
        useAiRewrite: rule.useAiRewrite,
        maxSendsPerLead: rule.maxSendsPerLead,
        maxSendsPerConversation: rule.maxSendsPerConversation,
        onlyDuringBusinessHours: true,
        planRequired: requiredPlanForRuleType(rule.type),
      },
      update: {},
    })));
  },

  async getSettings(actor: FollowUpActor) {
    assertCanView(actor);
    await this.ensureDefaultRulesForBusiness(actor);
    const business = await prisma.business.findFirst({
      where: { id: actor.businessId, deletedAt: null },
      select: { id: true, followUpAutomationEnabled: true },
    });
    if (!business) throw new AppError(404, "Business not found.", "BUSINESS_NOT_FOUND");
    return business;
  },

  async updateSettings(actor: FollowUpActor, input: FollowUpSettingsInput) {
    assertCanManage(actor);
    const existing = await prisma.business.findUnique({ where: { id: actor.businessId }, select: { followUpAutomationEnabled: true } });
    let cancelledJobCount = 0;
    const updated = await prisma.business.update({
      where: { id: actor.businessId },
      data: { followUpAutomationEnabled: input.followUpAutomationEnabled },
      select: { id: true, followUpAutomationEnabled: true },
    });
    if (existing?.followUpAutomationEnabled && !updated.followUpAutomationEnabled) {
      const cancelled = await prisma.followUpJob.updateMany({
        where: { businessId: actor.businessId, status: FollowUpJobStatus.SCHEDULED },
        data: { status: FollowUpJobStatus.CANCELLED, cancelReason: "FOLLOW_UP_AUTOMATION_DISABLED" },
      });
      cancelledJobCount = cancelled.count;
      realtimeService.publish({
        type: "business.follow_up.jobs.cancelled_bulk",
        businessId: actor.businessId,
        payload: { reason: "FOLLOW_UP_AUTOMATION_DISABLED", cancelledJobCount },
        broadcastToStaff: true,
      });
    }
    await audit(actor, updated.followUpAutomationEnabled ? AuditAction.FOLLOW_UP_AUTOMATION_ENABLED : AuditAction.FOLLOW_UP_AUTOMATION_DISABLED, { followUpAutomationEnabled: updated.followUpAutomationEnabled, cancelledJobCount });
    const settings = { ...updated, cancelledJobCount };
    realtimeService.publish({ type: "business.follow_up.rule.updated", businessId: actor.businessId, payload: { settings }, broadcastToStaff: true });
    return settings;
  },

  async listRules(actor: FollowUpActor, query: FollowUpRuleListQuery) {
    assertCanView(actor);
    await this.ensureDefaultRulesForBusiness(actor);
    const policy = await followUpPlanPolicyService.policy(actor);
    const where: Prisma.FollowUpAutomationRuleWhereInput = {
      businessId: actor.businessId,
      ...(query.includeDeleted ? {} : { deletedAt: null }),
      ...(query.type ? { type: query.type } : {}),
      ...(query.enabled !== undefined ? { enabled: query.enabled } : {}),
      ...(query.includeLocked ? {} : { type: { in: policy.allowedRuleTypes } }),
    };
    const [data, total] = await prisma.$transaction([
      prisma.followUpAutomationRule.findMany({ where, include: ruleInclude, orderBy: [{ createdAt: "desc" }], skip: (query.page - 1) * query.limit, take: query.limit }),
      prisma.followUpAutomationRule.count({ where }),
    ]);
    return { data, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
  },

  async getRule(actor: FollowUpActor, ruleId: string) {
    assertCanView(actor);
    const rule = await prisma.followUpAutomationRule.findFirst({ where: { id: ruleId, businessId: actor.businessId, deletedAt: null }, include: ruleInclude });
    if (!rule) throw new AppError(404, "Follow-up rule not found.", "FOLLOW_UP_RULE_NOT_FOUND");
    return rule;
  },

  async createRule(actor: FollowUpActor, input: FollowUpRuleCreateInput) {
    assertCanManage(actor);
    const policy = await followUpPlanPolicyService.assertRuleAllowed(actor, { type: input.type });
    assertFollowUpRuleSettingsWithinPolicy(policy, {
      useAiRewrite: input.useAiRewrite,
      maxSendsPerLead: input.maxSendsPerLead,
      maxSendsPerConversation: input.maxSendsPerConversation,
    });
    const existingRule = await prisma.followUpAutomationRule.findFirst({
      where: { businessId: actor.businessId, type: input.type },
      select: { id: true, deletedAt: true },
    });
    if (existingRule) {
      if (existingRule.deletedAt) {
        const rule = await prisma.followUpAutomationRule.update({
          where: { id: existingRule.id },
          data: {
            ...input,
            deletedAt: null,
            planRequired: requiredPlanForRuleType(input.type),
            updatedByMembershipId: actor.membershipId,
          },
          include: ruleInclude,
        });
        await audit(actor, AuditAction.FOLLOW_UP_RULE_CREATED, { ruleId: rule.id, type: rule.type, restored: true });
        realtimeService.publish({ type: "business.follow_up.rule.created", businessId: actor.businessId, payload: { rule, restored: true }, broadcastToStaff: true });
        return rule;
      }
      throw new AppError(409, "A follow-up rule for this type already exists.", "FOLLOW_UP_RULE_ALREADY_EXISTS", {
        ruleId: existingRule.id,
        type: input.type,
        deleted: Boolean(existingRule.deletedAt),
      });
    }
    const rule = await prisma.followUpAutomationRule.create({
      data: { ...input, planRequired: requiredPlanForRuleType(input.type), businessId: actor.businessId, createdByMembershipId: actor.membershipId },
      include: ruleInclude,
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, "A follow-up rule for this type already exists.", "FOLLOW_UP_RULE_ALREADY_EXISTS", { type: input.type });
      }
      throw error;
    });
    await audit(actor, AuditAction.FOLLOW_UP_RULE_CREATED, { ruleId: rule.id, type: rule.type });
    realtimeService.publish({ type: "business.follow_up.rule.created", businessId: actor.businessId, payload: { rule }, broadcastToStaff: true });
    return rule;
  },

  async updateRule(actor: FollowUpActor, ruleId: string, input: FollowUpRuleUpdateInput) {
    assertCanManage(actor);
    const existing = await this.getRule(actor, ruleId);
    if (input.type && input.type !== existing.type) {
      throw new AppError(422, "Follow-up rule type cannot be changed after creation.", "FOLLOW_UP_RULE_TYPE_IMMUTABLE", {
        ruleId: existing.id,
        currentType: existing.type,
        requestedType: input.type,
      });
    }
    const type = existing.type;
    const policy = await followUpPlanPolicyService.assertRuleAllowed(actor, { type });
    assertFollowUpRuleSettingsWithinPolicy(policy, {
      useAiRewrite: input.useAiRewrite ?? existing.useAiRewrite,
      maxSendsPerLead: input.maxSendsPerLead ?? existing.maxSendsPerLead,
      maxSendsPerConversation: input.maxSendsPerConversation ?? existing.maxSendsPerConversation,
    });
    const { type: _ignoredType, ...updateData } = input;
    const rule = await prisma.followUpAutomationRule.update({
      where: { id: existing.id },
      data: { ...updateData, planRequired: requiredPlanForRuleType(type), updatedByMembershipId: actor.membershipId },
      include: ruleInclude,
    });
    await audit(actor, AuditAction.FOLLOW_UP_RULE_UPDATED, { ruleId: rule.id, changes: Object.keys(input) });
    realtimeService.publish({ type: "business.follow_up.rule.updated", businessId: actor.businessId, payload: { rule }, broadcastToStaff: true });
    return rule;
  },

  async deleteRule(actor: FollowUpActor, ruleId: string) {
    assertCanManage(actor);
    const existing = await this.getRule(actor, ruleId);
    const rule = await prisma.followUpAutomationRule.update({
      where: { id: existing.id },
      data: { enabled: false, deletedAt: new Date(), updatedByMembershipId: actor.membershipId },
      include: ruleInclude,
    });
    await prisma.followUpJob.updateMany({ where: { businessId: actor.businessId, ruleId, status: FollowUpJobStatus.SCHEDULED }, data: { status: FollowUpJobStatus.CANCELLED, cancelReason: "FOLLOW_UP_RULE_DELETED" } });
    await audit(actor, AuditAction.FOLLOW_UP_RULE_DELETED, { ruleId });
    realtimeService.publish({ type: "business.follow_up.rule.updated", businessId: actor.businessId, payload: { rule, deleted: true }, broadcastToStaff: true });
    return { message: "Follow-up rule disabled successfully.", rule };
  },

  async listJobs(actor: FollowUpActor, query: FollowUpJobListQuery) {
    assertCanView(actor);
    const where: Prisma.FollowUpJobWhereInput = {
      ...jobAccessWhere(actor),
      ...(query.status ? { status: query.status } : {}),
      ...(query.ruleId ? { ruleId: query.ruleId } : {}),
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...(query.conversationId ? { conversationId: query.conversationId } : {}),
      ...(query.appointmentId ? { appointmentId: query.appointmentId } : {}),
      ...(query.quoteId ? { quoteId: query.quoteId } : {}),
      ...(query.contextType ? { contextType: query.contextType } : {}),
      ...(query.from || query.to ? { scheduledFor: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
    };
    const [data, total] = await prisma.$transaction([
      prisma.followUpJob.findMany({ where, include: jobInclude, orderBy: [{ scheduledFor: "desc" }, { createdAt: "desc" }], skip: (query.page - 1) * query.limit, take: query.limit }),
      prisma.followUpJob.count({ where }),
    ]);
    return { data, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
  },

  async getJob(actor: FollowUpActor, jobId: string) {
    assertCanView(actor);
    const job = await prisma.followUpJob.findFirst({ where: { id: jobId, ...jobAccessWhere(actor) }, include: jobInclude });
    if (!job) throw new AppError(404, "Follow-up job not found.", "FOLLOW_UP_JOB_NOT_FOUND");
    return job;
  },

  async retryJob(actor: FollowUpActor, jobId: string, input: FollowUpJobRetryInput) {
    assertCanManage(actor);
    const job = await prisma.followUpJob.findFirst({ where: { id: jobId, businessId: actor.businessId }, include: jobInclude });
    if (!job) throw new AppError(404, "Follow-up job not found.", "FOLLOW_UP_JOB_NOT_FOUND");
    if (job.status !== FollowUpJobStatus.FAILED) {
      throw new AppError(409, "Only failed follow-up jobs can be retried.", "FOLLOW_UP_JOB_NOT_RETRYABLE", { status: job.status });
    }
    if (job.failureReason === "FOLLOW_UP_DELIVERY_PENDING_RECONCILIATION" || job.failureReason === "FOLLOW_UP_STALE_PROCESSING_PENDING_MESSAGE") {
      throw new AppError(409, "This follow-up has an ambiguous pending delivery and cannot be retried safely yet.", "FOLLOW_UP_DELIVERY_RECONCILIATION_REQUIRED");
    }
    const existingMessage = await prisma.message.findFirst({
      where: { businessId: actor.businessId, deletedAt: null, metadata: { path: ["jobId"], equals: job.id } },
      orderBy: { createdAt: "desc" },
    });
    if (existingMessage?.deliveryStatus === "PENDING" && typeof jsonObject(existingMessage.metadata).deliveryAttemptStartedAt === "string") {
      throw new AppError(409, "This follow-up has an ambiguous pending delivery and cannot be retried safely yet.", "FOLLOW_UP_DELIVERY_RECONCILIATION_REQUIRED", { messageId: existingMessage.id });
    }
    const scheduledFor = input.scheduledFor ?? new Date();
    const updated = await prisma.followUpJob.update({
      where: { id: job.id },
      data: {
        status: FollowUpJobStatus.SCHEDULED,
        scheduledFor,
        failureReason: null,
        processingStartedAt: null,
        sentAt: null,
      },
      include: jobInclude,
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, "A matching follow-up job is already scheduled.", "FOLLOW_UP_DUPLICATE_JOB");
      }
      throw error;
    });
    await audit(actor, AuditAction.FOLLOW_UP_JOB_RESCHEDULED, { jobId: updated.id, ruleId: updated.ruleId, reason: "MANUAL_RETRY", scheduledFor });
    realtimeService.publish({
      type: "business.follow_up.job.rescheduled",
      businessId: actor.businessId,
      conversationId: updated.conversationId ?? undefined,
      leadId: updated.leadId ?? undefined,
      payload: { job: updated, reason: "MANUAL_RETRY", retried: true },
      broadcastToStaff: true,
    });
    return updated;
  },

  async listLogs(actor: FollowUpActor, query: FollowUpLogListQuery) {
    assertCanView(actor);
    const where: Prisma.FollowUpSendLogWhereInput = {
      ...logAccessWhere(actor),
      ...(query.ruleId ? { ruleId: query.ruleId } : {}),
      ...(query.jobId ? { jobId: query.jobId } : {}),
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...(query.conversationId ? { conversationId: query.conversationId } : {}),
      ...(query.appointmentId ? { appointmentId: query.appointmentId } : {}),
      ...(query.quoteId ? { quoteId: query.quoteId } : {}),
      ...(query.deliveryStatus ? { deliveryStatus: query.deliveryStatus } : {}),
      ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
    };
    const [data, total] = await prisma.$transaction([
      prisma.followUpSendLog.findMany({ where, include: sendLogInclude, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.limit, take: query.limit }),
      prisma.followUpSendLog.count({ where }),
    ]);
    return { data, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
  },

  async getLog(actor: FollowUpActor, logId: string) {
    assertCanView(actor);
    const log = await prisma.followUpSendLog.findFirst({ where: { id: logId, ...logAccessWhere(actor) }, include: sendLogInclude });
    if (!log) throw new AppError(404, "Follow-up log not found.", "FOLLOW_UP_LOG_NOT_FOUND");
    return log;
  },

  scheduleNoResponseAfterOutboundMessage: followUpBasicService.scheduleNoResponseAfterOutboundMessage,
  scheduleContactEmailRequestForAppointment: followUpBasicService.scheduleContactEmailRequestForAppointment,
  scheduleAppointmentReminder: followUpBasicService.scheduleAppointmentReminder,
  schedulePostAppointmentFollowUp: followUpPlusService.schedulePostAppointmentFollowUp,
  scheduleStaleLeadFollowUp: followUpPlusService.scheduleStaleLeadFollowUp,
  cancelAppointmentReminderJobs: followUpCancellationService.cancelAppointmentReminderJobs,
  cancelPostAppointmentFollowUpJobs: followUpCancellationService.cancelPostAppointmentFollowUpJobs,

  async testTrigger(actor: FollowUpActor, input: FollowUpTestTriggerInput) {
    assertCanManage(actor);
    if (process.env.NODE_ENV === "production") throw new AppError(404, "Follow-up test trigger is not available.", "NOT_FOUND");
    return followUpJobSchedulerService.scheduleFollowUpJob(actor, input);
  },
};
