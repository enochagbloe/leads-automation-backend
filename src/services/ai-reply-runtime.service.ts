import { conversationContextService } from "./conversation-context.service";
import { AiBusinessContext, aiPromptContextFormatter } from "./ai-context-builder.service";
import { aiProvider, AiGenerateReplyInput } from "./ai-provider.service";

/** Shared prompt/provider execution; callers own policy and side effects. */
export async function generateContextReply(context: AiBusinessContext, options: Omit<AiGenerateReplyInput, "systemPrompt" | "userPrompt">) {
  const snapshot = await conversationContextService.getSnapshot({ businessId: context.business.id, conversationId: context.conversation.id, demoSessionId: context.demoSessionId, messageId: context.triggerMessage.id, customerMemorySummary: context.customerMemory.summary ?? undefined });
  context = { ...context, conversationSnapshot: snapshot, recentMessages: snapshot.recentMessages };
  const result = await aiProvider.generateReply({ ...options, systemPrompt: aiPromptContextFormatter.buildSystemPrompt(context), userPrompt: aiPromptContextFormatter.buildUserPrompt(context) });
  return { ...result, conversationStateRevision: snapshot.state.revision, conversationSourceMessageId: context.triggerMessage.id };
}
