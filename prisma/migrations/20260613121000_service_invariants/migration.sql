ALTER TABLE "Service"
  ADD CONSTRAINT "Service_name_not_blank" CHECK (NULLIF(BTRIM("name"), '') IS NOT NULL),
  ADD CONSTRAINT "Service_currency_valid_length" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "Service_displayOrder_nonnegative" CHECK ("displayOrder" >= 0),
  ADD CONSTRAINT "Service_archived_inactive" CHECK (NOT "isArchived" OR NOT "isActive");
