import { env } from "../config/env";

/** Bounded database-only work. Never put provider calls inside these transactions. */
export function conversationTransactionOptions() {
  return { maxWait: 10000, timeout: env.CONVERSATION_TRANSACTION_TIMEOUT_MS };
}
