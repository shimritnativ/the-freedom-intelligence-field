-- migrations/003_login_codes.sql
-- Passwordless email login: one-time 6-digit codes, plus an explicit
-- entitlement flag on users so the login can tell a real Kajabi member apart
-- from an anonymous demo account.
-- Idempotent: safe to re-run.

-- Explicit "this user is a genuine Kajabi member who may log in" flag.
-- Set true by the Kajabi offer webhook; false on deactivation/refund.
-- Anonymous demo accounts keep the default (false) and cannot log in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS kajabi_entitled boolean NOT NULL DEFAULT false;

-- One-time login codes. A row is created per request-code call; the code
-- itself is stored only as a SHA-256 hash.
CREATE TABLE IF NOT EXISTS login_codes (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         citext NOT NULL,
  code_hash     text NOT NULL,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  attempts      smallint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_codes_email_created
  ON login_codes (email, created_at DESC);
