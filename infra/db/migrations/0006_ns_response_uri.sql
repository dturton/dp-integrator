-- 0006_ns_response_uri.sql  (PostgreSQL)
-- Capture the raw NetSuite response per attempt so the admin UI can show it.
--
-- ns_response_uri    — blob URI in the existing outbound-netsuite container
--                      (parallel path with a `-response.json` suffix). NULL
--                      when NS was never called (pre-NS park) or the throw
--                      was a network error with no body (transient_throw on
--                      timeout/auth).
-- ns_response_status — HTTP status NS returned (204, 400, 422, ...). Saves
--                      the UI from fetching the blob just to color the
--                      success/error badge.
-- last_ns_response_uri (order_sync_log) — denormalized URI of the most-recent
--                      attempt's NS response, parallel to the existing
--                      last_outbound_payload_uri column so the list view can
--                      link without joining.
--
-- Idempotent. Apply via psql per the existing manual pattern; CI migration
-- automation is tracked separately.

ALTER TABLE order_attempt
  ADD COLUMN IF NOT EXISTS ns_response_uri    TEXT    NULL,
  ADD COLUMN IF NOT EXISTS ns_response_status INTEGER NULL;

ALTER TABLE order_sync_log
  ADD COLUMN IF NOT EXISTS last_ns_response_uri TEXT NULL;
