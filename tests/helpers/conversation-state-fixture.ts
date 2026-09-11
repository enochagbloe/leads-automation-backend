import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { Prisma } from "@prisma/client";
import { prisma } from "../../src/config/prisma";
import { emptyState } from "../../src/services/conversation-state.schema";
import { mockMethod } from "./mock-method";
export const scope = { businessId: "business-a", conversationId: "conversation-a" };
export function fixture(t: TestContext) {
  const logs: any[] = [];
  mockMethod(t, console, "info", (...args: any[]) => { logs.push(args); });
  mockMethod(t, console, "warn", (...args: any[]) => { logs.push(args); });
  let state: any = null;
  let effects: any[] = [];
  let receipts: any[] = [];
  let timezone = "Africa/Accra";
  let messages: any[] = [];
  let demoId: string | null = null;
  let active = true;
  let failAudit = false;
  let status = "AI_HANDLING";
  const match = (row: any, where: any): boolean => Object.entries(where).every(([k, v]: [string, any]) => k === "metadata" ? v.path.reduce((o: any, key: string) => o?.[key], row.metadata) === v.equals : k === "OR" ? v.some((w: any) => match(row, w)) : v && typeof v === "object" && !(v instanceof Date) ? v.in ? v.in.includes(row[k]) : v.lt !== undefined ? row[k] < v.lt : v.lte !== undefined ? row[k] <= v.lte : true : v instanceof Date ? +row[k] === +v : row[k] === v);
  const tx: any = {
    $queryRaw: async () => [],
    conversation: {
      findFirst: async ({ where }: any) => where.id === scope.conversationId && where.businessId === scope.businessId ? { id: scope.conversationId, status, humanTakeover: status === "HUMAN_HANDLING", aiEnabled: true, channel: demoId ? "DEMO" : "WHATSAPP", business: { demoSessionId: demoId, timezone } } : null,
      update: async () => ({ id: scope.conversationId, status }),
    },
    demoSession: { findFirst: async ({ where }: any) => active && where.id === demoId && where.business.id === scope.businessId ? { id: demoId } : null },
    conversationState: {
      createMany: async ({ data }: any) => { state ??= { ...emptyState(), ...data[0], id: "state", revision: 0, lastActivityAt: new Date(), createdAt: new Date(), updatedAt: new Date() }; return { count: 1 }; },
      findFirst: async ({ where }: any) => state && match(state, where) ? structuredClone(state) : null,
      findFirstOrThrow: async ({ where }: any) => { assert.ok(state && match(state, where)); return structuredClone(state); },
      updateMany: async ({ where, data }: any) => { if (!match(state, where)) return { count: 0 }; state = { ...state, ...data, awaiting: data.awaiting === Prisma.DbNull ? null : data.awaiting, revision: state.revision + data.revision.increment }; return { count: 1 }; },
    },
    conversationInterpretation: {
      findFirst: async ({ where }: any) => receipts.find(r => match(r, where)) ?? null,
      create: async ({ data }: any) => { if (failAudit) throw new Error("receipt unavailable"); receipts.push(data); return data; },
    },
    conversationStateEffect: {
      findFirst: async ({ where }: any) => effects.find(e => match(e, where)) ?? null,
      create: async ({ data }: any) => { if (failAudit) throw new Error("audit unavailable"); effects.push(data); return data; },
    },
    message: {
      create: async ({ data }: any) => { const row = { id: `m${messages.length}`, deletedAt: null, createdAt: new Date(), ...data }; messages.push(row); return row; },
      findFirst: async ({ where }: any) => messages.find(m => match(m, where)) ?? null,
      findMany: async ({ where, take }: any) => messages.filter(m => match(m, where)).sort((a, b) => +b.createdAt - +a.createdAt || b.id.localeCompare(a.id)).slice(0, take),
    },
    leadActivity: { create: async () => ({}) },
  };
  let queue = Promise.resolve();
  mockMethod(t, prisma, "$transaction", (fn: any) => {
    const run = queue.then(async () => {
      const old = structuredClone({ state, effects, messages, receipts });
      try { return await fn(tx); } catch (error) { ({ state, effects, messages, receipts } = old); throw error; }
    });
    queue = run.then(() => {}, () => {}); return run;
  });
  return { tx, logs, setTimezone: (value: string) => { timezone = value; }, receipts: () => receipts, state: () => state, effects: () => effects, messages: () => messages, demo: () => { demoId = "demo-a"; }, expire: () => { active = false; }, fail: () => { failAudit = true; }, human: () => { status = "HUMAN_HANDLING"; }, add: async (content: string, senderType = "CUSTOMER") => tx.message.create({ data: { ...scope, content, senderType, direction: senderType === "CUSTOMER" ? "INBOUND" : "OUTBOUND", createdAt: new Date(Date.now() + messages.length * 1000) } }) };
}
