import { BusinessRole, Prisma, AppointmentStatus } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import { CheckAppointmentAvailabilityInput, AppointmentListQuery, AppointmentCalendarQuery } from "../../validation/appointment.schemas";
import { cacheService } from "../cache.service";
import { accessWhere, assignedStaffFilter } from "./appointment-access.service";
import { listKey, calendarKey, detailKey } from "./appointment-cache.service";
import { createAppointmentFromValidatedInput } from "./appointment-create.service";
import { rangeFromDates } from "./appointment-date-time.utils";
import { loadAppointment, markDueAppointmentsForOutcome } from "./appointment-record.service";
import { withAvailableActionsList, withAvailableActions } from "./appointment-status.service";
import { AppointmentActor } from "./appointment.types";
import { validateBusiness } from "./appointment-validation.service";
import { checkSlot } from "./appointment-availability.service";
import { appointmentInclude } from "./appointment.include";
import { ACTIVE_APPOINTMENT_STATUSES } from "./appointment.constants";

export async function checkAvailability(actor: AppointmentActor, input: CheckAppointmentAvailabilityInput) {
    await validateBusiness(actor);
    if (actor.role === BusinessRole.STAFF && input.assignedStaffId && input.assignedStaffId !== actor.membershipId) {
      throw new AppError(403, "You do not have permission to check another staff member's schedule.", "FORBIDDEN");
    }
    return checkSlot({
      ...input,
      assignedStaffId: actor.role === BusinessRole.STAFF ? actor.membershipId : input.assignedStaffId,
      businessId: actor.businessId,
    });
}

export async function list(actor: AppointmentActor, query: AppointmentListQuery) {
    await markDueAppointmentsForOutcome(actor);
    const key = listKey(actor, query);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const dateRange = rangeFromDates(query.dateFrom, query.dateTo);
    const filters: Prisma.AppointmentWhereInput[] = [accessWhere(actor)];
    if (query.status) filters.push({ status: query.status });
    if (query.source) filters.push({ source: query.source });
    if (query.serviceId) filters.push({ serviceId: query.serviceId });
    const assignedFilter = assignedStaffFilter(actor, query.assignedStaffId);
    if (Object.keys(assignedFilter).length > 0) filters.push(assignedFilter);
    if (query.leadId) filters.push({ leadId: query.leadId });
    if (query.conversationId) filters.push({ conversationId: query.conversationId });
    if (query.search) {
      filters.push({
        OR: [
          { title: { contains: query.search, mode: "insensitive" } },
          { description: { contains: query.search, mode: "insensitive" } },
          { notes: { contains: query.search, mode: "insensitive" } },
          { customerName: { contains: query.search, mode: "insensitive" } },
          { customerPhone: { contains: query.search } },
          { customerEmail: { contains: query.search, mode: "insensitive" } },
          { lead: { fullName: { contains: query.search, mode: "insensitive" } } },
          { lead: { phone: { contains: query.search } } },
          { lead: { email: { contains: query.search, mode: "insensitive" } } },
          { service: { name: { contains: query.search, mode: "insensitive" } } },
        ],
      });
    }
    if (dateRange) filters.push({ startTime: dateRange });
    const where: Prisma.AppointmentWhereInput = { AND: filters };
    const [data, total, grouped] = await prisma.$transaction([
      prisma.appointment.findMany({
        where,
        include: appointmentInclude,
        orderBy: [{ startTime: "asc" }, { id: "asc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.appointment.count({ where }),
      prisma.appointment.groupBy({ by: ["status"], where: accessWhere(actor), _count: { status: true }, orderBy: { status: "asc" } }),
    ]);
    const byStatus = Object.fromEntries(Object.values(AppointmentStatus).map((status) => [status, 0])) as Record<AppointmentStatus, number>;
    for (const group of grouped) {
      const count = typeof group._count === "number"
        ? group._count
        : ((group._count ?? {}) as Record<string, number>).status ?? 0;
      byStatus[group.status] = count;
    }
    const result = {
      data: withAvailableActionsList(data),
      summary: { total: Object.values(byStatus).reduce((sum, count) => sum + count, 0), byStatus },
      pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
    await cacheService.set(key, result, 60);
    return result;
}

export async function calendar(actor: AppointmentActor, query: AppointmentCalendarQuery) {
    await markDueAppointmentsForOutcome(actor);
    const key = calendarKey(actor, query);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const where: Prisma.AppointmentWhereInput = {
      ...accessWhere(actor),
      startTime: rangeFromDates(query.dateFrom, query.dateTo),
      ...(query.status ? { status: query.status } : {}),
      ...(query.serviceId ? { serviceId: query.serviceId } : {}),
      ...assignedStaffFilter(actor, query.assignedStaffId),
    };
    const appointments = await prisma.appointment.findMany({
      where,
      select: {
        id: true,
        title: true,
        status: true,
        source: true,
        startTime: true,
        endTime: true,
        rescheduleCount: true,
        outcomeRequiredAt: true,
        outcomeConfirmedAt: true,
        timezone: true,
        locationType: true,
        locationStatus: true,
        assignedStaffId: true,
        leadId: true,
        conversationId: true,
        serviceId: true,
        lead: { select: { id: true, fullName: true, phone: true } },
        service: { select: { id: true, name: true, durationMinutes: true } },
        assignedStaff: { select: { id: true, user: { select: { firstName: true, lastName: true } } } },
      },
      orderBy: [{ startTime: "asc" }, { id: "asc" }],
    });
    const result = { view: query.view, dateFrom: query.dateFrom, dateTo: query.dateTo, appointments: withAvailableActionsList(appointments) };
    await cacheService.set(key, result, 60);
    return result;
  }

  export async function detail(actor: AppointmentActor, appointmentId: string) {
    await markDueAppointmentsForOutcome(actor, [appointmentId]);
    const key = detailKey(actor, appointmentId);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const appointment = await loadAppointment(actor, appointmentId);
    const activities = await prisma.appointmentActivity.findMany({
      where: { businessId: actor.businessId, appointmentId },
      include: {
        actorUser: { select: { id: true, firstName: true, lastName: true } },
        actorMembership: { select: { id: true, role: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const result = {
      appointment: withAvailableActions(appointment),
      service: appointment.service,
      lead: appointment.lead,
      conversation: appointment.conversation,
      assignedStaff: appointment.assignedStaff,
      activities,
    };
    await cacheService.set(key, result, 120);
    return result;
}

export async function getAppointmentContextForAi(businessId: string, conversationId?: string) {
    const upcoming = await prisma.appointment.findMany({
      where: {
        businessId,
        ...(conversationId ? { conversationId } : {}),
        status: { in: ACTIVE_APPOINTMENT_STATUSES },
        startTime: { gte: new Date() },
      },
      include: appointmentInclude,
      orderBy: { startTime: "asc" },
      take: 20,
    });
    return { businessId, conversationId: conversationId ?? null, upcomingAppointments: upcoming };
  }
