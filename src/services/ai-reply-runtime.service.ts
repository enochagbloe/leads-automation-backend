import { conversationContextService } from "./conversation-context.service";
import { AiBusinessContext, aiPromptContextFormatter } from "./ai-context-builder.service";
import { aiProvider, AiGenerateReplyInput } from "./ai-provider.service";
import { conversationInterpreterService } from "./conversation-interpreter.service";
import { AppError } from "../utils/errors";

/** Shared prompt/provider execution; callers own policy and side effects. */
export async function generateContextReply(context: AiBusinessContext, options: Omit<AiGenerateReplyInput, "systemPrompt" | "userPrompt">) {
  const scope = { businessId: context.business.id, conversationId: context.conversation.id, demoSessionId: context.demoSessionId, messageId: context.triggerMessage.id, customerMemorySummary: context.customerMemory.summary ?? undefined };
  let snapshot = await conversationContextService.getSnapshot(scope);
  const meaning = await conversationInterpreterService.interpret({ businessContext: context, conversationSnapshot: snapshot, signal: options.signal, model: options.model });
  if (meaning.commands.length) {
    snapshot = await conversationContextService.getSnapshot(scope);
    if (snapshot.state.revision !== meaning.appliedRevision) throw new AppError(409, "Conversation changed after interpretation", "CONVERSATION_STATE_CONFLICT");
  }
  context = { ...context, conversationSnapshot: snapshot, recentMessages: snapshot.recentMessages, conversationInterpretation: meaning.interpretation };
  const result = await aiProvider.generateReply({ ...options, systemPrompt: aiPromptContextFormatter.buildSystemPrompt(context), userPrompt: aiPromptContextFormatter.buildUserPrompt(context) }).catch(error => {
    const failure = error instanceof AppError ? error : new AppError(503, "AI reply unavailable", "AI_PROVIDER_ERROR");
    failure.context = { ...failure.context, conversationInterpretationUsage: { requests: meaning.usage?.providerRequestCount ?? 0, tokens: meaning.usage?.totalTokens ?? 0 } };
    throw failure;
  });
  const decision = result.parsedDecision;
  if (decision && !result.fallbackExhausted) {
    // One canonical semantic intent. Uncertain meaning cannot authorize old-parser workflow effects.
    decision.intent = meaning.interpretation.needsClarification ? "UNKNOWN" : meaning.interpretation.intent;
    if (meaning.interpretation.needsClarification) {
      delete decision.appointmentIntent; delete decision.complaint; delete decision.complaints;
      decision.suggestedAction = decision.requiresHumanReview ? "REQUEST_HUMAN_REVIEW" : decision.shouldReply ? "SEND_REPLY" : "NO_ACTION";
    } else {
      if (decision.intent !== "COMPLAINT") { delete decision.complaint; delete decision.complaints; }
      if (!["BOOKING_INTENT", "RESCHEDULE_INTENT", "CANCELLATION_INTENT"].includes(decision.intent)) {
        delete decision.appointmentIntent;
        if (decision.suggestedAction === "CREATE_BOOKING_REQUEST" || decision.suggestedAction === "DETECT_BOOKING_ONLY") decision.suggestedAction = decision.requiresHumanReview ? "REQUEST_HUMAN_REVIEW" : decision.shouldReply ? "SEND_REPLY" : "NO_ACTION";
      } else if (decision.appointmentIntent) {
        // Existing appointment validation and authorization still own execution.
        for (const key of ["preferredDate", "preferredTime"] as const) {
          const value = snapshot.state.knownEntities[key]?.normalizedValue;
          if (typeof value === "string") decision.appointmentIntent[key] = value;
        }
        if (snapshot.timezone) decision.appointmentIntent.timezone = snapshot.timezone;
      }
    }
  }
  return { ...result, totalTokens: (result.totalTokens ?? 0) + (meaning.usage?.totalTokens ?? 0), promptTokens: (result.promptTokens ?? 0) + (meaning.usage?.promptTokens ?? 0), completionTokens: (result.completionTokens ?? 0) + (meaning.usage?.completionTokens ?? 0), providerRequestCount: result.providerRequestCount + (meaning.usage?.providerRequestCount ?? 0), conversationStateRevision: snapshot.state.revision, conversationSourceMessageId: context.triggerMessage.id, interpretation: meaning.interpretation };
}
