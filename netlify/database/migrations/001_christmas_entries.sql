CREATE TABLE IF NOT EXISTS christmas_core_entries (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name VARCHAR(150) NOT NULL,
    email VARCHAR(254) NOT NULL UNIQUE,
    verification_token_hash VARCHAR(64),
    verification_expires_at TIMESTAMPTZ,
    email_verified_at TIMESTAMPTZ,
    newsletter_consent BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_christmas_core_verified
ON christmas_core_entries (email_verified_at);
