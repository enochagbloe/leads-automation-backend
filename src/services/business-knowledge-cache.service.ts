import { cacheService } from "./cache.service";
import { realtimeService } from "./realtime.service";
import { invalidateAiBusinessContext } from "./ai-context-builder.service";

export type KnowledgePreviewSection = "PROFILE" | "SERVICES" | "AVAILABILITY" | "POLICIES" | "WHATSAPP" | "APPOINTMENTS";

export async function invalidateBusinessKnowledgePreview(businessId: string, changedSection?: KnowledgePreviewSection) {
  await Promise.all([
    cacheService.del(`business:${businessId}:knowledge-preview`),
    invalidateAiBusinessContext(businessId),
  ]);
  if (changedSection) {
    realtimeService.publish({
      type: "business.knowledge_preview.updated",
      businessId,
      payload: { businessId, changedSection, updatedAt: new Date().toISOString() },
    });
  }
}
