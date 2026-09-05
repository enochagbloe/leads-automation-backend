import { AiBusinessContext, aiPromptContextFormatter } from "./ai-context-builder.service";
import { aiProvider, AiGenerateReplyInput } from "./ai-provider.service";

/** Shared prompt/provider execution; callers own policy and side effects. */
export function generateContextReply(context: AiBusinessContext, options: Omit<AiGenerateReplyInput, "systemPrompt" | "userPrompt">) {
  return aiProvider.generateReply({ ...options, systemPrompt: aiPromptContextFormatter.buildSystemPrompt(context), userPrompt: aiPromptContextFormatter.buildUserPrompt(context) });
}
