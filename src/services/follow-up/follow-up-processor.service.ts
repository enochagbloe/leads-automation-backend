import { AppointmentStatus, AuditAction, ConversationChannel, FollowUpJobStatus, FollowUpRuleType, FollowUpSendLogDeliveryStatus, FollowUpSendLogSentBy, LeadActivityAction, MessageDeliveryStatus, MessageDirection, MessageSenderType, MessageType, SubscriptionStatus } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { auditService } from "../audit.service";
import { realtimeService } from "../realtime.service";
import { getWhatsAppIntegration, sendWhatsAppText } from "../whatsapp-provider.service";
import { followUpEligibilityService } from "./follow-up-eligibility.service";
import { defaultMonthlyLimit, ruleTypesForPlan } from "./follow-up-policy.service";
import { followUpTemplateRendererService } from "./follow-up-template.service";
import { FOLLOW_UP_PROCESSING_STALE_MS, FOLLOW_UP_DELIVERED_MESSAGE_STATUSES, jsonObject, businessHoursFollowUpDecision, nextFollowUpAllowedAfterCooldown, humanDate, humanTime, lockFollowUpMonthlyQuotaScope, FOLLOW_UP_MONTHLY_LIMIT_DELIVERY_STATUSES, cancelNoResponseFollowUpIfCustomerReplied, json } from "./follow-up.shared";
import { followUpAiRewriteService } from "./follow-up-ai-rewrite.service";
import { followUpBasicService } from "./follow-up-basic.service";

function basicSentAuditAction(type: FollowUpRuleType) {
  if (type === FollowUpRuleType.CONTACT_EMAIL_REQUEST) return AuditAction.BASIC_CONTACT_EMAIL_REQUEST_SENT;
  if (type === FollowUpRuleType.BEFORE_APPOINTMENT) return AuditAction.BASIC_APPOINTMENT_REMINDER_SENT;
  if (type === FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE) return AuditAction.BASIC_NO_RESPONSE_FOLLOW_UP_SENT;
  return AuditAction.FOLLOW_UP_JOB_SENT;
}

function basicSentEventType(type: FollowUpRuleType) {
  if (type === FollowUpRuleType.CONTACT_EMAIL_REQUEST) return "business.follow_up.basic.contact_email.sent" as const;
  if (type === FollowUpRuleType.BEFORE_APPOINTMENT) return "business.follow_up.basic.appointment_reminder.sent" as const;
  if (type === FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE) return "business.follow_up.basic.no_response.sent" as const;
  return "business.follow_up.job.sent" as const;
}

function sentUsageEvent(type: FollowUpRuleType) {
  if (type === FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE) return "PLUS_FOLLOW_UP_NO_RESPONSE_SENT";
  if (type === FollowUpRuleType.AFTER_APPOINTMENT) return "PLUS_POST_APPOINTMENT_FOLLOW_UP_SENT";
  if (type === FollowUpRuleType.STALE_LEAD) return "PLUS_STALE_LEAD_FOLLOW_UP_SENT";
  return "FOLLOW_UP_JOB_SENT";
}

// Base/shared section: crash recovery for jobs claimed by a previous processor run.
async function recoverStaleProcessingJobs(businessId: string, now = new Date()) {
  const staleBefore = new Date(now.getTime() - FOLLOW_UP_PROCESSING_STALE_MS);
  const staleJobs = await prisma.followUpJob.findMany({
    where: {
      businessId,
      status: FollowUpJobStatus.PROCESSING,
      processingStartedAt: { lt: staleBefore },
    },
    orderBy: { processingStartedAt: "asc" },
    take: 100,
  });
  for (const job of staleJobs) {
    const sendLog = await prisma.followUpSendLog.findFirst({
      where: { businessId, jobId: job.id },
      orderBy: { createdAt: "desc" },
    });
    if (sendLog?.deliveryStatus === FollowUpSendLogDeliveryStatus.SENT) {
      const changed = await prisma.followUpJob.updateMany({
        where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING, processingStartedAt: job.processingStartedAt },
        data: { status: FollowUpJobStatus.SENT, sentAt: sendLog.createdAt, processingStartedAt: null, failureReason: null },
      });
      if (changed.count === 1) {
        await auditService.log({ action: AuditAction.FOLLOW_UP_JOB_SENT, businessId, metadata: json({ jobId: job.id, recoveredFromStaleProcessing: true, sendLogId: sendLog.id }) });
      }
      continue;
    }
    if (sendLog?.deliveryStatus === FollowUpSendLogDeliveryStatus.FAILED) {
      const changed = await prisma.followUpJob.updateMany({
        where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING, processingStartedAt: job.processingStartedAt },
        data: { status: FollowUpJobStatus.FAILED, failureReason: sendLog.failureReason ?? "FOLLOW_UP_SEND_FAILED", processingStartedAt: null },
      });
      if (changed.count === 1) {
        await auditService.log({ action: AuditAction.FOLLOW_UP_JOB_FAILED, businessId, metadata: json({ jobId: job.id, recoveredFromStaleProcessing: true, sendLogId: sendLog.id, reason: sendLog.failureReason ?? "FOLLOW_UP_SEND_FAILED" }) });
      }
      continue;
    }

    const message = await prisma.message.findFirst({
      where: {
        businessId,
        deletedAt: null,
        metadata: { path: ["jobId"], equals: job.id },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!message) {
      const changed = await prisma.followUpJob.updateMany({
        where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING, processingStartedAt: job.processingStartedAt },
        data: { status: FollowUpJobStatus.SCHEDULED, processingStartedAt: null, failureReason: null },
      });
      if (changed.count === 1) {
        await auditService.log({ action: AuditAction.FOLLOW_UP_JOB_RESCHEDULED, businessId, metadata: json({ jobId: job.id, reason: "STALE_PROCESSING_RECOVERED", processingStartedAt: job.processingStartedAt }) });
      }
      continue;
    }

        if (FOLLOW_UP_DELIVERED_MESSAGE_STATUSES.includes(message.deliveryStatus)) {
          const changed = await prisma.followUpJob.updateMany({
            where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING, processingStartedAt: job.processingStartedAt },
            data: { status: FollowUpJobStatus.SENT, sentAt: message.createdAt, processingStartedAt: null, failureReason: null },
      });
      if (changed.count === 1) {
        await auditService.log({ action: AuditAction.FOLLOW_UP_JOB_SENT, businessId, metadata: json({ jobId: job.id, recoveredFromStaleProcessing: true, messageId: message.id, deliveryStatus: message.deliveryStatus }) });
          }
          continue;
        }

        const messageMetadata = jsonObject(message.metadata);
        if (message.deliveryStatus === MessageDeliveryStatus.PENDING && typeof messageMetadata.deliveryAttemptStartedAt !== "string") {
          const changed = await prisma.followUpJob.updateMany({
            where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING, processingStartedAt: job.processingStartedAt },
            data: { status: FollowUpJobStatus.SCHEDULED, processingStartedAt: null, failureReason: null },
          });
          if (changed.count === 1) {
            await auditService.log({ action: AuditAction.FOLLOW_UP_JOB_RESCHEDULED, businessId, metadata: json({ jobId: job.id, reason: "STALE_PROCESSING_RECOVERED_BEFORE_DELIVERY_ATTEMPT", processingStartedAt: job.processingStartedAt, messageId: message.id }) });
          }
          continue;
        }

        const reason = message.deliveryStatus === MessageDeliveryStatus.FAILED
          ? "FOLLOW_UP_MESSAGE_FAILED"
      : "FOLLOW_UP_STALE_PROCESSING_PENDING_MESSAGE";
    const changed = await prisma.followUpJob.updateMany({
      where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING, processingStartedAt: job.processingStartedAt },
      data: { status: FollowUpJobStatus.FAILED, failureReason: reason, processingStartedAt: null },
    });
    if (changed.count === 1) {
      await auditService.log({
        action: AuditAction.FOLLOW_UP_JOB_FAILED,
        businessId,
        metadata: json({
          jobId: job.id,
          recoveredFromStaleProcessing: true,
          messageId: message.id,
          deliveryStatus: message.deliveryStatus,
          reason,
        }),
      });
    }
  }
}

