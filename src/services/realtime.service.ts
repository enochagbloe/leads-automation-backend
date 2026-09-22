import { AppError } from "../utils/errors";
import crypto from "node:crypto";
import { BusinessRole } from "@prisma/client";
import { Response } from "express";

export type RealtimeEventType =
  | "demo.connected"
  | "demo.ai.processing"
  | "message.created"
  | "message.status.updated"
  | "conversation.created"
  | "conversation.updated"
  | "conversation.closed"
  | "conversation.reopened"
  | "conversation.assigned"
  | "conversation.read"
  | "conversation.unread_count.updated"
  | "lead.created"
  | "lead.updated"
  | "whatsapp.connection.updated"
  | "whatsapp.connection.deactivated"
  | "whatsapp.connection.error"
  | "business.profile.updated"
  | "business.service.created"
  | "business.service.updated"
  | "business.service.archived"
  | "business.service.restored"
  | "business.service.reordered"
  | "business.services.summary.updated"
  | "business.availability.updated"
  | "business.availability.summary.updated"
  | "business.policy.created"
  | "business.policy.updated"
  | "business.policy.archived"
  | "business.policy.restored"
  | "business.policy.reordered"
  | "business.policies.summary.updated"
  | "business.knowledge_preview.updated"
  | "business.knowledge.article.created"
  | "business.knowledge.article.updated"
  | "business.knowledge.document.uploaded"
  | "business.knowledge.document.updated"
  | "business.knowledge.document.processing_started"
  | "business.knowledge.document.extraction_completed"
  | "business.knowledge.document.analysis_completed"
  | "business.knowledge.document.governance_detected"
  | "business.knowledge.document.ready"
  | "business.knowledge.document.needs_review"
  | "business.knowledge.document.review_approved"
  | "business.knowledge.document.review_rejected"
  | "business.knowledge.document.failed"
  | "business.knowledge.review.resolved"
  | "business.knowledge.settings_synced"
  | "business.knowledge.document.approved"
  | "business.knowledge.document.replacement_confirmed"
  | "business.knowledge.document.permanently_deleted"
  | "business.knowledge.review.created"
  | "business.knowledge.conflict.detected"
  | "business.knowledge.conflict.resolved"
  | "business.knowledge.document.outdated"
  | "business.knowledge.fact.outdated"
  | "business.knowledge.settings_reconciled"
  | "business.knowledge.runtime_guard.updated"
  | "knowledge.document.uploaded"
  | "knowledge.document.queued"
  | "knowledge.document.failed"
  | "knowledge.document.archived"
  | "knowledge.document.restored"
  | "knowledge.document.deleted"
  | "business.knowledge.asset.send_failed"
  | "business.appointment.created"
  | "business.appointment.updated"
  | "business.appointment.rescheduled"
  | "business.appointment.cancelled"
  | "business.appointment.confirmation_required"
  | "business.appointment.needs_confirmation"
  | "business.appointment.confirmed"
  | "business.appointment.auto_confirmed"
  | "business.appointment.outcome_required"
  | "business.appointment.completed"
  | "business.appointment.no_show"
  | "business.appointment.missed"
  | "business.appointment.reschedule_limit_reached"
  | "business.appointment.assigned"
  | "business.appointment.customer_confirmation_sent"
  | "business.appointment.customer_confirmation_failed"
  | "business.appointment.customer_reschedule_sent"
  | "business.appointment.customer_reschedule_failed"
  | "business.appointment.reschedule_requested"
  | "business.appointment.reschedule_approved"
  | "business.appointment.reschedule_declined"
  | "business.appointment.reschedule_request_acknowledged"
  | "business.appointment.reschedule_request_acknowledgement_failed"
  | "business.appointment.customer_reschedule_decline_sent"
  | "business.appointment.customer_reschedule_decline_failed"
  | "business.appointments.calendar.updated"
  | "business.notification.created"
  | "business.member.joined"
  | "business.member.disabled"
  | "business.member.restored"
  | "business.member.removed"
  | "business.member.suspended_by_plan"
  | "business.member.access_changed"
  | "business.member.operational_profile_updated"
  | "business.team.updated"
  | "business.lead.claimed"
  | "business.conversation.claimed"
  | "business.appointment.claimed"
  | "business.invite.accepted"
  | "business.ai.reply.started"
  | "business.ai.reply.completed"
  | "business.ai.reply.blocked"
  | "business.ai.reply.failed"
  | "business.ai.booking_request.created"
  | "business.ai.human_review.required"
  | "business.ai.safe_handoff_triggered"
  | "business.customer_issue.created"
  | "business.customer_issue.routed"
  | "business.customer_issue.status_updated"
  | "business.follow_up.rule.created"
  | "business.follow_up.rule.updated"
  | "business.follow_up.job.scheduled"
  | "business.follow_up.job.cancelled"
  | "business.follow_up.jobs.cancelled_bulk"
  | "business.follow_up.job.rescheduled"
  | "business.follow_up.job.sent"
  | "business.follow_up.job.failed"
  | "business.follow_up.context.evaluated"
  | "business.follow_up.basic.no_response.scheduled"
  | "business.follow_up.basic.no_response.sent"
  | "business.follow_up.basic.contact_email.scheduled"
  | "business.follow_up.basic.contact_email.sent"
  | "business.follow_up.basic.appointment_reminder.scheduled"
  | "business.follow_up.basic.appointment_reminder.sent"
  | "business.follow_up.premium.intelligence_evaluated"
  | "business.follow_up.premium.no_response.scheduled"
  | "business.follow_up.premium.no_response.cancelled"
  | "business.follow_up.premium.no_response.rescheduled"
  | "business.follow_up.premium.execution.updated"
  | "business.ai_prompt.created"
  | "business.ai_prompt.updated"
  | "business.ai_prompt.draft.saved"
  | "business.ai_prompt.validation_completed"
  | "business.ai_prompt.activated"
  | "business.ai_prompt.deactivated"
  | "business.ai_prompt.archived"
  | "business.conversation.human_takeover.started"
  | "business.conversation.ai_resumed"
  | "business.conversation.updated";

