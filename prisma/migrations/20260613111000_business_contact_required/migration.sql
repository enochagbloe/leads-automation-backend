ALTER TABLE "Business"
  ADD CONSTRAINT "Business_contact_required"
  CHECK (
    NULLIF(BTRIM("email"), '') IS NOT NULL
    OR NULLIF(BTRIM("phone"), '') IS NOT NULL
  );
