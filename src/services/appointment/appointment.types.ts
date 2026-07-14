import { 
  BusinessRole,
  AppointmentSource,
  AppointmentStatus,
  AppointmentLocationStatus,
  AppointmentHumanConfirmationReason
} from "@prisma/client";

import { CreateAppointmentInput } from "../../validation/appointment.schemas";

export type AppointmentActor = {
  userId: string;
  businessAccountId: string;
  businessId: string;
  membershipId: string;
  role: BusinessRole;
};

export type AppointmentAiDecisionContext = {
  confidence?: number | null;
  intent?: string | null;
  reason?: string | null;
  requiresHumanReview?: boolean | null;
  suggestedAction?: string | null;
};

export type InternalCreateAppointmentInput = Omit<CreateAppointmentInput, "source"> & {
  source: AppointmentSource;
  aiDecision?: AppointmentAiDecisionContext | null;
};

export type CreationConfirmation = {
  status: AppointmentStatus;
  locationStatus: AppointmentLocationStatus;
  humanConfirmationRequired: boolean;
  humanConfirmationReason: AppointmentHumanConfirmationReason | null;
};
