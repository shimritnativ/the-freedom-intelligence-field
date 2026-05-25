-- migrations/002_unlimited_sessions.sql
-- Extends the sessions table for the Freedom Intelligence Field Unlimited.
-- The Reset used one session per user; Unlimited allows many.
-- This migration is additive and safe to re-run.

-- session_type distinguishes Reset chats from Unlimited chats.
-- Default 'reset' keeps existing rows valid without backfill.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS session_type TEXT NOT NULL DEFAULT 'reset';

-- metadata holds open-ended session info like topic tags, generated summaries,
-- "first message" used for title generation, etc.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Index for fast retrieval of a user's session list, ordered by recency.
-- Used heavily by the sidebar chat-list in unlimited.html.
CREATE INDEX IF NOT EXISTS idx_sessions_user_type_recent
  ON sessions(user_id, session_type, last_message_at DESC);

-- Quick verification: returns the column list of sessions.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'sessions'
ORDER BY ordinal_position;
