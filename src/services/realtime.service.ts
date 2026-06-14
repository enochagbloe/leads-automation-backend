import crypto from "node:crypto";
import { BusinessRole } from "@prisma/client";
import { Response } from "express";

export type RealtimeEventType =
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
  | "business.policies.summary.updated";

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

function writeEvent(response: Response, event: RealtimeEvent) {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export const realtimeService = {
  // TODO: Replace in-memory pub/sub with Redis Pub/Sub when running multiple backend instances.
  publish(input: PublishInput) {
    const { assignedStaffId, staffMembershipIds = [], broadcastToStaff = false, ...publicInput } = input;
    const event: RealtimeEvent = {
      ...publicInput,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    for (const client of clients.values()) {
      if (client.businessId !== event.businessId) continue;
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
