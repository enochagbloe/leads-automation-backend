import { FollowUpContextType } from "@prisma/client";
import { FollowUpContextEvaluationResult } from "./follow-up.types";
import {
  extractDateTime,
  extractEmail,
  hasLikelyLocation,
  meaningfulReply,
  quoteAccepted,
  quoteRejected,
} from "./follow-up.shared";

// Base/shared section: deterministic inbound-reply evaluation.
// Plus/Premium can later add AI-assisted resolution without replacing this Basic-safe path.
export const followUpContextEvaluationService = {
  async evaluateInboundReplyAgainstPendingJobs(input: {
    businessId: string;
    conversationId: string;
    leadId: string;
    inboundMessageId: string;
    inboundMessageText: string;
    pendingJobs: Array<{ id: string; contextType: FollowUpContextType; pendingQuestion: string | null; expectedResponseType: string | null }>;
  }): Promise<FollowUpContextEvaluationResult[]> {
    const text = input.inboundMessageText.trim();
    const email = extractEmail(text);
    const dateTime = extractDateTime(text);
    return input.pendingJobs.map((job) => {
      if (job.contextType === FollowUpContextType.CONTACT_EMAIL_REQUEST) {
        return email
          ? { jobId: job.id, doesReplyAddressPendingContext: true, pendingContextResolved: true, replyIntent: "PROVIDED_EMAIL", extractedFields: { email }, action: "CANCEL_FOLLOW_UP", reason: "Customer provided an email address." }
          : { jobId: job.id, doesReplyAddressPendingContext: false, pendingContextResolved: false, replyIntent: "NO_EMAIL_PROVIDED", extractedFields: {}, action: "KEEP_FOLLOW_UP", reason: "Customer reply did not include an email address." };
      }
      if (job.contextType === FollowUpContextType.LOCATION_REQUEST) {
        return hasLikelyLocation(text)
          ? { jobId: job.id, doesReplyAddressPendingContext: true, pendingContextResolved: true, replyIntent: "PROVIDED_LOCATION", extractedFields: { location: text.slice(0, 240) }, action: "CANCEL_FOLLOW_UP", reason: "Customer provided a likely location." }
          : { jobId: job.id, doesReplyAddressPendingContext: false, pendingContextResolved: false, replyIntent: "LOCATION_NOT_PROVIDED", extractedFields: {}, action: "KEEP_FOLLOW_UP", reason: "Customer reply did not resolve the location request." };
      }
      if (job.contextType === FollowUpContextType.DATE_TIME_REQUEST) {
        return dateTime.date || dateTime.time
          ? { jobId: job.id, doesReplyAddressPendingContext: true, pendingContextResolved: true, replyIntent: "PROVIDED_DATE_OR_TIME", extractedFields: { date: dateTime.date, time: dateTime.time }, action: "CANCEL_FOLLOW_UP", reason: "Customer provided date or time information." }
          : { jobId: job.id, doesReplyAddressPendingContext: false, pendingContextResolved: false, replyIntent: "DATE_TIME_NOT_PROVIDED", extractedFields: {}, action: "KEEP_FOLLOW_UP", reason: "Customer reply did not include date or time information." };
      }
      if (job.contextType === FollowUpContextType.QUOTE_RESPONSE || job.contextType === FollowUpContextType.PAYMENT_RESPONSE) {
        if (quoteAccepted(text)) return { jobId: job.id, doesReplyAddressPendingContext: true, pendingContextResolved: true, replyIntent: "QUOTE_ACCEPTED", extractedFields: { quoteAccepted: true }, action: "CANCEL_FOLLOW_UP", reason: "Customer accepted or approved the follow-up context." };
        if (quoteRejected(text)) return { jobId: job.id, doesReplyAddressPendingContext: true, pendingContextResolved: true, replyIntent: "QUOTE_REJECTED", extractedFields: { quoteAccepted: false }, action: "CANCEL_FOLLOW_UP", reason: "Customer rejected the quote/payment follow-up context." };
        return { jobId: job.id, doesReplyAddressPendingContext: false, pendingContextResolved: false, replyIntent: "QUOTE_CLARIFICATION_OR_UNRELATED", extractedFields: {}, action: "KEEP_FOLLOW_UP", reason: "Customer did not clearly accept or reject." };
      }
      if (job.contextType === FollowUpContextType.GENERAL_NO_RESPONSE) {
        return meaningfulReply(text)
          ? { jobId: job.id, doesReplyAddressPendingContext: true, pendingContextResolved: true, replyIntent: "MEANINGFUL_REPLY", extractedFields: {}, action: "CANCEL_FOLLOW_UP", reason: "Customer replied meaningfully." }
          : { jobId: job.id, doesReplyAddressPendingContext: false, pendingContextResolved: false, replyIntent: "UNCLEAR_REPLY", extractedFields: {}, action: "KEEP_FOLLOW_UP", reason: "Customer reply was too unclear to cancel the follow-up." };
      }
      if (job.contextType === FollowUpContextType.POST_APPOINTMENT_FEEDBACK) {
        return meaningfulReply(text)
          ? { jobId: job.id, doesReplyAddressPendingContext: true, pendingContextResolved: true, replyIntent: "POST_APPOINTMENT_FEEDBACK_RECEIVED", extractedFields: {}, action: "CANCEL_FOLLOW_UP", reason: "Customer already responded after the appointment." }
          : { jobId: job.id, doesReplyAddressPendingContext: false, pendingContextResolved: false, replyIntent: "UNCLEAR_POST_APPOINTMENT_REPLY", extractedFields: {}, action: "KEEP_FOLLOW_UP", reason: "Customer reply was too unclear to resolve post-appointment feedback." };
      }
      return { jobId: job.id, doesReplyAddressPendingContext: false, pendingContextResolved: false, replyIntent: "UNCLASSIFIED_CONTEXT", extractedFields: {}, action: "KEEP_FOLLOW_UP", reason: "No deterministic resolver matched this context." };
    });
  },
};
