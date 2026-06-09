import { ConversationChannel, ConversationPriority, ConversationStatus, MessageSenderType, MessageType } from "@prisma/client";
import { z } from "zod";

export const createConversationSchema = z.object({
  leadId: z.string().cuid(),
  subject: z.string().trim().min(1).max(240).nullable().optional(),
  assignedStaffId: z.string().cuid().nullable().optional(),
  channel: z.nativeEnum(ConversationChannel).default(ConversationChannel.MANUAL),
  priority: z.nativeEnum(ConversationPriority).default(ConversationPriority.NORMAL),
});

export const conversationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(160).optional(),
  status: z.nativeEnum(ConversationStatus).optional(),
  channel: z.nativeEnum(ConversationChannel).optional(),
  priority: z.nativeEnum(ConversationPriority).optional(),
  pinned: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  assignedStaffId: z.string().cuid().optional(),
  leadId: z.string().cuid().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  sortBy: z.enum(["lastMessageAt", "createdAt", "updatedAt", "status"]).default("lastMessageAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const conversationDetailQuerySchema = z.object({
  messageLimit: z.coerce.number().int().min(1).max(100).default(50),
  beforeMessageId: z.string().cuid().optional(),
});

export const createMessageSchema = z.object({
  content: z.string().trim().min(1, "Message content is required").max(10_000),
  messageType: z.literal(MessageType.TEXT).default(MessageType.TEXT),
  senderType: z.literal(MessageSenderType.STAFF).default(MessageSenderType.STAFF),
});

export const assignConversationSchema = z.object({ assignedStaffId: z.string().cuid().nullable() });
export const updateConversationStatusSchema = z.object({ status: z.nativeEnum(ConversationStatus) });
export const updateConversationWorkspaceSchema = z.object({
  subject: z.string().trim().min(1).max(240).nullable().optional(),
  priority: z.nativeEnum(ConversationPriority).optional(),
  pinned: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "At least one field is required" });

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;
export type ConversationDetailQuery = z.infer<typeof conversationDetailQuerySchema>;
export type CreateMessageInput = z.infer<typeof createMessageSchema>;
