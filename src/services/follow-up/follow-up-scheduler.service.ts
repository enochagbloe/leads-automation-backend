
import { AuditAction, FollowUpJobStatus, Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import { FollowUpTestTriggerInput } from "../../validation/follow-up.schemas";
import { realtimeService } from "../realtime.service";
import { followUpPlanPolicyService } from "./follow-up-policy.service";
import { FollowUpActor } from "./follow-up.types";
import { audit, followUpJobDedupeKey, jobInclude, validateRuleTargets } from "./follow-up.shared";

// Base/shared section: manual/test job scheduling.
export const followUpJobSchedulerService = {
  async scheduleFollowUpJob(actor: FollowUpActor, input: FollowUpTestTriggerInput) {
    await validateRuleTargets(actor, input);
    const rule = await prisma.followUpAutomationRule.findFirst({ where: { id: input.ruleId, businessId: actor.businessId, deletedAt: null } });
    if (!rule) throw new AppError(404, "Follow-up rule not found.", "FOLLOW_UP_RULE_NOT_FOUND");
    const business = await prisma.business.findUnique({ where: { id: actor.businessId }, select: { followUpAutomationEnabled: true } });
    if (!business?.followUpAutomationEnabled) throw new AppError(403, "Follow-up automation is disabled.", "FOLLOW_UP_AUTOMATION_DISABLED");
    if (!rule.enabled) throw new AppError(422, "Follow-up rule is disabled.", "FOLLOW_UP_RULE_DISABLED");
    await followUpPlanPolicyService.assertRuleAllowed(actor, { type: rule.type });
    const scheduledFor = input.scheduledFor ?? new Date(Date.now() + rule.delayMinutes * 60_000);
    const dedupeKey = followUpJobDedupeKey({
      businessId: actor.businessId,
      ruleId: rule.id,
      contextType: input.contextType,
      leadId: input.leadId ?? null,
      conversationId: input.conversationId ?? null,
      appointmentId: input.appointmentId ?? null,
      quoteId: input.quoteId ?? null,
      relatedMessageId: input.relatedMessageId ?? null,
    });
    const created = await prisma.$transaction(async (tx) => {
      const duplicate = await tx.followUpJob.findFirst({
        where: {
          businessId: actor.businessId,
          dedupeKey,
          status: FollowUpJobStatus.SCHEDULED,
        },
      });
      if (duplicate) throw new AppError(409, "A matching follow-up job is already scheduled.", "FOLLOW_UP_DUPLICATE_JOB", { jobId: duplicate.id });
      return tx.followUpJob.create({
        data: {
          businessId: actor.businessId,
          ruleId: rule.id,
          leadId: input.leadId ?? null,
          conversationId: input.conversationId ?? null,
          appointmentId: input.appointmentId ?? null,
          quoteId: input.quoteId ?? null,
          contextType: input.contextType,
          dedupeKey,
          pendingQuestion: input.pendingQuestion ?? null,
          expectedResponseType: input.expectedResponseType ?? null,
          relatedMessageId: input.relatedMessageId ?? null,
          scheduledFor,
        },
        include: jobInclude,
      });
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, "A matching follow-up job is already scheduled.", "FOLLOW_UP_DUPLICATE_JOB");
      }
      throw error;
    });
    await audit(actor, AuditAction.FOLLOW_UP_JOB_SCHEDULED, { ruleId: rule.id, jobId: created.id, contextType: created.contextType, leadId: created.leadId, conversationId: created.conversationId });
    realtimeService.publish({ type: "business.follow_up.job.scheduled", businessId: actor.businessId, conversationId: created.conversationId ?? undefined, leadId: created.leadId ?? undefined, payload: { job: created }, broadcastToStaff: true });
    return created;
  },
};
