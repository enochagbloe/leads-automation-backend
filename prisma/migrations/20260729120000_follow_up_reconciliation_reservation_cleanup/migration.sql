UPDATE "FollowUpSendLog" AS queued
SET
  "deliveryStatus" = 'FAILED',
  "failureReason" = 'DUPLICATE_RESERVATION_RECONCILED'
WHERE queued."deliveryStatus" = 'QUEUED'
  AND EXISTS (
    SELECT 1
    FROM "FollowUpSendLog" AS sent
    WHERE sent."businessId" = queued."businessId"
      AND sent."jobId" = queued."jobId"
      AND sent."deliveryStatus" = 'SENT'
  );
