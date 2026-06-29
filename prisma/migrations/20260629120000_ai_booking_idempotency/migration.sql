ALTER TABLE "AiInteractionLog"
  ADD COLUMN "bookingIdempotencyKey" TEXT;

CREATE UNIQUE INDEX "AiInteractionLog_bookingIdempotencyKey_key"
  ON "AiInteractionLog"("bookingIdempotencyKey");

CREATE INDEX "AiInteractionLog_bookingIdempotencyKey_idx"
  ON "AiInteractionLog"("bookingIdempotencyKey");