// Base processor with Basic delivery behavior.
// Plus/Premium rule types are allowed through policy, but richer tier-specific send logic should be split out later.
export const followUpJobProcessorService = {
  async reconcilePendingDeliveries(businessId: string, olderThanMinutes = 15, limit = 100) {
    const staleBefore = new Date(Date.now() - Math.max(1, olderThanMinutes) * 60_000);
    const messages = await prisma.message.findMany({
      where: {
        businessId,
        deletedAt: null,
        direction: MessageDirection.OUTBOUND,
        senderType: MessageSenderType.SYSTEM,
        metadata: { path: ["source"], equals: "FOLLOW_UP_AUTOMATION" },
        OR: [
          { deliveryStatus: MessageDeliveryStatus.PENDING, metadata: { path: ["deliveryAttemptStartedAt"], lt: staleBefore.toISOString() } },
          { deliveryStatus: { in: FOLLOW_UP_DELIVERED_MESSAGE_STATUSES } },
          { deliveryStatus: MessageDeliveryStatus.FAILED },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    });

    const reconciled = [];
    for (const message of messages) {
      const metadata = jsonObject(message.metadata);
      const jobId = typeof metadata.jobId === "string" ? metadata.jobId : null;
      const ruleId = typeof metadata.ruleId === "string" ? metadata.ruleId : null;
      if (!jobId || !ruleId) continue;

      const result = await prisma.$transaction(async (tx) => {
        const job = await tx.followUpJob.findFirst({
          where: {
            id: jobId,
            businessId,
            status: { in: [FollowUpJobStatus.PROCESSING, FollowUpJobStatus.FAILED] },
            OR: [
              { failureReason: "FOLLOW_UP_DELIVERY_PENDING_RECONCILIATION" },
              { failureReason: "FOLLOW_UP_STALE_PROCESSING_PENDING_MESSAGE" },
              { processingStartedAt: { not: null } },
            ],
          },
        });
        if (!job) return null;

        if (FOLLOW_UP_DELIVERED_MESSAGE_STATUSES.includes(message.deliveryStatus)) {
          const updatedJob = await tx.followUpJob.update({
            where: { id: job.id },
            data: { status: FollowUpJobStatus.SENT, sentAt: message.updatedAt, processingStartedAt: null, failureReason: null },
          });
          await tx.followUpSendLog.upsert({
            where: { id: `reconciled_${job.id}` },
            create: {
              id: `reconciled_${job.id}`,
              businessId,
              ruleId: job.ruleId,
              jobId: job.id,
              leadId: job.leadId,
              conversationId: job.conversationId,
              appointmentId: job.appointmentId,
              quoteId: job.quoteId,
              messageText: message.content,
              sentBy: FollowUpSendLogSentBy.SYSTEM,
              deliveryStatus: FollowUpSendLogDeliveryStatus.SENT,
              whatsappMessageId: message.providerMessageId,
            },
            update: {
              deliveryStatus: FollowUpSendLogDeliveryStatus.SENT,
              whatsappMessageId: message.providerMessageId,
              failureReason: null,
            },
          });
          return { job: updatedJob, message, reason: "FOLLOW_UP_DELIVERY_RECONCILED_SENT" };
        }

        if (message.deliveryStatus === MessageDeliveryStatus.FAILED) {
          const updatedJob = await tx.followUpJob.update({
            where: { id: job.id },
            data: { status: FollowUpJobStatus.FAILED, failureReason: "FOLLOW_UP_DELIVERY_RECONCILED_FAILED", processingStartedAt: null },
          });
          await tx.followUpSendLog.upsert({
            where: { id: `reconciled_${job.id}` },
            create: {
              id: `reconciled_${job.id}`,
              businessId,
              ruleId: job.ruleId,
              jobId: job.id,
              leadId: job.leadId,
              conversationId: job.conversationId,
              appointmentId: job.appointmentId,
              quoteId: job.quoteId,
              messageText: message.content,
              sentBy: FollowUpSendLogSentBy.SYSTEM,
              deliveryStatus: FollowUpSendLogDeliveryStatus.FAILED,
              whatsappMessageId: message.providerMessageId,
              failureReason: "FOLLOW_UP_DELIVERY_RECONCILED_FAILED",
            },
            update: {
              deliveryStatus: FollowUpSendLogDeliveryStatus.FAILED,
              whatsappMessageId: message.providerMessageId,
              failureReason: "FOLLOW_UP_DELIVERY_RECONCILED_FAILED",
            },
          });
          return { job: updatedJob, message, reason: "FOLLOW_UP_DELIVERY_RECONCILED_FAILED" };
        }

        const updatedJob = await tx.followUpJob.update({
          where: { id: job.id },
          data: { status: FollowUpJobStatus.FAILED, failureReason: "FOLLOW_UP_DELIVERY_PENDING_RECONCILIATION", processingStartedAt: null },
        });
        return { job: updatedJob, message, reason: "FOLLOW_UP_DELIVERY_PENDING_RECONCILIATION" };
      });

      if (!result) continue;
      await auditService.log({
        action: result.job.status === FollowUpJobStatus.SENT ? AuditAction.FOLLOW_UP_JOB_SENT : AuditAction.FOLLOW_UP_JOB_FAILED,
        businessId,
        metadata: json({
          jobId: result.job.id,
          messageId: result.message.id,
          providerMessageId: result.message.providerMessageId,
          deliveryStatus: result.message.deliveryStatus,
          reason: result.reason,
          reconciled: true,
        }),
      });
      reconciled.push(result.job);
    }
    return reconciled;
  },

  async processDueJobs(businessId: string, limit = 25) {
    const now = new Date();
    await recoverStaleProcessingJobs(businessId, now);
    const jobs = await prisma.followUpJob.findMany({
      where: { businessId, status: FollowUpJobStatus.SCHEDULED, scheduledFor: { lte: now } },
      orderBy: { scheduledFor: "asc" },
      take: limit,
      include: {
        rule: true,
        lead: true,
        conversation: true,
        appointment: { include: { service: { select: { name: true } } } },
        business: true,
      },
    });
    const results = [];
    for (const job of jobs) {
      const claimedAt = new Date();
      const claimed = await prisma.followUpJob.updateMany({
        where: {
          id: job.id,
          businessId,
          status: FollowUpJobStatus.SCHEDULED,
          scheduledFor: { lte: claimedAt },
        },
        data: {
          status: FollowUpJobStatus.PROCESSING,
          processingStartedAt: claimedAt,
        },
      });
      if (claimed.count !== 1) continue;

      if (job.rule.onlyDuringBusinessHours) {
        const businessHoursOutcome = await prisma.$transaction(async (tx) => {
          const decision = await businessHoursFollowUpDecision(tx, businessId, claimedAt);
          if (decision.allowedNow) return null;
          if (decision.nextOpening) {
            const rescheduled = await tx.followUpJob.updateMany({
              where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
              data: { status: FollowUpJobStatus.SCHEDULED, scheduledFor: decision.nextOpening, processingStartedAt: null },
            });
            if (rescheduled.count !== 1) return null;
            return {
              job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }),
              reason: "FOLLOW_UP_OUTSIDE_BUSINESS_HOURS",
              rescheduledFor: decision.nextOpening,
            };
          }
          const skipped = await tx.followUpJob.updateMany({
            where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
            data: { status: FollowUpJobStatus.SKIPPED, skipReason: "BUSINESS_HOURS_UNAVAILABLE", processingStartedAt: null },
          });
          if (skipped.count !== 1) return null;
          return {
            job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }),
            reason: "BUSINESS_HOURS_UNAVAILABLE",
            rescheduledFor: null,
          };
        });
        if (businessHoursOutcome) {
          await auditService.log({
            action: businessHoursOutcome.rescheduledFor ? AuditAction.FOLLOW_UP_JOB_RESCHEDULED : AuditAction.FOLLOW_UP_JOB_SKIPPED,
            businessId,
            metadata: json({ jobId: job.id, reason: businessHoursOutcome.reason, rescheduledFor: businessHoursOutcome.rescheduledFor }),
          });
          results.push(businessHoursOutcome.job);
          continue;
        }
      }

      const cooldownOutcome = await prisma.$transaction(async (tx) => {
        const nextAllowedAt = await nextFollowUpAllowedAfterCooldown(tx, job, new Date());
        if (!nextAllowedAt) return null;
        const rescheduled = await tx.followUpJob.updateMany({
          where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
          data: { status: FollowUpJobStatus.SCHEDULED, scheduledFor: nextAllowedAt, processingStartedAt: null },
        });
        if (rescheduled.count !== 1) return null;
        return { job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }), reason: "FOLLOW_UP_COOLDOWN_ACTIVE", rescheduledFor: nextAllowedAt };
      });
      if (cooldownOutcome) {
        await auditService.log({
          action: AuditAction.FOLLOW_UP_JOB_RESCHEDULED,
          businessId,
          metadata: json({ jobId: job.id, reason: cooldownOutcome.reason, rescheduledFor: cooldownOutcome.rescheduledFor }),
        });
        results.push(cooldownOutcome.job);
        continue;
      }

      const eligibility = await followUpEligibilityService.checkJob(job.id);
      if (!eligibility.eligible) {
        const status = eligibility.action === "CANCEL" ? FollowUpJobStatus.CANCELLED : FollowUpJobStatus.SKIPPED;
        const updated = await prisma.followUpJob.updateMany({
          where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
          data: {
            status,
            processingStartedAt: null,
            ...(status === FollowUpJobStatus.CANCELLED ? { cancelReason: eligibility.reason } : { skipReason: eligibility.reason }),
          },
        });
        if (updated.count !== 1) continue;
        const record = await prisma.followUpJob.findUniqueOrThrow({ where: { id: job.id } });
        await auditService.log({ action: status === FollowUpJobStatus.CANCELLED ? AuditAction.FOLLOW_UP_JOB_CANCELLED : AuditAction.FOLLOW_UP_JOB_SKIPPED, businessId, metadata: json({ jobId: job.id, reason: eligibility.reason }) });
        results.push(record);
        continue;
      }
      const renderedMessageText = followUpTemplateRendererService.render(job.rule.messageTemplate, {
        customerName: job.lead?.fullName,
        businessName: job.business.name,
        serviceName: job.appointment?.service?.name,
        appointmentDate: job.appointment ? humanDate(job.appointment.startTime, job.appointment.timezone) : null,
        appointmentTime: job.appointment ? humanTime(job.appointment.startTime, job.appointment.timezone) : null,
      });
      const rewrite = job.rule.useAiRewrite
        ? await followUpAiRewriteService.rewrite({
          businessId,
          businessAccountId: job.business.businessAccountId,
          businessName: job.business.name,
          ruleType: job.rule.type,
          contextType: job.contextType,
          renderedTemplate: renderedMessageText,
        })
        : { text: renderedMessageText, usedAiRewrite: false, failed: false, reason: null };
      const messageText = rewrite.text;
      if (rewrite.usedAiRewrite || rewrite.failed) {
        await auditService.log({
          action: AuditAction.FOLLOW_UP_CONTEXT_EVALUATED,
          businessId,
          metadata: json({
            jobId: job.id,
            ruleId: job.ruleId,
            usageEvent: rewrite.usedAiRewrite ? "PLUS_AI_REWRITE_USED" : "PLUS_AI_REWRITE_FAILED",
            reason: rewrite.reason,
            aiRewrite: "providerMetadata" in rewrite ? rewrite.providerMetadata : null,
          }),
        });
      }
      if (!job.conversationId || !job.leadId || !job.lead?.phone || job.conversation?.channel !== ConversationChannel.WHATSAPP) {
        const failed = await prisma.$transaction(async (tx) => {
          const markedFailed = await tx.followUpJob.updateMany({
            where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
            data: { status: FollowUpJobStatus.FAILED, failureReason: "WHATSAPP_NOT_CONNECTED", processingStartedAt: null },
          });
          if (markedFailed.count !== 1) return null;
          await tx.followUpSendLog.create({
            data: {
              businessId,
              ruleId: job.ruleId,
              jobId: job.id,
              leadId: job.leadId,
              conversationId: job.conversationId,
              appointmentId: job.appointmentId,
              quoteId: job.quoteId,
              messageText,
              sentBy: rewrite.usedAiRewrite ? FollowUpSendLogSentBy.AI : FollowUpSendLogSentBy.SYSTEM,
              deliveryStatus: FollowUpSendLogDeliveryStatus.FAILED,
              failureReason: "WHATSAPP_NOT_CONNECTED",
            },
          });
          return tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } });
        });
        if (!failed) continue;
        await auditService.log({ action: AuditAction.FOLLOW_UP_JOB_FAILED, businessId, metadata: json({ jobId: job.id, ruleId: job.ruleId, reason: "WHATSAPP_NOT_CONNECTED" }) });
        realtimeService.publish({ type: "business.follow_up.job.failed", businessId, conversationId: job.conversationId ?? undefined, leadId: job.leadId ?? undefined, payload: { job: failed, reason: "WHATSAPP_NOT_CONNECTED" }, broadcastToStaff: true });
        results.push(failed);
        continue;
      }
      const conversationId = job.conversationId;
      const leadId = job.leadId;
      const destinationPhone = job.lead.phone;

      let integration;
      try {
        integration = await getWhatsAppIntegration(businessId);
      } catch {
        const failed = await prisma.$transaction(async (tx) => {
          const markedFailed = await tx.followUpJob.updateMany({
            where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
            data: { status: FollowUpJobStatus.FAILED, failureReason: "WHATSAPP_NOT_CONNECTED", processingStartedAt: null },
          });
          if (markedFailed.count !== 1) return null;
          await tx.followUpSendLog.create({
            data: {
              businessId,
              ruleId: job.ruleId,
              jobId: job.id,
              leadId: job.leadId,
              conversationId: job.conversationId,
              appointmentId: job.appointmentId,
              quoteId: job.quoteId,
              messageText,
              sentBy: rewrite.usedAiRewrite ? FollowUpSendLogSentBy.AI : FollowUpSendLogSentBy.SYSTEM,
              deliveryStatus: FollowUpSendLogDeliveryStatus.FAILED,
              failureReason: "WHATSAPP_NOT_CONNECTED",
            },
          });
          return tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } });
        });
        if (!failed) continue;
        await auditService.log({ action: AuditAction.FOLLOW_UP_JOB_FAILED, businessId, metadata: json({ jobId: job.id, ruleId: job.ruleId, reason: "WHATSAPP_NOT_CONNECTED" }) });
        realtimeService.publish({ type: "business.follow_up.job.failed", businessId, conversationId: job.conversationId, leadId: job.leadId, payload: { job: failed, reason: "WHATSAPP_NOT_CONNECTED" }, broadcastToStaff: true });
        results.push(failed);
        continue;
      }

      const prepared = await prisma.$transaction(async (tx) => {
        const stopProcessing = async (input: { status: "CANCELLED" | "SKIPPED"; reason: string }) => {
          const stopped = await tx.followUpJob.updateMany({
            where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
            data: {
              status: input.status,
              processingStartedAt: null,
              ...(input.status === FollowUpJobStatus.CANCELLED ? { cancelReason: input.reason } : { skipReason: input.reason }),
            },
          });
          if (stopped.count !== 1) return null;
          return { job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }), sent: false as const, reason: input.reason };
        };

        const currentJob = await tx.followUpJob.findFirst({
          where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
          include: { rule: true, business: true },
        });
        if (!currentJob) return null;
        if (!currentJob.business.followUpAutomationEnabled) {
          return stopProcessing({ status: FollowUpJobStatus.CANCELLED, reason: "FOLLOW_UP_AUTOMATION_DISABLED" });
        }
        if (!currentJob.rule.enabled || currentJob.rule.deletedAt) {
          return stopProcessing({ status: FollowUpJobStatus.SKIPPED, reason: "FOLLOW_UP_RULE_DISABLED" });
        }
        if (currentJob.rule.type === FollowUpRuleType.AFTER_QUOTE_SENT) {
          return stopProcessing({ status: FollowUpJobStatus.SKIPPED, reason: "FOLLOW_UP_DEPENDENCY_NOT_READY" });
        }

        await lockFollowUpMonthlyQuotaScope(tx, currentJob.business.businessAccountId);
        const subscription = await tx.subscription.findFirst({
          where: { businessAccountId: currentJob.business.businessAccountId, status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] } },
          include: { plan: true },
          orderBy: { createdAt: "desc" },
        });
        if (!subscription) {
          return stopProcessing({ status: FollowUpJobStatus.SKIPPED, reason: "SUBSCRIPTION_INACTIVE" });
        }
        if (!ruleTypesForPlan(subscription.plan.code).includes(currentJob.rule.type)) {
          return stopProcessing({ status: FollowUpJobStatus.SKIPPED, reason: "PLAN_UPGRADE_REQUIRED" });
        }
        const monthlySends = await tx.followUpSendLog.count({
          where: {
            business: { businessAccountId: currentJob.business.businessAccountId },
            deliveryStatus: { in: [...FOLLOW_UP_MONTHLY_LIMIT_DELIVERY_STATUSES] },
            createdAt: { gte: subscription.currentPeriodStart, lt: subscription.currentPeriodEnd },
          },
        });
        if (monthlySends >= defaultMonthlyLimit(subscription.plan.code)) {
          return stopProcessing({ status: FollowUpJobStatus.SKIPPED, reason: "FOLLOW_UP_MONTHLY_LIMIT_REACHED" });
            }
            const nextAllowedAt = await nextFollowUpAllowedAfterCooldown(tx, { ...job, rule: currentJob.rule }, new Date());
            if (nextAllowedAt) {
              const rescheduled = await tx.followUpJob.updateMany({
                where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
                data: { status: FollowUpJobStatus.SCHEDULED, scheduledFor: nextAllowedAt, processingStartedAt: null },
              });
              if (rescheduled.count !== 1) return null;
              return { job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }), sent: false, reason: "FOLLOW_UP_COOLDOWN_ACTIVE", rescheduledFor: nextAllowedAt };
            }
            if (job.rule.type === FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE && job.relatedMessageId) {
              const cancelled = await cancelNoResponseFollowUpIfCustomerReplied(tx, {
                businessId,
                jobId: job.id,
                conversationId,
                relatedMessageId: job.relatedMessageId,
              });
              if (cancelled) return cancelled;
            }
            if (job.rule.type === FollowUpRuleType.BEFORE_APPOINTMENT) {
              const appointment = job.appointmentId
                ? await tx.appointment.findFirst({
                  where: { id: job.appointmentId, businessId },
                  select: { id: true, startTime: true },
                })
                : null;
              if (!appointment || appointment.startTime <= new Date()) {
                const cancelled = await tx.followUpJob.updateMany({
                  where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
                  data: { status: FollowUpJobStatus.CANCELLED, cancelReason: "APPOINTMENT_ALREADY_STARTED", processingStartedAt: null },
                });
                if (cancelled.count !== 1) return null;
                return {
                  job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }),
                  sent: false,
                  reason: "APPOINTMENT_ALREADY_STARTED",
                };
              }
            }
            if (job.rule.type === FollowUpRuleType.CONTACT_EMAIL_REQUEST) {
              const lead = await tx.lead.findFirst({
                where: { id: leadId, businessId, deletedAt: null },
                select: { email: true },
              });
              if (lead?.email) {
                const cancelled = await tx.followUpJob.updateMany({
                  where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
                  data: { status: FollowUpJobStatus.CANCELLED, cancelReason: "CUSTOMER_EMAIL_ALREADY_AVAILABLE", processingStartedAt: null },
                });
                if (cancelled.count !== 1) return null;
                return {
                  job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }),
                  sent: false,
                  reason: "CUSTOMER_EMAIL_ALREADY_AVAILABLE",
                };
              }
            }
            if (job.rule.type === FollowUpRuleType.AFTER_APPOINTMENT) {
              const appointment = job.appointmentId
                ? await tx.appointment.findFirst({
                  where: { id: job.appointmentId, businessId },
                  select: { id: true, status: true },
                })
                : null;
              if (!appointment || appointment.status !== AppointmentStatus.COMPLETED) {
                const cancelled = await tx.followUpJob.updateMany({
                  where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
                  data: { status: FollowUpJobStatus.CANCELLED, cancelReason: "APPOINTMENT_NOT_COMPLETED", processingStartedAt: null },
                });
                if (cancelled.count !== 1) return null;
                return {
                  job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }),
                  sent: false,
                  reason: "APPOINTMENT_NOT_COMPLETED",
                };
              }
              const customerReply = await tx.message.findFirst({
                where: {
                  businessId,
                  conversationId,
                  senderType: MessageSenderType.CUSTOMER,
                  direction: MessageDirection.INBOUND,
                  createdAt: { gt: job.createdAt },
                  deletedAt: null,
                },
                select: { id: true },
              });
              if (customerReply) {
                const cancelled = await tx.followUpJob.updateMany({
                  where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
                  data: { status: FollowUpJobStatus.CANCELLED, cancelReason: "POST_APPOINTMENT_FEEDBACK_RECEIVED", processingStartedAt: null },
                });
                if (cancelled.count !== 1) return null;
                return {
                  job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }),
                  sent: false,
                  reason: "POST_APPOINTMENT_FEEDBACK_RECEIVED",
                  customerReplyId: customerReply.id,
                };
              }
            }
            if (job.rule.type === FollowUpRuleType.STALE_LEAD) {
              const recentMessage = await tx.message.findFirst({
                where: { businessId, leadId, deletedAt: null, createdAt: { gt: job.createdAt } },
                select: { id: true },
              });
              const recentAppointment = await tx.appointment.findFirst({
                where: { businessId, leadId, createdAt: { gt: job.createdAt } },
                select: { id: true },
              });
              if (recentMessage || recentAppointment) {
                const cancelled = await tx.followUpJob.updateMany({
                  where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
                  data: { status: FollowUpJobStatus.CANCELLED, cancelReason: "STALE_LEAD_ACTIVITY_OCCURRED", processingStartedAt: null },
                });
                if (cancelled.count !== 1) return null;
                return {
                  job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }),
                  sent: false,
                  reason: "STALE_LEAD_ACTIVITY_OCCURRED",
                };
              }
            }
            const reservedSendLog = await tx.followUpSendLog.create({
              data: {
                businessId,
                ruleId: job.ruleId,
                jobId: job.id,
                leadId,
                conversationId,
                appointmentId: job.appointmentId,
                quoteId: job.quoteId,
                messageText,
                sentBy: rewrite.usedAiRewrite ? FollowUpSendLogSentBy.AI : FollowUpSendLogSentBy.SYSTEM,
                deliveryStatus: FollowUpSendLogDeliveryStatus.QUEUED,
              },
            });
            const existingMessage = await tx.message.findFirst({
          where: {
            businessId,
            deletedAt: null,
            metadata: { path: ["jobId"], equals: job.id },
          },
          orderBy: { createdAt: "desc" },
        });
        if (existingMessage) {
          if (FOLLOW_UP_DELIVERED_MESSAGE_STATUSES.includes(existingMessage.deliveryStatus)) {
            const updatedJob = await tx.followUpJob.update({
              where: { id: job.id },
              data: { status: FollowUpJobStatus.SENT, sentAt: existingMessage.createdAt, processingStartedAt: null, failureReason: null },
            });
            return { job: updatedJob, message: existingMessage, sent: false, reason: "FOLLOW_UP_ALREADY_DELIVERED" };
          }
          const existingMetadata = jsonObject(existingMessage.metadata);
          if (existingMessage.deliveryStatus === MessageDeliveryStatus.PENDING && typeof existingMetadata.deliveryAttemptStartedAt === "string") {
            const updatedJob = await tx.followUpJob.update({
              where: { id: job.id },
              data: { status: FollowUpJobStatus.FAILED, failureReason: "FOLLOW_UP_DELIVERY_PENDING_RECONCILIATION", processingStartedAt: null },
            });
            return { job: updatedJob, message: existingMessage, sent: false, reason: "FOLLOW_UP_DELIVERY_PENDING_RECONCILIATION" };
          }
          const message = await tx.message.update({
            where: { id: existingMessage.id },
            data: {
              deliveryStatus: MessageDeliveryStatus.PENDING,
              provider: null,
              providerMessageId: null,
              metadata: json({
                ...existingMetadata,
                source: "FOLLOW_UP_AUTOMATION",
                jobId: job.id,
                ruleId: job.ruleId,
                contextType: job.contextType,
                retryingExistingFollowUpMessage: true,
                retryStartedAt: new Date().toISOString(),
              }),
            },
          });
          return { message, sent: true as const, reusedMessage: true as const, sendLogId: reservedSendLog.id };
        }
        const message = await tx.message.create({
          data: {
            businessId,
            leadId,
            conversationId,
            senderType: MessageSenderType.SYSTEM,
            messageType: MessageType.TEXT,
            direction: MessageDirection.OUTBOUND,
            deliveryStatus: MessageDeliveryStatus.PENDING,
            content: messageText,
            metadata: json({ source: "FOLLOW_UP_AUTOMATION", jobId: job.id, ruleId: job.ruleId, contextType: job.contextType }),
          },
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: { lastMessagePreview: messageText.slice(0, 240), lastMessageAt: message.createdAt },
        });
        await tx.leadActivity.create({
          data: {
            businessId,
            leadId,
            action: LeadActivityAction.MESSAGE_CREATED,
            metadata: json({ conversationId, messageId: message.id, senderType: MessageSenderType.SYSTEM, source: "FOLLOW_UP_AUTOMATION", jobId: job.id }),
          },
        });
        return { message, sent: true as const, reusedMessage: false as const, sendLogId: reservedSendLog.id };
      });
          if (!prepared) continue;
          if (!prepared.sent) {
            const action = prepared.job.status === FollowUpJobStatus.CANCELLED
              ? AuditAction.FOLLOW_UP_JOB_CANCELLED
              : prepared.job.status === FollowUpJobStatus.FAILED
                ? AuditAction.FOLLOW_UP_JOB_FAILED
                : prepared.job.status === FollowUpJobStatus.SENT
                  ? AuditAction.FOLLOW_UP_JOB_SENT
                      : "rescheduledFor" in prepared && prepared.rescheduledFor
                        ? AuditAction.FOLLOW_UP_JOB_RESCHEDULED
                        : AuditAction.FOLLOW_UP_JOB_SKIPPED;
            await auditService.log({
              action,
              businessId,
              metadata: json({
                jobId: job.id,
                reason: prepared.reason,
                rescheduledFor: "rescheduledFor" in prepared ? prepared.rescheduledFor : null,
                messageId: "message" in prepared ? prepared.message?.id ?? null : null,
                customerReplyId: "customerReplyId" in prepared ? prepared.customerReplyId : null,
              }),
            });
            results.push(prepared.job);
            continue;
          }
          const followUpMessage = prepared.message;
          if (!followUpMessage) continue;

          if (job.rule.type === FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE && job.relatedMessageId) {
            const relatedMessageId = job.relatedMessageId;
            const cancelledBeforeSend = await prisma.$transaction((tx) => cancelNoResponseFollowUpIfCustomerReplied(tx, {
              businessId,
              jobId: job.id,
              conversationId,
              relatedMessageId,
              messageId: followUpMessage.id,
            }));
            if (cancelledBeforeSend) {
              if ("sendLogId" in prepared && prepared.sendLogId) {
                await prisma.followUpSendLog.update({
                  where: { id: prepared.sendLogId },
                  data: { deliveryStatus: FollowUpSendLogDeliveryStatus.FAILED, failureReason: cancelledBeforeSend.reason },
                });
              }
              await auditService.log({
                action: AuditAction.FOLLOW_UP_JOB_CANCELLED,
                businessId,
                metadata: json({
                  jobId: job.id,
                  reason: cancelledBeforeSend.reason,
                  messageId: followUpMessage.id,
                  customerReplyId: cancelledBeforeSend.customerReplyId,
                }),
              });
              results.push(cancelledBeforeSend.job);
              continue;
            }
          }

          const deliveryGate = await prisma.$transaction(async (tx) => {
            const stopBeforeDelivery = async (input: { status: "CANCELLED" | "SKIPPED"; reason: string }) => {
              const stopped = await tx.followUpJob.updateMany({
                where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
                data: {
                  status: input.status,
                  processingStartedAt: null,
                  ...(input.status === FollowUpJobStatus.CANCELLED ? { cancelReason: input.reason } : { skipReason: input.reason }),
                },
              });
              if (stopped.count !== 1) return null;
              const message = await tx.message.findFirst({
                where: { id: followUpMessage.id, businessId },
                select: { id: true, metadata: true },
              });
              if (message) {
                await tx.message.update({
                  where: { id: message.id },
                  data: {
                    deliveryStatus: MessageDeliveryStatus.FAILED,
                    metadata: json({
                      ...jsonObject(message.metadata),
                      source: "FOLLOW_UP_AUTOMATION",
                      cancelledBeforeSend: true,
                      cancelReason: input.reason,
                    }),
                  },
                });
              }
              if ("sendLogId" in prepared && prepared.sendLogId) {
                await tx.followUpSendLog.update({
                  where: { id: prepared.sendLogId },
                  data: { deliveryStatus: FollowUpSendLogDeliveryStatus.FAILED, failureReason: input.reason },
                });
              }
              return { job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }), reason: input.reason };
            };

            const currentJob = await tx.followUpJob.findFirst({
              where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
              include: { rule: true, business: true },
            });
            if (!currentJob) return null;
            if (!currentJob.business.followUpAutomationEnabled) {
              return stopBeforeDelivery({ status: FollowUpJobStatus.CANCELLED, reason: "FOLLOW_UP_AUTOMATION_DISABLED" });
            }
            if (!currentJob.rule.enabled || currentJob.rule.deletedAt) {
              return stopBeforeDelivery({ status: FollowUpJobStatus.SKIPPED, reason: "FOLLOW_UP_RULE_DISABLED" });
            }
            const subscription = await tx.subscription.findFirst({
              where: { businessAccountId: currentJob.business.businessAccountId, status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] } },
              include: { plan: true },
              orderBy: { createdAt: "desc" },
            });
            if (!subscription) return stopBeforeDelivery({ status: FollowUpJobStatus.SKIPPED, reason: "SUBSCRIPTION_INACTIVE" });
            if (!ruleTypesForPlan(subscription.plan.code).includes(currentJob.rule.type)) {
              return stopBeforeDelivery({ status: FollowUpJobStatus.SKIPPED, reason: "PLAN_UPGRADE_REQUIRED" });
            }
            return { job: currentJob, reason: null };
          });
          if (!deliveryGate) continue;
          if (deliveryGate.reason) {
            await auditService.log({
              action: deliveryGate.job.status === FollowUpJobStatus.CANCELLED ? AuditAction.FOLLOW_UP_JOB_CANCELLED : AuditAction.FOLLOW_UP_JOB_SKIPPED,
              businessId,
              metadata: json({ jobId: job.id, reason: deliveryGate.reason, messageId: followUpMessage.id }),
            });
            results.push(deliveryGate.job);
            continue;
          }

          if (!prepared.reusedMessage) {
            realtimeService.publish({
              type: "message.created",
              businessId,
              conversationId,
              leadId,
              messageId: followUpMessage.id,
              assignedStaffId: job.conversation?.assignedStaffId,
              payload: { message: followUpMessage },
            });
          }

          const deliveryAttemptStartedAt = new Date().toISOString();
          await prisma.message.update({
            where: { id: followUpMessage.id },
            data: {
              metadata: json({
                ...jsonObject(followUpMessage.metadata),
                source: "FOLLOW_UP_AUTOMATION",
                jobId: job.id,
                ruleId: job.ruleId,
                contextType: job.contextType,
                deliveryAttemptStartedAt,
              }),
            },
          });

          const providerResult = await sendWhatsAppText(integration, {
            phoneNumberId: integration.phoneNumberId,
            to: destinationPhone,
            message: messageText,
            businessId,
            conversationId,
            messageId: followUpMessage.id,
          });
      const deliveryStatus = providerResult.success ? MessageDeliveryStatus.SENT : MessageDeliveryStatus.FAILED;
      const followUpDeliveryStatus = providerResult.success ? FollowUpSendLogDeliveryStatus.SENT : FollowUpSendLogDeliveryStatus.FAILED;
      const completed = await prisma.$transaction(async (tx) => {
        const updatedMessage = await tx.message.update({
              where: { id: followUpMessage.id },
          data: {
            deliveryStatus,
            provider: providerResult.provider,
            providerMessageId: providerResult.providerMessageId,
            metadata: json({
              source: "FOLLOW_UP_AUTOMATION",
              jobId: job.id,
              ruleId: job.ruleId,
                  contextType: job.contextType,
                  deliveryAttemptStartedAt,
                  provider: providerResult.provider,
              providerMessageId: providerResult.providerMessageId ?? null,
              deliveryStatus,
              ...(providerResult.success ? {} : { error: providerResult.error ?? "WhatsApp follow-up send failed" }),
            }),
          },
        });
        const updatedJob = await tx.followUpJob.update({
          where: { id: job.id },
          data: {
            status: providerResult.success ? FollowUpJobStatus.SENT : FollowUpJobStatus.FAILED,
            sentAt: providerResult.success ? new Date() : null,
            failureReason: providerResult.success ? null : providerResult.error ?? "WHATSAPP_SEND_FAILED",
            processingStartedAt: null,
          },
        });
        if ("sendLogId" in prepared && prepared.sendLogId) {
          await tx.followUpSendLog.update({
            where: { id: prepared.sendLogId },
            data: {
              deliveryStatus: followUpDeliveryStatus,
              whatsappMessageId: providerResult.providerMessageId,
              failureReason: providerResult.success ? null : providerResult.error ?? "WHATSAPP_SEND_FAILED",
            },
          });
        } else {
          await tx.followUpSendLog.create({
            data: {
              businessId,
              ruleId: job.ruleId,
              jobId: job.id,
              leadId,
              conversationId,
              appointmentId: job.appointmentId,
              quoteId: job.quoteId,
              messageText,
              sentBy: rewrite.usedAiRewrite ? FollowUpSendLogSentBy.AI : FollowUpSendLogSentBy.SYSTEM,
              deliveryStatus: followUpDeliveryStatus,
              whatsappMessageId: providerResult.providerMessageId,
              failureReason: providerResult.success ? null : providerResult.error ?? "WHATSAPP_SEND_FAILED",
            },
          });
        }
        await tx.leadActivity.create({
              data: {
                businessId,
                leadId,
                action: providerResult.success ? LeadActivityAction.MESSAGE_SENT : LeadActivityAction.MESSAGE_SEND_FAILED,
                metadata: json({ conversationId, messageId: followUpMessage.id, jobId: job.id, provider: providerResult.provider, providerMessageId: providerResult.providerMessageId ?? null }),
          },
        });
        return { job: updatedJob, message: updatedMessage };
      });
      realtimeService.publish({
            type: "message.status.updated",
            businessId,
            conversationId,
            leadId,
            messageId: followUpMessage.id,
            assignedStaffId: job.conversation?.assignedStaffId,
            payload: { messageId: followUpMessage.id, conversationId, previousStatus: MessageDeliveryStatus.PENDING, newStatus: deliveryStatus, updatedAt: completed.message.updatedAt },
      });
      if (!providerResult.success) {
        await auditService.log({ action: AuditAction.FOLLOW_UP_JOB_FAILED, businessId, metadata: json({ jobId: job.id, ruleId: job.ruleId, reason: providerResult.error ?? "WHATSAPP_SEND_FAILED" }) });
            realtimeService.publish({ type: "business.follow_up.job.failed", businessId, conversationId, leadId, payload: { job: completed.job, reason: providerResult.error ?? "WHATSAPP_SEND_FAILED" }, broadcastToStaff: true });
        results.push(completed.job);
        continue;
      }
          await auditService.log({ action: AuditAction.FOLLOW_UP_JOB_SENT, businessId, metadata: json({ jobId: job.id, ruleId: job.ruleId, messageId: followUpMessage.id, usageEvent: sentUsageEvent(job.rule.type), aiRewriteUsed: rewrite.usedAiRewrite, aiRewrite: "providerMetadata" in rewrite ? rewrite.providerMetadata : null }) });
          await auditService.log({ action: basicSentAuditAction(job.rule.type), businessId, metadata: json({ jobId: job.id, ruleId: job.ruleId, messageId: followUpMessage.id, conversationId, leadId, appointmentId: job.appointmentId, usageEvent: sentUsageEvent(job.rule.type) }) });
          realtimeService.publish({ type: "business.follow_up.job.sent", businessId, conversationId, leadId, payload: { job: completed.job }, broadcastToStaff: true });
          realtimeService.publish({ type: basicSentEventType(job.rule.type), businessId, conversationId, leadId, payload: { job: completed.job, message: completed.message }, broadcastToStaff: true });
          if (job.rule.type === FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE) {
            await followUpBasicService.scheduleNoResponseAfterOutboundMessage({
              businessId,
              leadId,
              conversationId,
              messageId: followUpMessage.id,
              messageCreatedAt: completed.message.createdAt,
              deliveryStatus,
            });
          }
      results.push(completed.job);
    }
    return results;
  },
};
