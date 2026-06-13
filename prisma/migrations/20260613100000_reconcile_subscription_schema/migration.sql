ALTER TABLE "Plan"
  ALTER COLUMN "maxConversationsPerMonth" DROP NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Subscription_new_pkey'
      AND conrelid = '"Subscription"'::regclass
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Subscription_pkey'
      AND conrelid = '"Subscription"'::regclass
  ) THEN
    ALTER TABLE "Subscription"
      RENAME CONSTRAINT "Subscription_new_pkey" TO "Subscription_pkey";
  END IF;
END
$$;
