import { Prisma,   BusinessRole } from "@prisma/client";
import { prisma } from "../../config/prisma";


export type FollowUpActor = {
  userId: string;
  businessAccountId: string;
  businessId: string;
  membershipId: string;
  role: BusinessRole;
};

export type FollowUpDb = typeof prisma | Prisma.TransactionClient;

export type FollowUpContextEvaluationResult = {
  jobId: string;
  doesReplyAddressPendingContext: boolean;
  pendingContextResolved: boolean;
  replyIntent: string;
  extractedFields: {
    email?: string;
    location?: string;
    date?: string;
    time?: string;
    service?: string;
    paymentIntent?: boolean;
    quoteAccepted?: boolean;
  };
  action: "CANCEL_FOLLOW_UP" | "KEEP_FOLLOW_UP";
  reason: string;
};


