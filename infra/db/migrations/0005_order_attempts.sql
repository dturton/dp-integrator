-- 0005_order_attempts.sql  (PostgreSQL)
-- Per-Service-Bus-delivery audit trail for the order-import pipeline.
--
-- entity_xref answers "did we sync this order?" (dedup).
-- order_sync_log answers "what was the terminal outcome?" (one row per order).
-- order_attempt answers "WHEN did each delivery fire, what happened, and
-- what payload went out?" (one row per SB delivery, including short-circuits
-- like already_synced / already_claimed so the timeline explains every
-- redelivery — not just the meaningful ones).
--
-- Indexed for the two read patterns the future admin UI needs:
--   1. Detail view: full timeline for a single order (lookup index).
--   2. Recent activity feed: latest attempts across a connection (recent index).
--
-- Append-only. Each row carries blob URIs (inbound envelope + outbound NS
-- payload) so the UI can fetch raw payloads on demand without a JOIN. The
-- payload_digest JSONB is a small inline preview (tranId, externalId, line
-- count, total) for fast list/detail rendering without a blob fetch.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS order_attempt (
  id                          BIGSERIAL    PRIMARY KEY,
  environment                 VARCHAR(16)  NOT NULL CHECK (environment IN ('dev','sandbox','prod')),
  connection_id               VARCHAR(64)  NOT NULL,
  shopify_order_gid           VARCHAR(128) NOT NULL,

  -- Service Bus context
  delivery_count              INTEGER      NOT NULL,             -- context.triggerMetadata.deliveryCount (1..maxDeliveryCount)
  sb_message_id               VARCHAR(128) NULL,
  sb_session_id               VARCHAR(128) NULL,

  -- Outcome of this attempt. Mirrors OrderHandlerOutcome.kind plus the two
  -- throw-after-record paths (transient/auth — neither writes a permanent
  -- error_records row, but they DO get an attempt row so the timeline shows
  -- "delivery 3 threw transient, delivery 4 succeeded").
  outcome                     VARCHAR(32)  NOT NULL CHECK (outcome IN (
                                'imported','parked','ignored_by_eligibility',
                                'already_synced','already_claimed','ignored',
                                'rejected','transient_throw','auth_throw','quarantined'
                              )),
  stage                       VARCHAR(32)  NULL,                 -- park stage (fetch/mapping/balancing/item_resolution/external_call)
  error_class                 VARCHAR(32)  NULL,                 -- ErrorClass when outcome is parked / *_throw / quarantined
  detail                      TEXT         NULL,                 -- truncated error message / park detail

  -- Payload breadcrumbs
  inbound_envelope_uri        TEXT         NULL,                 -- mirrored from the SB message's envelopeBlobUri
  outbound_payload_uri        TEXT         NULL,                 -- new outbound-netsuite blob URI; NULL when pipeline parked pre-NS or blob put swallowed
  payload_digest              JSONB        NULL,                 -- {tranId, externalId, subsidiaryId, entityId, currencyId, lineCount, total, orderStatus}

  -- Timing (the gap between started_at and finished_at is the wall-clock
  -- duration of this delivery's handler invocation — useful for spotting
  -- slow NS / Shopify calls in retries).
  started_at                  TIMESTAMPTZ  NOT NULL,
  finished_at                 TIMESTAMPTZ  NOT NULL,
  duration_ms                 INTEGER      NOT NULL,

  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Timeline for one order: ORDER BY delivery_count DESC reads top-down,
-- the leftmost columns let the planner index-scan straight to the rows.
CREATE INDEX IF NOT EXISTS ix_order_attempt_lookup
  ON order_attempt(environment, connection_id, shopify_order_gid, delivery_count DESC);

-- Recent activity feed for `dpi attempts --recent` and the future UI list.
CREATE INDEX IF NOT EXISTS ix_order_attempt_recent
  ON order_attempt(environment, connection_id, finished_at DESC);

-- Denormalize per-attempt totals + last-attempt URIs onto order_sync_log so
-- the list view ("ORDER #1234 — imported, tried 3x") doesn't need a JOIN.
-- attempt_count is the SB-authoritative deliveryCount of the most recent
-- attempt (always >= 1 once any row lands; 0 stays for unsynced rows).
ALTER TABLE order_sync_log
  ADD COLUMN IF NOT EXISTS attempt_count             INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_delivery_count       INTEGER NULL,
  ADD COLUMN IF NOT EXISTS last_outbound_payload_uri TEXT    NULL,
  ADD COLUMN IF NOT EXISTS last_inbound_envelope_uri TEXT    NULL;
