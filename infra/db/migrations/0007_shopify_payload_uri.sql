-- 0007_shopify_payload_uri.sql  (PostgreSQL)
-- Capture the authoritative Shopify order body the handler re-fetched via
-- Admin GraphQL right after picking up the SB message. Distinct from the
-- webhook envelope (inbound_envelope_uri) — the webhook is a small
-- notification with HMAC + a tiny JSON body; the Shopify-order fetch is
-- the full order (lines, customer, addresses, totals) and is the *input*
-- to mapping/balancing/item-resolution.
--
-- Stored in the existing outbound-netsuite blob container at a parallel
-- path with a `-shopify.json` suffix. Populated whenever the handler
-- successfully ran getOrder; NULL on short-circuit paths
-- (already_synced / already_claimed / ignored) and on the auth/transient
-- throw paths where getOrder itself failed.
--
-- Idempotent. Apply via psql per the existing manual pattern.

ALTER TABLE order_attempt
  ADD COLUMN IF NOT EXISTS shopify_payload_uri TEXT NULL;
