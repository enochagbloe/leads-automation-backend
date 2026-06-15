import { cacheService } from "./cache.service";
import { realtimeService } from "./realtime.service";

export type KnowledgePreviewSection = "PROFILE" | "SERVICES" | "AVAILABILITY" | "POLICIES" | "WHATSAPP";

export async function invalidateBusinessKnowledgePreview(businessId: string, changedSection?: KnowledgePreviewSection) {
  await cacheService.del(`business:${businessId}:knowledge-preview`);
  if (changedSection) {
    realtimeService.publish({
      type: "business.knowledge_preview.updated",
      businessId,
      payload: { businessId, changedSection, updatedAt: new Date().toISOString() },
    });
  }
}
