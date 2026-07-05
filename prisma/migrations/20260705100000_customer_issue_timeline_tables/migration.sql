-- CreateEnum
CREATE TYPE "CustomerIssueTimelineEventType" AS ENUM (
  'CREATED_FROM_CUSTOMER_MESSAGE',
  'MATCHED_FOLLOW_UP',
  'REOPENED_BY_CUSTOMER_MESSAGE',
  'STATUS_CHANGED',
  'RESOLUTION_MESSAGE_SENT',
  'INTERNAL_NOTE'
);

-- CreateEnum
CREATE TYPE "CustomerIssueMessageRelationType" AS ENUM (
  'CREATED_FROM',
  'MATCHED_FOLLOW_UP',
  'REOPENED_BY'
);

-- CreateTable
CREATE TABLE "CustomerIssueTimelineEvent" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "issueId" TEXT NOT NULL,
  "messageId" TEXT,
  "actorMembershipId" TEXT,
  "type" "CustomerIssueTimelineEventType" NOT NULL,
  "summary" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CustomerIssueTimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerIssueMessage" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "issueId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "relationType" "CustomerIssueMessageRelationType" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CustomerIssueMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerIssueTimelineEvent_businessId_issueId_createdAt_idx" ON "CustomerIssueTimelineEvent"("businessId", "issueId", "createdAt");

-- CreateIndex
CREATE INDEX "CustomerIssueTimelineEvent_businessId_type_createdAt_idx" ON "CustomerIssueTimelineEvent"("businessId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "CustomerIssueTimelineEvent_messageId_idx" ON "CustomerIssueTimelineEvent"("messageId");

-- CreateIndex
CREATE INDEX "CustomerIssueTimelineEvent_actorMembershipId_idx" ON "CustomerIssueTimelineEvent"("actorMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerIssueMessage_issueId_messageId_relationType_key" ON "CustomerIssueMessage"("issueId", "messageId", "relationType");

-- CreateIndex
CREATE INDEX "CustomerIssueMessage_businessId_issueId_createdAt_idx" ON "CustomerIssueMessage"("businessId", "issueId", "createdAt");

-- CreateIndex
CREATE INDEX "CustomerIssueMessage_businessId_messageId_idx" ON "CustomerIssueMessage"("businessId", "messageId");

-- CreateIndex
CREATE INDEX "CustomerIssueMessage_relationType_idx" ON "CustomerIssueMessage"("relationType");

-- AddForeignKey
ALTER TABLE "CustomerIssueTimelineEvent" ADD CONSTRAINT "CustomerIssueTimelineEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerIssueTimelineEvent" ADD CONSTRAINT "CustomerIssueTimelineEvent_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "CustomerIssueLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerIssueTimelineEvent" ADD CONSTRAINT "CustomerIssueTimelineEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerIssueTimelineEvent" ADD CONSTRAINT "CustomerIssueTimelineEvent_actorMembershipId_fkey" FOREIGN KEY ("actorMembershipId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerIssueMessage" ADD CONSTRAINT "CustomerIssueMessage_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerIssueMessage" ADD CONSTRAINT "CustomerIssueMessage_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "CustomerIssueLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerIssueMessage" ADD CONSTRAINT "CustomerIssueMessage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
