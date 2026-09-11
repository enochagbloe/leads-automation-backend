import type { AiReplyDecision } from "../ai-decision-parser.service";

/** Shared minimum input gate for planning and the existing AI booking boundary. */
export function missingAiBookingFields(intent: AiReplyDecision["appointmentIntent"]) {
  const missing = new Set(intent?.missingFields ?? []);
  if (!intent?.serviceId && !intent?.serviceName) missing.add("service");
  const date = intent?.preferredDate;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) missing.add("preferredDate");
  if (!intent?.preferredTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(intent.preferredTime)) missing.add("preferredTime");
  return [...missing];
}
