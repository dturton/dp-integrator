-- 0003_governor_slots.sql  (PostgreSQL)
-- Backing table for the future SqlGovernorBackingStore (brief §12, invariant 5).
--
-- Each row = one in-flight slot on an NS account. Acquired with INSERT inside a
-- transaction that asserts (count < ceiling) under SELECT … FOR UPDATE; released
-- with DELETE WHERE holder_id = $1. The M1/M2 SQL governor impl owns the exact
-- function; this migration is DDL only.

CREATE TABLE IF NOT EXISTS ns_governor_slots (
  ns_account_id  VARCHAR(64) NOT NULL,
  holder_id      VARCHAR(64) NOT NULL,
  acquired_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Heartbeat for stuck-slot reaping. Bumped by the holder every N seconds.
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_ns_governor_slots PRIMARY KEY (ns_account_id, holder_id)
);

CREATE INDEX IF NOT EXISTS ix_ns_governor_slots_account
  ON ns_governor_slots(ns_account_id, acquired_at);

/*
-- Reference shape for the future SQL governor acquire function (added in M1/M2
-- alongside the real SqlGovernorBackingStore). Left commented so this migration
-- stays DDL-only.
--
-- CREATE OR REPLACE FUNCTION governor_try_acquire(
--   p_ns_account_id VARCHAR(64),
--   p_holder_id     VARCHAR(64),
--   p_ceiling       INTEGER
-- ) RETURNS BOOLEAN AS $$
-- DECLARE
--   acquired BOOLEAN := FALSE;
-- BEGIN
--   PERFORM 1
--     FROM ns_governor_slots
--    WHERE ns_account_id = p_ns_account_id
--      FOR UPDATE;
--   IF (SELECT COUNT(*) FROM ns_governor_slots
--         WHERE ns_account_id = p_ns_account_id) < p_ceiling THEN
--     INSERT INTO ns_governor_slots(ns_account_id, holder_id)
--          VALUES (p_ns_account_id, p_holder_id);
--     acquired := TRUE;
--   END IF;
--   RETURN acquired;
-- END;
-- $$ LANGUAGE plpgsql;
*/
