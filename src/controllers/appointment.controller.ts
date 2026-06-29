import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { appointmentService } from "../services/appointment.service";
import { requestMetadata } from "../utils/request";
import { AppointmentCalendarQuery, AppointmentListQuery } from "../validation/appointment.schemas";

function actor(req: Request) {
  return {
    userId: req.auth!.userId,
    businessAccountId: req.auth!.businessAccountId!,
    businessId: req.auth!.businessId!,
    membershipId: req.auth!.membershipId!,
    role: req.auth!.role as BusinessRole,
  };
}

function appointmentId(req: Request) {
  const value = req.params.appointmentId ?? req.params.id;
  return Array.isArray(value) ? value[0]! : value!;
}

export const appointmentController = {
  list: async (req, res) => res.json(await appointmentService.list(actor(req), res.locals.validatedQuery as AppointmentListQuery)),
  calendar: async (req, res) => res.json(await appointmentService.calendar(actor(req), res.locals.validatedQuery as AppointmentCalendarQuery)),
  getAutoConfirmSettings: async (req, res) => res.json(await appointmentService.getAutoConfirmSettings(actor(req))),
  updateAutoConfirmSettings: async (req, res) => res.json(await appointmentService.updateAutoConfirmSettings(actor(req), req.body, requestMetadata(req))),
  updateSettings: async (req, res) => res.json(await appointmentService.updateSettings(actor(req), req.body, requestMetadata(req))),
  checkAvailability: async (req, res) => res.json(await appointmentService.checkAvailability(actor(req), req.body)),
  create: async (req, res) => res.status(201).json(await appointmentService.create(actor(req), req.body, requestMetadata(req))),
  detail: async (req, res) => res.json(await appointmentService.detail(actor(req), appointmentId(req))),
  reschedule: async (req, res) => res.json(await appointmentService.reschedule(actor(req), appointmentId(req), req.body, requestMetadata(req))),
  cancel: async (req, res) => res.json(await appointmentService.cancel(actor(req), appointmentId(req), req.body.reason, requestMetadata(req))),
  confirm: async (req, res) => res.json(await appointmentService.confirm(actor(req), appointmentId(req), req.body.note, requestMetadata(req))),
  complete: async (req, res) => res.json(await appointmentService.complete(actor(req), appointmentId(req), req.body.completedNote, requestMetadata(req))),
  noShow: async (req, res) => res.json(await appointmentService.noShow(actor(req), appointmentId(req), req.body.noShowReason, requestMetadata(req))),
  missed: async (req, res) => res.json(await appointmentService.missed(actor(req), appointmentId(req), req.body.missedReason, requestMetadata(req))),
  assign: async (req, res) => res.json(await appointmentService.assign(actor(req), appointmentId(req), req.body.assignedStaffId, requestMetadata(req))),
  claim: async (req, res) => res.json(await appointmentService.claim(actor(req), appointmentId(req), requestMetadata(req))),
} satisfies Record<string, RequestHandler>;
