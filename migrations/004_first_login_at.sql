-- migrations/004_first_login_at.sql
-- Adds first_login_at to users so the 72-Hour Reset clock starts at first
-- login (not at purchase). With this column, Day 2 unlocks at first_login_at
-- + 24h, Day 3 at +48h, and the total window expires at +96h (4 days total).
--
-- Idempotent — safe to run multiple times.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS first_login_at TIMESTAMPTZ NULL;

-- Backfill: for existing entitled members who already logged in once but
-- predate this column, treat their preview_started_at as their first login.
-- This keeps their experience continuous (no surprise lockout) at the cost
-- of those users not getting the 96h window — they keep the original 72h.
-- Future logins will see first_login_at populated and behave normally.
UPDATE users
   SET first_login_at = preview_started_at
 WHERE kajabi_entitled = true
   AND first_login_at IS NULL
   AND preview_started_at IS NOT NULL;
