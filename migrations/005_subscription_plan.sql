-- 005_subscription_plan.sql
-- Add subscription_plan column to users so the Your Account modal can show
-- "Monthly · Active" vs "Yearly · Active" with the right CTAs.
--
-- Values: 'monthly', 'yearly', or NULL (unknown — fallback UI assumes monthly
-- to avoid breaking existing users until the next webhook fires for them).
--
-- Populated by /api/webhooks/kajabi when the activation URL includes
-- &plan=monthly or &plan=yearly. Backfilled lazily as customers renew or
-- as new yearly purchases come through.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS subscription_plan TEXT
    CHECK (subscription_plan IN ('monthly', 'yearly') OR subscription_plan IS NULL);

COMMENT ON COLUMN users.subscription_plan IS
  'monthly | yearly | NULL. Drives the Your Account modal UI for full-tier members.';
