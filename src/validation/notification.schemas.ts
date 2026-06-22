import { BusinessNotificationPriority, BusinessNotificationStatus, BusinessNotificationType } from "@prisma/client";
import { z } from "zod";

export const notificationListQuerySchema = z.object({
  status: z.nativeEnum(BusinessNotificationStatus).optional(),
  priority: z.nativeEnum(BusinessNotificationPriority).optional(),
  type: z.nativeEnum(BusinessNotificationType).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().cuid().optional(),
});

export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
