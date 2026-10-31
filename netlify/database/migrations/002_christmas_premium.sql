-- GRIMSON Christmas 2026 PREMIUM photo contest.
-- Separate from christmas_core_entries; does not modify the CORE schema.
CREATE TABLE IF NOT EXISTS christmas_premium_entries (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name VARCHAR(150) NOT NULL,
    email VARCHAR(254) NOT NULL UNIQUE,
    verification_token_hash VARCHAR(64),
    verification_expires_at TIMESTAMPTZ,
    email_verified_at TIMESTAMPTZ,
    newsletter_consent BOOLEAN NOT NULL DEFAULT FALSE,
    photo_storage_key TEXT NOT NULL UNIQUE,
    photo_original_filename VARCHAR(255) NOT NULL,
    photo_mime_type VARCHAR(32) NOT NULL
        CHECK (photo_mime_type IN ('image/jpeg', 'image/png')),
    photo_size_bytes INTEGER NOT NULL
        CHECK (photo_size_bytes > 0 AND photo_size_bytes <= 4194304),
    display_name VARCHAR(150),
    moderation_status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
    moderated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_christmas_premium_verified
    ON christmas_premium_entries (email_verified_at);

CREATE INDEX IF NOT EXISTS idx_christmas_premium_moderation
    ON christmas_premium_entries (moderation_status, created_at);
