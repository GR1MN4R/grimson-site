-- Run once against the same GRIMSON_DATABASE_URL as the deployed functions.
BEGIN;
ALTER TABLE christmas_premium_entries DROP CONSTRAINT IF EXISTS christmas_premium_entries_moderation_status_check;
ALTER TABLE christmas_premium_entries ADD CONSTRAINT christmas_premium_entries_moderation_status_check
  CHECK (moderation_status IN ('pending','approved','rejected','banned'));
CREATE TABLE IF NOT EXISTS christmas_premium_moderation_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id BIGINT NOT NULL REFERENCES christmas_premium_entries(id),
  action VARCHAR(12) NOT NULL CHECK (action IN ('approve','reject','ban','undo')),
  previous_status VARCHAR(20) NOT NULL,
  new_status VARCHAR(20) NOT NULL,
  reason TEXT,
  admin_email VARCHAR(254) NOT NULL,
  request_id UUID NOT NULL UNIQUE,
  notification_status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (notification_status IN ('pending','sending','sent','failed')),
  notification_error TEXT,
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_premium_moderation_events_entry ON christmas_premium_moderation_events(entry_id,id DESC);
COMMIT;
