# migration/ — PLACEHOLDER

Celigo → dp-integrator backfill + cutover tooling.

**Not in v1 scope.** This directory exists in the repo so the brief's invariant
(*"`entity_xref` must be backfill-safe — keyed on source IDs and carrying NS
`externalId`"*) has a place to land later.

When this gets built (post-v1):
- Backfill `entity_xref` rows from existing Celigo state + NS records, matching
  on NS `externalId` where set; otherwise reconciling by order number + date +
  total.
- Parallel / shadow run: map + diff against Celigo output without writing.
- Per-connection cutover: freeze Celigo flow → drain in-flight → flip to dp-integrator → watch reconciliation sweep for N days.
- Per-connection rollback path back to Celigo (xref stays valid — keyed on source IDs).

Do not implement in v1.