export type RealtimeEvent = {
  id: string;
  type: RealtimeEventType;
  businessId: string;
  conversationId?: string;
  leadId?: string;
  messageId?: string;
  createdAt: string;
  payload: Record<string, unknown>;
};

type PublishInput = Omit<RealtimeEvent, "id" | "createdAt"> & {
  assignedStaffId?: string | null;
  staffMembershipIds?: Array<string | null | undefined>;
  roles?: BusinessRole[];
  broadcastToStaff?: boolean;
};

type Client = {
  id: string;
  businessId: string;
  userId: string;
  membershipId: string;
  role: BusinessRole;
  connectedAt: number;
  response: Response;
};

const clients = new Map<string, Client>();
type DemoClientInput = { demoSessionId: string; businessId: string; conversationId: string; expiresAt: number; response: Response; isValid: () => Promise<boolean> };
const demoClients = new Map<string, DemoClientInput & { close: () => void; checking: boolean }>();
export const DEMO_SSE_CONNECTION_LIMIT = 5;
const MAX_DEMO_CONNECTIONS = 1000;
let demoShuttingDown = false;

function writeEvent(response: Response, event: RealtimeEvent) {
  return response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export const realtimeService = {
  // TODO: Replace in-memory pub/sub with Redis Pub/Sub when running multiple backend instances.
  publishDemo(input: { demoSessionId: string; businessId: string; conversationId: string; type: RealtimeEventType; payload: Record<string, unknown> }) {
    const event = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...input, isDemo: true };
    for (const client of demoClients.values()) {
      if (client.expiresAt <= Date.now()) { client.close(); continue; }
      if (client.demoSessionId !== input.demoSessionId || client.businessId !== input.businessId || client.conversationId !== input.conversationId) continue;
      try { if (!writeEvent(client.response, event)) client.close(); }
      catch { client.close(); }
    }
    return event;
  },

  subscribeDemo(input: DemoClientInput) {
    if (demoShuttingDown) throw new AppError(503, "Server is shutting down", "DEMO_STREAM_UNAVAILABLE");
    if (input.expiresAt <= Date.now()) throw new AppError(401, "Demo session expired", "DEMO_SESSION_EXPIRED");
    if (demoClients.size >= MAX_DEMO_CONNECTIONS || [...demoClients.values()].filter(c => c.demoSessionId === input.demoSessionId).length >= DEMO_SSE_CONNECTION_LIMIT) throw new AppError(429, "Demo stream connection limit reached", "DEMO_STREAM_LIMIT_REACHED");
    const id = crypto.randomUUID();
    let timer: NodeJS.Timeout | undefined;
    const close = () => {
      demoClients.delete(id);
      if (timer) clearTimeout(timer);
      input.response.removeListener("close", close);
      input.response.removeListener("error", close);
      if (!input.response.writableEnded) input.response.end();
    };
    demoClients.set(id, { ...input, close, checking: false });
    timer = setTimeout(close, Math.max(0, input.expiresAt - Date.now())); timer.unref();
    input.response.once("close", close); input.response.once("error", close);
    try {
      input.response.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      input.response.flushHeaders();
      if (!writeEvent(input.response, { id: crypto.randomUUID(), type: "demo.connected", businessId: input.businessId, conversationId: input.conversationId, createdAt: new Date().toISOString(), payload: { conversationId: input.conversationId } })) close();
    } catch { close(); }
    return id;
  },
  disconnectDemo(demoSessionId: string) {
    for (const client of demoClients.values()) if (client.demoSessionId === demoSessionId) client.close();
  },
  disconnectAllDemo() {
    for (const client of demoClients.values()) client.close();
  },
  shutdownDemo() {
    demoShuttingDown = true;
    this.disconnectAllDemo();
  },
  demoClientCount() { return demoClients.size; },
  publish(input: PublishInput) {
    const { assignedStaffId, staffMembershipIds = [], roles, broadcastToStaff = false, ...publicInput } = input;
    const event: RealtimeEvent = {
      ...publicInput,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    for (const client of clients.values()) {
      if (client.businessId !== event.businessId) continue;
      if (roles && !roles.includes(client.role)) continue;
      if (
        client.role === BusinessRole.STAFF
        && !broadcastToStaff
        && assignedStaffId !== client.membershipId
        && !staffMembershipIds.includes(client.membershipId)
      ) continue;
      try {
        writeEvent(client.response, event);
      } catch (error) {
        console.error("Realtime publish failed", { clientId: client.id, businessId: event.businessId, type: event.type, error });
        this.unsubscribe(client.id);
      }
    }
    return event;
  },

  subscribe(input: Omit<Client, "id" | "connectedAt">) {
    const client: Client = { ...input, id: crypto.randomUUID(), connectedAt: Date.now() };
    clients.set(client.id, client);
    console.info("SSE client connected", {
      clientId: client.id,
      businessId: client.businessId,
      userId: client.userId,
      membershipId: client.membershipId,
      role: client.role,
    });
    return client;
  },

  unsubscribe(clientId: string) {
    const client = clients.get(clientId);
    if (!client) return;
    clients.delete(clientId);
    console.info("SSE client disconnected", {
      clientId,
      businessId: client.businessId,
      userId: client.userId,
      membershipId: client.membershipId,
      durationMs: Date.now() - client.connectedAt,
    });
  },

  heartbeat() {
    const data = JSON.stringify({ ts: new Date().toISOString() });
    for (const client of demoClients.values()) {
      if (client.expiresAt <= Date.now()) { client.close(); continue; }
      if (client.checking) continue;
      client.checking = true;
      void client.isValid().then(valid => {
        if (!valid || client.expiresAt <= Date.now()) { client.close(); return; }
        if (!client.response.writableEnded && !client.response.write(`event: ping\ndata: ${data}\n\n`)) client.close();
      }).catch(() => client.close()).finally(() => { client.checking = false; });
    }
    for (const client of clients.values()) {
      try {
        client.response.write(`event: ping\ndata: ${data}\n\n`);
      } catch (error) {
        console.error("Realtime heartbeat failed", { clientId: client.id, businessId: client.businessId, error });
        this.unsubscribe(client.id);
      }
    }
  },

  clientCount() {
    return clients.size;
  },
};

const heartbeatTimer = setInterval(() => realtimeService.heartbeat(), 25_000);
heartbeatTimer.unref();
