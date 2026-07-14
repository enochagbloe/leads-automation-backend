import { AuditAction, CustomerIssueStatus, FollowUpContextType, FollowUpJobStatus } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import { auditService } from "../audit.service";
import { realtimeService } from "../realtime.service";
import { followUpContextEvaluationService } from "./follow-up-context-evaluation.service";
import { FollowUpActor } from "./follow-up.types";
import { audit, jobAccessWhere, jobInclude, json } from "./follow-up.shared";

export const followUpCancellationService = {
  async cancelJob(actor: FollowUpActor, jobId: string, reason: string) {
    const job = await prisma.followUpJob.findFirst({ where: { id: jobId, ...jobAccessWhere(actor) }, include: jobInclude });
    if (!job) throw new AppError(404, "Follow-up job not found.", "FOLLOW_UP_JOB_NOT_FOUND");
    if (job.status !== FollowUpJobStatus.SCHEDULED) return job;
    const changed = await prisma.followUpJob.updateMany({
      where: { id: job.id, businessId: actor.businessId, status: FollowUpJobStatus.SCHEDULED },
      data: { status: FollowUpJobStatus.CANCELLED, cancelReason: reason },
    });
    if (changed.count !== 1) {
      throw new AppError(409, "Follow-up job changed. Refresh and try again.", "FOLLOW_UP_JOB_STATE_CHANGED");
    }
    const updated = await prisma.followUpJob.findUniqueOrThrow({ where: { id: job.id }, include: jobInclude });
    await audit(actor, AuditAction.FOLLOW_UP_JOB_CANCELLED, { jobId: updated.id, ruleId: updated.ruleId, reason });
    realtimeService.publish({ type: "business.follow_up.job.cancelled", businessId: actor.businessId, conversationId: updated.conversationId ?? undefined, leadId: updated.leadId ?? undefined, payload: { job: updated, reason }, broadcastToStaff: true });
    return updated;
  },

  async evaluateInboundReply(input: {
    businessId: string;
    conversationId: string;
    leadId: string;
    inboundMessageId: string;
    inboundMessageText: string;
  }) {
    const pendingJobs = await prisma.followUpJob.findMany({
      where: { businessId: input.businessId, conversationId: input.conversationId, status: FollowUpJobStatus.SCHEDULED },
      select: { id: true, contextType: true, pendingQuestion: true, expectedResponseType: true },
    });
    if (pendingJobs.length === 0) return [];
    const openIssue = await prisma.customerIssueLog.findFirst({
      where: {
        businessId: input.businessId,
        conversationId: input.conversationId,
        leadId: input.leadId,
        status: { in: [CustomerIssueStatus.OPEN, CustomerIssueStatus.ACKNOWLEDGED, CustomerIssueStatus.REOPENED] },
      },
      select: { id: true },
    });
    const postAppointmentJobIds = new Set(
      pendingJobs
        .filter((job) => job.contextType === FollowUpContextType.POST_APPOINTMENT_FEEDBACK)
        .map((job) => job.id),
    );
    const evaluatedResults = await followUpContextEvaluationService.evaluateInboundReplyAgainstPendingJobs({ ...input, pendingJobs });
    const results = openIssue
      ? evaluatedResults.map((result) => postAppointmentJobIds.has(result.jobId)
        ? {
          ...result,
          doesReplyAddressPendingContext: true,
          pendingContextResolved: true,
          replyIntent: "CUSTOMER_ISSUE_OPEN",
          action: "CANCEL_FOLLOW_UP" as const,
          reason: "Customer issue is open for this conversation, so complaint handling owns the post-appointment follow-up.",
        }
        : result)
      : evaluatedResults;
    for (const result of results) {
      if (result.action === "CANCEL_FOLLOW_UP") {
        await prisma.followUpJob.updateMany({
          where: { id: result.jobId, businessId: input.businessId, status: FollowUpJobStatus.SCHEDULED },
          data: { status: FollowUpJobStatus.CANCELLED, cancelReason: result.reason },
        });
      }
      await auditService.log({
        action: AuditAction.FOLLOW_UP_CONTEXT_EVALUATED,
        businessId: input.businessId,
        metadata: json({ ...result, conversationId: input.conversationId, leadId: input.leadId, inboundMessageId: input.inboundMessageId }),
      });
      realtimeService.publish({
        type: "business.follow_up.context.evaluated",
        businessId: input.businessId,
        conversationId: input.conversationId,
        leadId: input.leadId,
        payload: result,
        broadcastToStaff: true,
      });
    }
    const emailResult = results.find((result) => result.extractedFields.email);
    if (emailResult?.extractedFields.email) {
      await prisma.lead.updateMany({
        where: { id: input.leadId, businessId: input.businessId, email: null },
        data: { email: emailResult.extractedFields.email },
      });
    }
    return results;
  },

  async cancelAppointmentReminderJobs(input: { businessId: string; appointmentId: string; reason: string }) {
    const cancelled = await prisma.followUpJob.updateMany({
      where: {
        businessId: input.businessId,
        appointmentId: input.appointmentId,
        contextType: FollowUpContextType.APPOINTMENT_CONFIRMATION,
        status: FollowUpJobStatus.SCHEDULED,
      },
      data: { status: FollowUpJobStatus.CANCELLED, cancelReason: input.reason },
    });
    if (cancelled.count > 0) {
      await auditService.log({
        action: AuditAction.FOLLOW_UP_JOB_CANCELLED,
        businessId: input.businessId,
        metadata: json({ appointmentId: input.appointmentId, reason: input.reason, cancelledJobCount: cancelled.count }),
      });
    }
    return cancelled;
  },

  async cancelPostAppointmentFollowUpJobs(input: { businessId: string; appointmentId: string; reason: string }) {
    const cancelled = await prisma.followUpJob.updateMany({
      where: {
        businessId: input.businessId,
        appointmentId: input.appointmentId,
        contextType: FollowUpContextType.POST_APPOINTMENT_FEEDBACK,
        status: FollowUpJobStatus.SCHEDULED,
      },
      data: { status: FollowUpJobStatus.CANCELLED, cancelReason: input.reason },
    });
    if (cancelled.count > 0) {
      await auditService.log({
        action: AuditAction.FOLLOW_UP_JOB_CANCELLED,
        businessId: input.businessId,
        metadata: json({ appointmentId: input.appointmentId, reason: input.reason, cancelledJobCount: cancelled.count }),
      });
    }
    return cancelled;
  },
};
