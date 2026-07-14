import { AppointmentLocationType, AppointmentSource, BusinessRole, MembershipStatus, Prisma, ServiceCapacityMode } from "@prisma/client";
import { checkSlot, lockAppointmentAvailabilityScope } from "./appointment-availability.service";
import { InternalCreateAppointmentInput } from "./appointment.types";

export type AppointmentServiceRules = {
  id: string;
  capacityMode: ServiceCapacityMode;
  autoConfirmEligible: boolean;
  requiresManualApproval: boolean;
  requiresManagerApproval: boolean;
  requiresStaffAssignment: boolean;
  requiresStaffAssignmentBeforeConfirmation: boolean;
  allowedLocationTypes: AppointmentLocationType[];
  defaultLocationType: AppointmentLocationType | null;
  requiredStaffRole: string | null;
  requiredSkillTags: string[];
  allowAiToChooseLocationType: boolean;
};

export type EligibleStaffMember = {
  id: string;
  role: BusinessRole;
  positionTitle: string | null;
  specialties: string[];
  serviceTags: string[];
  canTakeAppointments: boolean;
};

export function normalizeMatch(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

export function resolveAppointmentLocationType(input: InternalCreateAppointmentInput, service: AppointmentServiceRules | null) {
  if (input.source !== AppointmentSource.AI_CONVERSATION || input.locationType !== AppointmentLocationType.TO_BE_CONFIRMED) {
    return input.locationType;
  }
  if (!service) return input.locationType;
  if (service.defaultLocationType) return service.defaultLocationType;
  if (service.allowedLocationTypes.length === 1) return service.allowedLocationTypes[0]!;
  return input.locationType;
}

export function staffMatchesServiceRules(member: EligibleStaffMember, service: AppointmentServiceRules) {
  const requiredRole = normalizeMatch(service.requiredStaffRole);
  if (requiredRole) {
    const role = normalizeMatch(member.role);
    const position = normalizeMatch(member.positionTitle);
    if (role !== requiredRole && position !== requiredRole) return false;
  }
  if (service.requiredSkillTags.length === 0) return true;
  const memberTags = new Set([...member.specialties, ...member.serviceTags].map(normalizeMatch).filter(Boolean));
  return service.requiredSkillTags.every((tag) => memberTags.has(normalizeMatch(tag)));
}

export async function findEligibleAvailableStaff(
  tx: Prisma.TransactionClient,
  input: {
    businessId: string;
    service: AppointmentServiceRules;
    serviceId: string | undefined;
    date: string;
    time: string;
    timezone: string;
    durationMinutes?: number;
  },
) {
  if (input.service.capacityMode !== ServiceCapacityMode.STAFF_BASED) return null;
  const candidates = await tx.businessMember.findMany({
    where: {
      businessId: input.businessId,
      status: MembershipStatus.ACTIVE,
      canTakeAppointments: true,
      role: { in: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER, BusinessRole.STAFF] },
    },
    select: {
      id: true,
      role: true,
      positionTitle: true,
      specialties: true,
      serviceTags: true,
      canTakeAppointments: true,
      aiHandoffPriority: true,
      createdAt: true,
    },
    orderBy: [{ aiHandoffPriority: "asc" }, { createdAt: "asc" }],
  });
  for (const candidate of candidates) {
    if (!staffMatchesServiceRules(candidate, input.service)) continue;
    await lockAppointmentAvailabilityScope(tx, { businessId: input.businessId, assignedStaffId: candidate.id, date: input.date });
    const availability = await checkSlot({
      businessId: input.businessId,
      serviceId: input.serviceId,
      date: input.date,
      time: input.time,
      timezone: input.timezone,
      assignedStaffId: candidate.id,
      durationMinutes: input.durationMinutes,
    }, tx);
    if (availability.available) return { memberId: candidate.id, availability };
  }
  return null;
}
