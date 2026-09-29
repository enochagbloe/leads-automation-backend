/** Provider fixture: structured wording only; no independent intent or action. */
export function responseOutput(input: { userPrompt: string }, text?: string) {
  const envelope = JSON.parse(input.userPrompt.split("\nCorrect the preceding")[0]!);
  const p = envelope.context.sections.conversationPlan.data;
  const question = p.responseDirective.askOneQuestion;
  const parts = p.continuation && text ? text.match(/^([\s\S]+[.!])\s+([^.!]+\?)$/) : null;
  return { complaints: [], text: text ?? (question ? p.targetField === "serviceNeed" ? "Sure — what do you need help with?" : p.targetField === "preferredDate" ? "What day would you like to come in?" : "Could you clarify what you mean?" : "I can help with that."),
    answerText: parts?.[1] ?? null, continuationQuestion: parts?.[2] ?? null,
    acknowledgedContext: false, fulfilledPurpose: p.responseDirective.purpose,
    askedField: p.continuation?.field ?? (["ASK_FOR_FIELD", "ASK_FOR_OPTION", "ASK_FOR_CLARIFICATION"].includes(p.move) ? p.targetField ?? null : null),
    questionCount: question ? 1 : 0, referencedOptionIds: p.options?.map((o: any) => o.id) ?? [],
    referencedFactIds: envelope.responseFacts.map((f: any) => f.id), claimsActionCompleted: false, claims: [], confidence: 1, requiresHumanReview: p.requiresHumanReview };
}
