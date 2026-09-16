import { ConversationPlan } from "./conversation-plan.schema";
import { StateData } from "./conversation-state.schema";
import { ConversationResponse, conversationResponseSchema, WorkflowExecutionResult, workflowExecutionResultSchema } from "./conversation-response.schema";
export type ResponseFact = { id: string; value: string };
export type ResponsePolicyInput = { plan: ConversationPlan; state: StateData; recentMessages: Array<{ senderType: string; text: string }>; trustedWorkflowResult?: WorkflowExecutionResult; facts: ResponseFact[]; existingIssueIds?: string[]; generatedResponse: unknown };
export const fieldLabels: Record<string, string> = { preferredDate: "day", preferredTime: "time", customerName: "name", customerPhone: "phone number", customerLocation: "location", branch: "branch", service: "service", serviceName: "service", email: "email address" };
const fieldPatterns: Record<string, RegExp> = { preferredDate: /\b(day|date)\b/i, preferredTime: /\btime\b/i, customerName: /\bname\b/i, customerPhone: /\b(phone|number)\b/i, customerLocation: /\b(location|address)\b/i, branch: /\bbranch\b/i, service: /\bservice\b/i, email: /\bemail\b/i };
const positiveClaims: Array<[ConversationResponse["claims"][number], RegExp]> = [
  ["APPOINTMENT_CONFIRMED", /\b(?:appointment|booking|visit)\b.{0,35}\b(?:confirmed|booked|scheduled)\b|\b(?:confirmed|booked|scheduled)\b.{0,25}\b(?:appointment|booking|visit)\b/i],
  ["AVAILABILITY", /\b(?:slot|time|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b.{0,25}\b(?:is available|is free|is open)\b|\bwe have\b.{0,55}\bavailable\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\s+works[.!]?|\bavailable at \d/i],
  ["HANDOFF", /\b(?:passed|sent|forwarded|contacted|notified)\b.{0,35}\b(?:team|human|staff|someone)\b/i],
  ["PAYMENT", /\bpayment\b.{0,20}\b(?:received|successful|completed)\b/i], ["REFUND", /\brefund\b.{0,20}\b(?:processed|sent|completed)\b/i],
  ["QUOTE", /\bquote\b.{0,15}\b(?:sent|issued)\b/i], ["STAFF_ASSIGNED", /\bstaff\b.{0,25}\bassigned\b/i],
];
export function mentionedTimes(text: string) { return [...text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b([01]\d|2[0-3]):([0-5]\d)\b/gi)].map(m => m[4] ? `${m[4]}:${m[5]}` : `${String(Number(m[1]) % 12 + (m[3]!.toLowerCase() === "pm" ? 12 : 0)).padStart(2, "0")}:${m[2] ?? "00"}`); }
const amounts = (text: string) => [...text.matchAll(/(GH₵|GHS|USD|GBP|EUR|[$£€])\s*([0-9]+(?:[.,][0-9]+)*)/gi)].map(m => {
  const currency = ({ "GH₵": "GHS", "$": "USD", "£": "GBP", "€": "EUR" } as Record<string, string>)[m[1]!.toUpperCase()] ?? m[1]!.toUpperCase();
  return `${currency}:${m[2]!.replace(/,/g, "")}`;
});
// Use the same grounded-price recognition as response validation; do not infer missing prices.
export const hasGroundedPrice = (facts: ResponseFact[]) => facts.some(f => amounts(f.value).length > 0 || /"(?:pricing|price)"\s*:\s*"free\.?"/i.test(f.value));
export const conversationResponsePolicyService = {
  validate(input: ResponsePolicyInput) {
    const parsed = conversationResponseSchema.safeParse(input.generatedResponse);
    if (!parsed.success) return { valid: false as const, issues: ["RESPONSE_SCHEMA_INVALID"] };
    const r = parsed.data; const p = input.plan; const issues = new Set<string>(); const text = r.text ?? "";
    if (r.complaints.length && (p.intent !== "COMPLAINT" || r.complaints.some(c => c.matchedIssueId && !input.existingIssueIds?.includes(c.matchedIssueId)))) issues.add("COMPLAINT_REFERENCE_INVALID");
    if (p.move === "NO_ACTION" ? r.text !== null : !text) issues.add("RESPONSE_PRESENCE_INVALID");
    if (r.requiresHumanReview !== p.requiresHumanReview) issues.add("REVIEW_POLICY_MISMATCH");
    if (r.fulfilledPurpose !== p.responseDirective.purpose) issues.add("PURPOSE_MISMATCH");
    const expectedField = ["ASK_FOR_FIELD", "ASK_FOR_OPTION", "ASK_FOR_CLARIFICATION"].includes(p.move) ? p.targetField ?? null : null;
    if (p.move === "ASK_FOR_FIELD" && expectedField && fieldPatterns[expectedField] && !fieldPatterns[expectedField]!.test(text) && !(expectedField === "preferredDate" && /\bwhen\b/i.test(text))) issues.add("PLANNED_FIELD_NOT_ASKED");
    if (p.responseDirective.askOneQuestion && !text.includes("?") && !/\b(?:please|tell me|share|choose|select)\b/i.test(text)) issues.add("QUESTION_MISSING");
    if (r.askedField !== expectedField) issues.add("WRONG_FIELD");
    if (p.responseDirective.askOneQuestion ? r.questionCount !== 1 || (text.match(/\?/g)?.length ?? 0) > 1 : r.questionCount !== 0 || text.includes("?")) issues.add("QUESTION_COUNT_INVALID");
    const clauses = text.match(/(?:what|which|when|please (?:provide|share|tell)|could you (?:share|tell)|can you (?:share|tell))[^?.!]*/gi) ?? [];
    for (const clause of clauses) for (const [field, pattern] of Object.entries(fieldPatterns)) if (pattern.test(clause) && expectedField && field !== expectedField && !(expectedField === "serviceName" && field === "service")) issues.add("WRONG_FIELD_IN_TEXT");
    if (!p.responseDirective.askOneQuestion && clauses.length) issues.add("UNPLANNED_QUESTION");
    if (p.move === "ASK_FOR_CLARIFICATION" && /\b(?:I(?: will|'ll)|we(?: will|'ll)) (?:choose|select|go with|use)\b/i.test(text)) issues.add("CLARIFICATION_GUESSES");
    if (expectedField && input.state.knownEntities[expectedField] && p.move === "ASK_FOR_FIELD") issues.add("KNOWN_FIELD_REQUESTED");
    const options = p.options ?? (p.move === "ASK_FOR_CLARIFICATION" ? input.state.offeredOptions : []);
    if (new Set(r.referencedOptionIds).size !== r.referencedOptionIds.length || r.referencedOptionIds.some(id => !options.some(o => o.id === id))) issues.add("OPTION_REFERENCE_INVALID");
    if (p.move === "ASK_FOR_OPTION" && (r.referencedOptionIds.length !== options.length || options.some(o => !r.referencedOptionIds.includes(o.id) || !text.includes(o.label)))) issues.add("OPTIONS_NOT_PRESERVED");
    if (p.move.startsWith("ASK_") && !["service", "serviceName"].includes(expectedField ?? "") && /\b(?:we offer[^.!?]*,|our services include)/i.test(text)) issues.add("UNPLANNED_SERVICE_MENU");
    const activeTime = input.state.knownEntities.preferredTime?.normalizedValue;
    const allowedTimes = new Set([...(typeof activeTime === "string" ? [activeTime] : []), ...options.map(o => String(o.value))]);
    if (p.move !== "ANSWER" && allowedTimes.size && mentionedTimes(text).some(time => !allowedTimes.has(time))) issues.add("UNSUPPORTED_TIME");
    if (r.referencedFactIds.some(id => !input.facts.some(f => f.id === id))) issues.add("FACT_REFERENCE_INVALID");
    const priceEvidence = input.facts.filter(f => r.referencedFactIds.includes(f.id)).map(f => f.value).join(" ");
    if (/\b(?:costs?|price is|starts? at)\s+[0-9]/i.test(text)) issues.add("PRICE_CURRENCY_MISSING");
    if (amounts(text).some(amount => !amounts(priceEvidence).includes(amount))) issues.add("UNSUPPORTED_PRICE");
    const trusted = input.trustedWorkflowResult ? workflowExecutionResultSchema.safeParse(input.trustedWorkflowResult) : null;
    const result = trusted?.success ? trusted.data : undefined;
    const scoped = result?.businessId === p.businessId && result?.conversationId === p.conversationId && result?.sourceMessageId === p.sourceMessageId && result?.stateRevision === p.stateRevision;
    const supported = new Set(!p.demoSessionId && scoped && result?.status === "SUCCEEDED" ? result.claims : []);
    const detected = positiveClaims.filter(([, pattern]) => text.split(/[.!?]|\bbut\b/i).some(sentence => pattern.test(sentence.replace(/\b(?:not|never|isn't|hasn't|cannot|can't|no)\s+(?:been\s+)?(?:confirmed|booked|scheduled|available|contacted|sent|received|processed|assigned)\b/gi, "")))).map(([claim]) => claim);
    if (/^\s*(?:confirmed|booked|scheduled)[!.]?\s*$/i.test(text)) detected.push("APPOINTMENT_CONFIRMED");
    if ([...r.claims, ...detected].some(claim => !supported.has(claim)) || r.claimsActionCompleted && (!supported.size || result?.status !== "SUCCEEDED")) issues.add("UNSUPPORTED_OUTCOME");
    if (/\b(?:ConversationPlan|CREATE_BOOKING_REQUEST|workflow|entity|sourceMessageId|preferredDate|preferredTime|according to the system)\b/i.test(text) || [p.businessId, p.conversationId, p.sourceMessageId].some(id => id.length > 5 && text.includes(id))) issues.add("INTERNAL_TERMINOLOGY");
    if (/thank you for (?:providing|confirming|your response)|please provide (?:the following|your preferred)|your requested entity/i.test(text)) issues.add("FORM_LIKE_LANGUAGE");
    const prior = input.recentMessages.filter(m => m.senderType === "AI" || m.senderType === "STAFF");
    if (prior.length && /^(?:hello|hi[!,. ]|welcome|good morning)/i.test(text)) issues.add("REPEATED_GREETING");
    const opening = text.split(/[.!?]/)[0]?.trim().toLowerCase();
    if (r.acknowledgedContext && opening && opening.length > 12 && prior.slice(-2).some(m => m.text.toLowerCase().startsWith(opening))) issues.add("REPEATED_ACKNOWLEDGEMENT");
    return issues.size ? { valid: false as const, issues: [...issues] } : { valid: true as const, response: r, issues: [] };
  },
};
