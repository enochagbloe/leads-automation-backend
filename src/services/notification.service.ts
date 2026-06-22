import {
  AuditAction,
  BusinessNotificationEntityType,
  BusinessNotificationPriority,
  BusinessNotificationStatus,
  BusinessNotificationType,
  BusinessRole,
  MembershipStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { NotificationListQuery } from "../validation/notification.schemas";
import { AuditInput, auditService } from "./audit.service";
import { cacheService } from "./cache.service";
import { realtimeService } from "./realtime.service";

export type NotificationActor = {
  userId: string;
  businessAccountId: string;
  businessId: string;
  membershipId: string;
  role: BusinessRole;
};

type NotificationAction = {
  label: string;
  action: string;
  variant: "default" | "secondary" | "destructive";
};

type NotificationInput = {
  businessId: string;
  businessAccountId?: string | null;
  recipientMembershipId: string;
  type: BusinessNotificationType;
  priority: BusinessNotificationPriority;
  title: string;
  message: string;
  entityType?: BusinessNotificationEntityType | null;
  entityId?: string | null;
  actions?: NotificationAction[];
  metadata?: Record<string, unknown>;
  createdById?: string | null;
  expiresAt?: Date | null;
  deferSideEffects?: boolean;
};

type NotificationTx = Prisma.TransactionClient | typeof prisma;

const unresolvedStatuses = [BusinessNotificationStatus.UNREAD, BusinessNotificationStatus.READ];

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function listKey(actor: NotificationActor, query: NotificationListQuery) {
  return `business:${actor.businessId}:notifications:list:${actor.membershipId}:${JSON.stringify(query)}`;
}

async function invalidateNotificationCaches(businessId: string, membershipId?: string) {
  await Promise.all([
    cacheService.delByPattern(`business:${businessId}:notifications:list:*`),
    cacheService.delByPattern(`business:${businessId}:notifications:counts:*`),
    ...(membershipId ? [
      cacheService.delByPattern(`business:${businessId}:notifications:list:${membershipId}:*`),
      cacheService.delByPattern(`business:${businessId}:notifications:counts:${membershipId}`),
    ] : []),
  ]);
}

async function audit(actor: NotificationActor, action: AuditAction, notification: {
  id: string;
  recipientMembershipId: string;
  type: BusinessNotificationType;
  entityType: BusinessNotificationEntityType | null;
  entityId: string | null;
}, context?: Omit<AuditInput, "action">) {
  await auditService.log({
    ...(context ?? {}),
    action,
    businessId: actor.businessId,
    userId: actor.userId,
    metadata: json({
      notificationId: notification.id,
      businessId: actor.businessId,
      recipientMembershipId: notification.recipientMembershipId,
      type: notification.type,
      entityType: notification.entityType,
      entityId: notification.entityId,
    }),
  });
}

async function validateRecipient(tx: NotificationTx, businessId: string, recipientMembershipId: string) {
  const recipient = await tx.businessMember.findFirst({
    where: { id: recipientMembershipId, businessId, status: MembershipStatus.ACTIVE },
    select: { id: true, userId: true },
  });
  if (!recipient) throw new AppError(422, "Notification recipient is not an active member of this business.", "VALIDATION_ERROR");
  return recipient;
}

async function loadForActor(actor: NotificationActor, notificationId: string) {
  const notification = await prisma.businessNotification.findFirst({
    where: {
      id: notificationId,
      businessId: actor.businessId,
      ...(actor.role === BusinessRole.STAFF ? { recipientMembershipId: actor.membershipId } : { recipientMembershipId: actor.membershipId }),
    },
  });
  if (!notification) throw new AppError(404, "Notification not found.", "NOTIFICATION_NOT_FOUND");
  return notification;
}

export const notificationService = {
  async createNotification(input: NotificationInput, tx: NotificationTx = prisma) {
    const recipient = await validateRecipient(tx, input.businessId, input.recipientMembershipId);
    const existing = input.entityType && input.entityId
      ? await tx.businessNotification.findFirst({
        where: {
          businessId: input.businessId,
          recipientMembershipId: input.recipientMembershipId,
          type: input.type,
          entityType: input.entityType,
          entityId: input.entityId,
          status: { in: unresolvedStatuses },
        },
      })
      : null;
    if (existing) return existing;
    const notification = await tx.businessNotification.create({
      data: {
        businessId: input.businessId,
        businessAccountId: input.businessAccountId ?? null,
        recipientMembershipId: input.recipientMembershipId,
        recipientUserId: recipient.userId,
        createdById: input.createdById ?? null,
        type: input.type,
        priority: input.priority,
        title: input.title,
        message: input.message,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        actions: input.actions ? json(input.actions) : undefined,
        metadata: input.metadata ? json(input.metadata) : undefined,
        expiresAt: input.expiresAt ?? null,
      },
    });
    if (!input.deferSideEffects) {
      realtimeService.publish({
        type: "business.notification.created",
        businessId: input.businessId,
        staffMembershipIds: [input.recipientMembershipId],
        payload: {
          notificationId: notification.id,
          businessId: input.businessId,
          recipientMembershipId: input.recipientMembershipId,
          type: notification.type,
          priority: notification.priority,
          title: notification.title,
          message: notification.message,
          entityType: notification.entityType,
          entityId: notification.entityId,
          actions: notification.actions ?? [],
        },
      });
      await invalidateNotificationCaches(input.businessId, input.recipientMembershipId);
      await auditService.log({
        action: AuditAction.NOTIFICATION_CREATED,
        businessId: input.businessId,
        userId: input.createdById ?? null,
        metadata: json({
          notificationId: notification.id,
          businessId: input.businessId,
          recipientMembershipId: input.recipientMembershipId,
          type: notification.type,
          entityType: notification.entityType,
          entityId: notification.entityId,
        }),
      });
    }
    return notification;
  },

  async createNotificationsForRecipients(input: Omit<NotificationInput, "recipientMembershipId"> & { recipientMembershipIds: string[] }, tx: NotificationTx = prisma) {
    const uniqueRecipients = Array.from(new Set(input.recipientMembershipIds));
    const notifications = [];
    for (const recipientMembershipId of uniqueRecipients) {
      notifications.push(await this.createNotification({ ...input, recipientMembershipId }, tx));
    }
    return notifications;
  },

  async list(actor: NotificationActor, query: NotificationListQuery) {
    const key = listKey(actor, query);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const where: Prisma.BusinessNotificationWhereInput = {
      businessId: actor.businessId,
      recipientMembershipId: actor.membershipId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.type ? { type: query.type } : {}),
    };
    const data = await prisma.businessNotification.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        type: true,
        priority: true,
        title: true,
        message: true,
        entityType: true,
        entityId: true,
        actions: true,
        status: true,
        createdAt: true,
        readAt: true,
        actionedAt: true,
        dismissedAt: true,
        expiresAt: true,
      },
    });
    const hasMore = data.length > query.limit;
    const items = hasMore ? data.slice(0, query.limit) : data;
    const result = { data: items, pagination: { limit: query.limit, nextCursor: hasMore ? items.at(-1)?.id ?? null : null } };
    await cacheService.set(key, result, 30);
    return result;
  },

  async counts(actor: NotificationActor) {
    const key = `business:${actor.businessId}:notifications:counts:${actor.membershipId}`;
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const [unread, highPriority, urgent] = await Promise.all([
      prisma.businessNotification.count({ where: { businessId: actor.businessId, recipientMembershipId: actor.membershipId, status: BusinessNotificationStatus.UNREAD } }),
      prisma.businessNotification.count({ where: { businessId: actor.businessId, recipientMembershipId: actor.membershipId, status: { in: unresolvedStatuses }, priority: BusinessNotificationPriority.HIGH } }),
      prisma.businessNotification.count({ where: { businessId: actor.businessId, recipientMembershipId: actor.membershipId, status: { in: unresolvedStatuses }, priority: BusinessNotificationPriority.URGENT } }),
    ]);
    const result = { unread, highPriority, urgent };
    await cacheService.set(key, result, 30);
    return result;
  },

  async markRead(actor: NotificationActor, notificationId: string, context: Omit<AuditInput, "action">) {
    const existing = await loadForActor(actor, notificationId);
    const updated = await prisma.businessNotification.update({
      where: { id: existing.id },
      data: existing.status === BusinessNotificationStatus.UNREAD
        ? { status: BusinessNotificationStatus.READ, readAt: new Date() }
        : { readAt: existing.readAt ?? new Date() },
    });
    await invalidateNotificationCaches(actor.businessId, updated.recipientMembershipId);
    await audit(actor, AuditAction.NOTIFICATION_READ, updated, context);
    return { notification: updated };
  },

  async dismiss(actor: NotificationActor, notificationId: string, context: Omit<AuditInput, "action">) {
    const existing = await loadForActor(actor, notificationId);
    if (existing.status === BusinessNotificationStatus.DISMISSED) throw new AppError(422, "Notification is already dismissed.", "NOTIFICATION_ALREADY_DISMISSED");
    const updated = await prisma.businessNotification.update({
      where: { id: existing.id },
      data: { status: BusinessNotificationStatus.DISMISSED, dismissedAt: new Date() },
    });
    await invalidateNotificationCaches(actor.businessId, updated.recipientMembershipId);
    await audit(actor, AuditAction.NOTIFICATION_DISMISSED, updated, context);
    return { notification: updated };
  },

  async markActioned(actor: NotificationActor, notificationId: string, context: Omit<AuditInput, "action">) {
    const existing = await loadForActor(actor, notificationId);
    if (existing.status === BusinessNotificationStatus.ACTIONED) throw new AppError(422, "Notification is already actioned.", "NOTIFICATION_ALREADY_ACTIONED");
    const updated = await prisma.businessNotification.update({
      where: { id: existing.id },
      data: { status: BusinessNotificationStatus.ACTIONED, actionedAt: new Date() },
    });
    await invalidateNotificationCaches(actor.businessId, updated.recipientMembershipId);
    await audit(actor, AuditAction.NOTIFICATION_ACTIONED, updated, context);
    return { notification: updated };
  },
};
