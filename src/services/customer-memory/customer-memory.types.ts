import {
  CustomerMemoryCategory,
  CustomerMemoryMissingDetailState,
  CustomerMemorySourceType,
  CustomerMemoryTruthType,
  Prisma,
} from "@prisma/client";

export type CustomerMemoryActor = {
  userId: string;
  businessId: string;
  membershipId: string;
};

export type ExtractedMemory = {
  operation?: "UPSERT" | "RESOLVE";
  sourceMessageId?: string;
  category: CustomerMemoryCategory;
  memoryKey: string;
  valueText: string;
  structuredValue?: Prisma.InputJsonValue;
  truthType: CustomerMemoryTruthType;
  sourceType: CustomerMemorySourceType;
  confidence?: number;
  missingDetailState?: CustomerMemoryMissingDetailState;
  sourceStatement?: string;
};

export type CustomerMemoryRuntimeContext = {
  leadId: string;
  conversationId?: string;
  summary: string | null;
  activeGoal: string | null;
  serviceInterests: Array<{ value: string; serviceId?: string }>;
  preferences: Array<{ key: string; value: string }>;
  objections: Array<{ key: string; value: string }>;
  timingStatements: Array<{ value: string; interpretedAt?: string; timezone?: string; inferred: boolean }>;
  missingDetails: Array<{ key: string; value: string; state: CustomerMemoryMissingDetailState }>;
  unresolvedRequests: Array<{ key: string; value: string }>;
  appointmentContext: Record<string, unknown> | null;
  leadContext: Record<string, unknown>;
  lastImportantCustomerAction: string | null;
  lastStaffAction: string | null;
  humanTakeover: {
    active: boolean;
    aiEnabled: boolean;
    needsHumanReview: boolean;
    conversationStatus?: string;
  };
  memoryRevision: number;
  memoryEnabled: boolean;
  memoryVersion: string | null;
  degraded?: boolean;
  degradationReason?: string;
};

export type CustomerMemoryRuntimeFallback = {
  leadStatus: string;
  assignedStaffId?: string | null;
  lastMeaningfulActivityAt?: string | null;
  conversation: {
    id: string;
    status: string;
    aiEnabled: boolean;
    humanTakeover: boolean;
    needsHumanReview: boolean;
  };
};
