-- migrate:up

-- =========================================================================
-- The phones the operator signed in on, for push notifications. A token is
-- FCM's name for one app install, so it is the key: signing in again from the
-- same phone updates a row rather than adding one.
-- =========================================================================

CREATE TABLE wilson.push_devices (
    token TEXT PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES wilson.accounts (id) ON DELETE CASCADE,
    label TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- migrate:down

DROP TABLE wilson.push_devices;
