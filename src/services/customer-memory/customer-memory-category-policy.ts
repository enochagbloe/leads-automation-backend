import {
  CustomerMemoryCategory,
  CustomerMemorySourceType,
  CustomerMemoryTruthType,
  MessageSenderType,
} from "@prisma/client";

export type CustomerMemoryWriteAuthority = "EXTRACTION" | "BACKEND" | "MANUAL";

export const CUSTOMER_MESSAGE_MEMORY_CATEGORIES = new Set<CustomerMemoryCategory>([
  CustomerMemoryCategory.GOAL,
  CustomerMemoryCategory.INTERESTED_SERVICE,
  CustomerMemoryCategory.PREFERENCE,
  CustomerMemoryCategory.OBJECTION,
  CustomerMemoryCategory.TIMING_STATEMENT,
  CustomerMemoryCategory.MISSING_DETAIL,
  CustomerMemoryCategory.UNRESOLVED_REQUEST,
  CustomerMemoryCategory.LAST_CUSTOMER_ACTION,
]);

export const AI_MESSAGE_MEMORY_CATEGORIES = new Set<CustomerMemoryCategory>([
  CustomerMemoryCategory.MISSING_DETAIL,
  CustomerMemoryCategory.UNRESOLVED_REQUEST,
]);

// Additional staff-confirmed categories must be approved here explicitly.
export const STAFF_MESSAGE_MEMORY_CATEGORIES = new Set<CustomerMemoryCategory>([
  CustomerMemoryCategory.LAST_STAFF_ACTION,
]);

const BACKEND_CATEGORY_BY_SOURCE: Partial<Record<CustomerMemorySourceType, ReadonlySet<CustomerMemoryCategory>>> = {
  [CustomerMemorySourceType.LEAD]: new Set([CustomerMemoryCategory.LEAD_CONTEXT]),
  [CustomerMemorySourceType.APPOINTMENT]: new Set([CustomerMemoryCategory.APPOINTMENT_CONTEXT]),
  [CustomerMemorySourceType.SYSTEM_EVENT]: new Set([CustomerMemoryCategory.HUMAN_TAKEOVER]),
};

const MANUALLY_CORRECTABLE_CATEGORIES = new Set<CustomerMemoryCategory>([
  ...CUSTOMER_MESSAGE_MEMORY_CATEGORIES,
  ...STAFF_MESSAGE_MEMORY_CATEGORIES,
]);

const BACKEND_OWNED_CATEGORIES = new Set<CustomerMemoryCategory>([
  CustomerMemoryCategory.LEAD_CONTEXT,
  CustomerMemoryCategory.APPOINTMENT_CONTEXT,
  CustomerMemoryCategory.HUMAN_TAKEOVER,
]);

const BACKEND_OWNED_SOURCE_TYPES = new Set<CustomerMemorySourceType>([
  CustomerMemorySourceType.LEAD,
  CustomerMemorySourceType.APPOINTMENT,
  CustomerMemorySourceType.SYSTEM_EVENT,
]);

export function isBackendOwnedCustomerMemory(input: {
  truthType: CustomerMemoryTruthType;
  sourceType: CustomerMemorySourceType;
  category: CustomerMemoryCategory;
}) {
  return input.truthType === CustomerMemoryTruthType.BACKEND_CONFIRMED
    || BACKEND_OWNED_SOURCE_TYPES.has(input.sourceType)
    || BACKEND_OWNED_CATEGORIES.has(input.category);
}

export function sourceTypeForMessageSender(senderType: MessageSenderType) {
  if (senderType === MessageSenderType.CUSTOMER) return CustomerMemorySourceType.CUSTOMER_MESSAGE;
  if (senderType === MessageSenderType.STAFF) return CustomerMemorySourceType.STAFF_MESSAGE;
  if (senderType === MessageSenderType.AI) return CustomerMemorySourceType.AI_MESSAGE;
  return null;
}

export function isMemoryCategoryAllowed(input: {
  authority: CustomerMemoryWriteAuthority;
  sourceType: CustomerMemorySourceType;
  category: CustomerMemoryCategory;
}) {
  if (input.authority === "BACKEND") {
    return BACKEND_CATEGORY_BY_SOURCE[input.sourceType]?.has(input.category) === true;
  }
  if (input.authority === "MANUAL") {
    return input.sourceType === CustomerMemorySourceType.MANUAL_CORRECTION
      && MANUALLY_CORRECTABLE_CATEGORIES.has(input.category);
  }
  if (input.sourceType === CustomerMemorySourceType.CUSTOMER_MESSAGE) {
    return CUSTOMER_MESSAGE_MEMORY_CATEGORIES.has(input.category);
  }
  if (input.sourceType === CustomerMemorySourceType.AI_MESSAGE) {
    return AI_MESSAGE_MEMORY_CATEGORIES.has(input.category);
  }
  if (input.sourceType === CustomerMemorySourceType.STAFF_MESSAGE) {
    return STAFF_MESSAGE_MEMORY_CATEGORIES.has(input.category);
  }
  return false;
}

export function isMemoryTruthTypeAllowed(input: {
  authority: CustomerMemoryWriteAuthority;
  sourceType: CustomerMemorySourceType;
  truthType: CustomerMemoryTruthType;
}) {
  if (input.authority === "BACKEND") return input.truthType === CustomerMemoryTruthType.BACKEND_CONFIRMED;
  if (input.authority === "MANUAL") return input.truthType === CustomerMemoryTruthType.STAFF_CONFIRMED;
  if (input.sourceType === CustomerMemorySourceType.CUSTOMER_MESSAGE) {
    return input.truthType === CustomerMemoryTruthType.CUSTOMER_STATED
      || input.truthType === CustomerMemoryTruthType.AI_INFERRED;
  }
  if (input.sourceType === CustomerMemorySourceType.STAFF_MESSAGE) {
    return input.truthType === CustomerMemoryTruthType.STAFF_CONFIRMED;
  }
  if (input.sourceType === CustomerMemorySourceType.AI_MESSAGE) {
    return input.truthType === CustomerMemoryTruthType.AI_INFERRED;
  }
  return false;
}
