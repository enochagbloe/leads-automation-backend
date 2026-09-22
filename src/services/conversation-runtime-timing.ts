type Stage = "contextBuildMs" | "interpretationMs" | "plannerMs" | "workflowMs" | "responseMs" | "persistenceMs";
/** Request-local monotonic measurements. Never accepts message text or tokens. */
export class ConversationRuntimeTiming {
  private readonly started = performance.now();
  readonly stages: Record<Stage, number> = { contextBuildMs: 0, interpretationMs: 0, plannerMs: 0, workflowMs: 0, responseMs: 0, persistenceMs: 0 };
  async measure<T>(stage: Stage, task: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try { return await task(); } finally { this.stages[stage] += performance.now() - start; }
  }
  report(scope: { businessId: string; conversationId: string; sourceMessageId: string }) {
    const stages = Object.fromEntries(Object.entries(this.stages).map(([key, value]) => [key, Math.round(value)]));
    console.info("conversation_runtime.timing", { ...scope, ...stages, totalMs: Math.round(performance.now() - this.started) });
  }
}
