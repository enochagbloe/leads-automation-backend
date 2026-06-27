import { AuditAction, Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";

export type AuditInput = {
  action: AuditAction;
  businessId?: string | null;
  userId?: string | null;
  actorMembershipId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string;
  userAgent?: string;
};

export const auditService = {
  async log(input: AuditInput) {
    await prisma.auditLog.create({ data: input }).catch((error) => {
      console.error("Audit log write failed", error);
    });
  },
};
