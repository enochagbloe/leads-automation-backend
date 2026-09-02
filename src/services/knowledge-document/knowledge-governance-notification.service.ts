import {
  BusinessNotificationEntityType,
  BusinessNotificationPriority,
  BusinessNotificationType,
  BusinessRole,
  KnowledgeGovernanceNotificationStatus,
  KnowledgeGovernanceReviewStatus,
  MembershipStatus,
} from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { emailService } from "../email.service";
import { notificationService } from "../notification.service";
import { realtimeService } from "../realtime.service";

const MAX_ATTEMPTS = 5;

function nextAttempt(attempt: number) {
  return new Date(Date.now() + Math.min(60, 2 ** attempt) * 60_000);
}

async function claim(limit: number) {
  const candidates = await prisma.knowledgeGovernanceReview.findMany({
    where: {
      criticalNotificationStatus: { in: [KnowledgeGovernanceNotificationStatus.PENDING, KnowledgeGovernanceNotificationStatus.FAILED] },
      criticalNotificationAttempts: { lt: MAX_ATTEMPTS },
      OR: [{ criticalNotificationNextAttemptAt: null }, { criticalNotificationNextAttemptAt: { lte: new Date() } }],
    },
    orderBy: [{ criticalNotificationNextAttemptAt: "asc" }, { detectedAt: "asc" }],
    take: limit,
    select: { id: true, criticalNotificationStatus: true, criticalNotificationAttempts: true, updatedAt: true },
  });
  const ids: string[] = [];
  for (const candidate of candidates) {
    const changed = await prisma.knowledgeGovernanceReview.updateMany({
      where: {
        id: candidate.id,
        criticalNotificationStatus: candidate.criticalNotificationStatus,
        criticalNotificationAttempts: candidate.criticalNotificationAttempts,
        updatedAt: candidate.updatedAt,
      },
      data: {
        criticalNotificationStatus: KnowledgeGovernanceNotificationStatus.PROCESSING,
        criticalNotificationAttempts: { increment: 1 },
        criticalNotificationStartedAt: new Date(),
        criticalNotificationErrorCode: null,
      },
    });
    if (changed.count === 1) ids.push(candidate.id);
  }
  return ids;
}

