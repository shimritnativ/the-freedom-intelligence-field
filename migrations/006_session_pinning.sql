-- migrations/006_session_pinning.sql
-- Adds pinned_at to sessions so Unlimited members can pin chats to the top
-- of their sidebar. NULL means not pinned. The 5-pin limit is enforced at
-- the API layer, not the DB, so an admin override or future expansion stays
-- flexible.
--
-- Sort order for the sidebar becomes:
--   1. Pinned (most recently pinned first)
--   2. Unpinned (most recently active first)
--
-- Idempotent — safe to run multiple times.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ NULL;

-- Index speeds up the "list pinned first" query in the sidebar.
CREATE INDEX IF NOT EXISTS idx_sessions_user_pinned
  ON sessions(user_id, session_type, pinned_at DESC NULLS LAST, last_message_at DESC NULLS LAST);

COMMENT ON COLUMN sessions.pinned_at IS
  'When the user pinned this chat. NULL = not pinned. Pinned chats sort above unpinned in the sidebar list.';
