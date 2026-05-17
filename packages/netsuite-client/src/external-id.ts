/**
 * Translate a Shopify GID into a URL-safe NetSuite externalId.
 *
 * Why this exists: the NS REST API's external-id lookup uses the URL path
 * `/{recordType}/eid:{externalId}`. The Shopify GID format
 * `gid://shopify/Order/12345` contains `:` and `/` which are URL-path-
 * structural — NS rejects requests where the OAuth-signed URL string doesn't
 * round-trip cleanly through its URL parser, and the failure surfaces as
 * generic 401 `INVALID_LOGIN` (not 400 / 404), which sent us down a long
 * "auth is broken" diagnostic path. The fix is to never put `:` or `/` in
 * an NS externalId.
 *
 * Transformation:
 *   gid://shopify/Order/12345    →  shopify-order-12345
 *   gid://shopify/Customer/678   →  shopify-customer-678
 *
 * The transformation is:
 *   - Deterministic — same GID always yields same NS externalId, so the
 *     brief's idempotency invariant (one Shopify entity → one NS record)
 *     still holds across redeliveries and instances.
 *   - URL-safe — only `[a-z0-9-]` characters.
 *   - Lossless within Shopify scope — the type + numeric id are preserved.
 *
 * Non-GID externalIds (custom test ids, legacy values) pass through with
 * any URL-unsafe characters replaced by `-` so the gateway never produces
 * an unsafe URL even when the caller passes something hand-crafted.
 *
 * The xref table keeps the ORIGINAL Shopify GID (in `target_external`), so
 * lookups by Shopify-side identifier still work. Only the NS-side string
 * differs.
 */
export function shopifyGidToNsExternalId(externalId: string): string {
  const m = /^gid:\/\/shopify\/([A-Za-z]+)\/(\d+)$/.exec(externalId);
  if (m) {
    return `shopify-${m[1]!.toLowerCase()}-${m[2]}`;
  }
  // Not a recognized Shopify GID — preserve as much as possible but ensure
  // the result is URL-path-safe. Replace any character outside [a-z0-9_-]
  // with `-`. Same input → same output (deterministic).
  return externalId.replace(/[^A-Za-z0-9_-]/g, '-');
}
