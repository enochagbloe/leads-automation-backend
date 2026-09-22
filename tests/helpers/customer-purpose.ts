import type { CustomerPurpose } from "../../src/services/conversation-purpose.schema";

/** Controlled interpretation output: semantic matching is supplied by the provider fixture. */
export function servicePurpose(message: { id: string; content: string }, service: { id: string; name: string; description?: string | null }, overrides: Partial<CustomerPurpose> = {}): CustomerPurpose {
  return { goal: "ARRANGE_SERVICE", need: message.content.slice(0, 500), resolution: "INFERRED", serviceId: service.id, candidateServiceIds: [], confidence: .98,
    evidence: [{ messageId: message.id, quote: message.content.slice(0, 300) }], catalogEvidence: [{ serviceId: service.id, quote: (service.description ?? service.name).slice(0, 300) }], ...overrides };
}
