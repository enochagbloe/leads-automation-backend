import { createHash } from "crypto";
import { BusinessRole } from "@prisma/client";
import { AppointmentActor } from "./appointment.types";
import { cacheService } from "../cache.service";
import { invalidateBusinessSetupStatus } from "../business-setup.service";
import { invalidateBusinessKnowledgePreview } from "../business-knowledge-cache.service";
import { AppointmentCalendarQuery, AppointmentListQuery } from "../../validation/appointment.schemas";

export function listKey(actor: AppointmentActor, query: AppointmentListQuery) {
  const scope = actor.role === BusinessRole.STAFF ? actor.membershipId : "all";
  const hash = createHash("sha256").update(JSON.stringify({ query, scope })).digest("hex");
  return `business:${actor.businessId}:appointments:list:${hash}`;
}

export function calendarKey(actor: AppointmentActor, query: AppointmentCalendarQuery) {
  const scope = actor.role === BusinessRole.STAFF ? actor.membershipId : "all";
  const hash = createHash("sha256").update(JSON.stringify({ query, scope })).digest("hex");
  return `business:${actor.businessId}:appointments:calendar:${hash}`;
}

export function detailKey(actor: AppointmentActor, appointmentId: string) {
  const scope = actor.role === BusinessRole.STAFF ? actor.membershipId : "all";
  return `business:${actor.businessId}:appointments:detail:${appointmentId}:${scope}`;
}

export async function invalidateAppointmentCaches(businessId: string, appointmentId?: string) {
  await Promise.all([
    cacheService.delByPattern(`business:${businessId}:appointments:list:*`),
    cacheService.delByPattern(`business:${businessId}:appointments:calendar:*`),
    cacheService.delByPattern(`business:${businessId}:appointments:summary*`),
    ...(appointmentId ? [cacheService.delByPattern(`business:${businessId}:appointments:detail:${appointmentId}:*`)] : []),
    invalidateBusinessSetupStatus(businessId),
    invalidateBusinessKnowledgePreview(businessId, "APPOINTMENTS"),
  ]);
}