async function deliver(reviewId: string) {
  const review = await prisma.knowledgeGovernanceReview.findUnique({
    where: { id: reviewId },
    select: {
      id: true,
      businessId: true,
      documentId: true,
      priority: true,
      reviewStatus: true,
      canonicalField: true,
      criticalNotificationAttempts: true,
      business: {
        select: {
          name: true,
          businessAccountId: true,
          members: {
            where: { status: MembershipStatus.ACTIVE, role: { in: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER] } },
            select: { id: true, role: true, user: { select: { email: true } } },
          },
        },
      },
      document: { select: { title: true } },
      fact: { select: { factType: true, label: true } },
    },
  });
  if (!review || review.reviewStatus === KnowledgeGovernanceReviewStatus.RESOLVED) {
    await prisma.knowledgeGovernanceReview.updateMany({
      where: { id: reviewId, criticalNotificationStatus: KnowledgeGovernanceNotificationStatus.PROCESSING },
      data: { criticalNotificationStatus: KnowledgeGovernanceNotificationStatus.SENT, criticalNotificationSentAt: new Date() },
    });
    return;
  }
  const members = review.business.members;
  const owner = members.find((member) => member.role === BusinessRole.BUSINESS_OWNER);
  if (!owner?.user.email) throw new Error("KNOWLEDGE_CONFLICT_OWNER_EMAIL_UNAVAILABLE");
  const existingRecipients = await prisma.businessNotification.findMany({
    where: {
      businessId: review.businessId,
      type: BusinessNotificationType.KNOWLEDGE_CONFLICT_REQUIRES_REVIEW,
      entityType: BusinessNotificationEntityType.KNOWLEDGE_DOCUMENT,
      entityId: review.id,
    },
    select: { recipientMembershipId: true },
  });
  const notified = new Set(existingRecipients.map((entry) => entry.recipientMembershipId));
  const missingRecipients = members.map((member) => member.id).filter((membershipId) => !notified.has(membershipId));
  if (missingRecipients.length > 0) {
    await notificationService.createNotificationsForRecipients({
      businessId: review.businessId,
      businessAccountId: review.business.businessAccountId,
      recipientMembershipIds: missingRecipients,
      type: BusinessNotificationType.KNOWLEDGE_CONFLICT_REQUIRES_REVIEW,
      priority: BusinessNotificationPriority.URGENT,
      title: "Knowledge needs attention",
      message: `${review.fact?.label ?? review.canonicalField ?? "Business information"} has a critical conflict that may affect customer replies.`,
      entityType: BusinessNotificationEntityType.KNOWLEDGE_DOCUMENT,
      entityId: review.id,
      actions: [{ label: "Review conflict", action: "VIEW_KNOWLEDGE_REVIEW", variant: "default" }],
      metadata: { reviewItemId: review.id, documentId: review.documentId, priority: review.priority },
    });
  }
  const sent = await emailService.sendKnowledgeConflictReviewEmail(owner.user.email, {
    reviewItemId: review.id,
    businessName: review.business.name,
    affectedCategory: review.fact?.label ?? review.fact?.factType ?? review.canonicalField ?? "Business information",
    documentTitle: review.document.title,
    reviewUrl: `${env.FRONTEND_URL}/dashboard?settings=knowledge&review=${encodeURIComponent(review.id)}`,
  });
  if (!sent) throw new Error("KNOWLEDGE_CONFLICT_EMAIL_FAILED");
  const changed = await prisma.knowledgeGovernanceReview.updateMany({
    where: { id: review.id, criticalNotificationStatus: KnowledgeGovernanceNotificationStatus.PROCESSING },
    data: {
      criticalNotificationStatus: KnowledgeGovernanceNotificationStatus.SENT,
      criticalNotificationSentAt: new Date(),
      criticalNotificationNextAttemptAt: null,
      criticalNotificationErrorCode: null,
    },
  });
  if (changed.count === 1) {
    realtimeService.publish({
      type: "business.knowledge.conflict.detected",
      businessId: review.businessId,
      roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
      payload: { reviewItemId: review.id, documentId: review.documentId, priority: review.priority },
    });
  }
}

export const knowledgeGovernanceNotificationService = {
  async processDue(limit = 20) {
    await prisma.knowledgeGovernanceReview.updateMany({
      where: {
        criticalNotificationStatus: KnowledgeGovernanceNotificationStatus.PROCESSING,
        criticalNotificationStartedAt: { lt: new Date(Date.now() - 10 * 60_000) },
        criticalNotificationSentAt: null,
      },
      data: {
        criticalNotificationStatus: KnowledgeGovernanceNotificationStatus.FAILED,
        criticalNotificationNextAttemptAt: new Date(),
        criticalNotificationErrorCode: "KNOWLEDGE_CONFLICT_NOTIFICATION_STALE",
      },
    });
    const ids = await claim(limit);
    for (const id of ids) {
      try {
        await deliver(id);
      } catch (error) {
        const review = await prisma.knowledgeGovernanceReview.findUnique({
          where: { id },
          select: { criticalNotificationAttempts: true },
        });
        const exhausted = (review?.criticalNotificationAttempts ?? MAX_ATTEMPTS) >= MAX_ATTEMPTS;
        await prisma.knowledgeGovernanceReview.updateMany({
          where: { id, criticalNotificationStatus: KnowledgeGovernanceNotificationStatus.PROCESSING },
          data: {
            criticalNotificationStatus: exhausted
              ? KnowledgeGovernanceNotificationStatus.EXHAUSTED
              : KnowledgeGovernanceNotificationStatus.FAILED,
            criticalNotificationNextAttemptAt: exhausted ? null : nextAttempt(review?.criticalNotificationAttempts ?? 1),
            criticalNotificationErrorCode: error instanceof Error ? error.message.slice(0, 191) : "KNOWLEDGE_CONFLICT_NOTIFICATION_FAILED",
          },
        });
      }
    }
    return ids.length;
  },
};
