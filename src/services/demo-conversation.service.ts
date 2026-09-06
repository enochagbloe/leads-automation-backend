import { DemoActor } from "./demo.service";
import { demoMessageService } from "./demo-message.service";
import { processDemoReplyForMessage } from "./demo-ai-processing.service";

/** Demo transport orchestration. Inbound storage commits before external AI work. */
export const demoConversationService = {
  async send(actor: DemoActor, input: unknown) {
    const stored = await demoMessageService.create(actor, input);
    const reply = await processDemoReplyForMessage(actor, stored.message.id);
    // Preserve Sprint 3A's `message` field while adding the correlated reply.
    return { ...stored, customerMessage: reply.customerMessage, aiMessage: reply.aiMessage };
  },
};
