-- The change feed (todo/change-feed-model.md, approved 2026-10-09): what changed, per record, in a
-- numbered list that clients catch up from, by asking (GET /v1/changes) or by push (SSE). Written in
-- the same transaction as the change; numbered under an advisory lock just before commit, so version
-- order is commit order and a client never skips one. Kept forever (decision 3): no 410.

CREATE SEQUENCE changes_version_seq;
CREATE TABLE changes (
  version BIGINT PRIMARY KEY,               -- nextval('changes_version_seq'), under the lock
  kind TEXT NOT NULL CHECK (kind IN ('booking', 'seat_lock', 'deployment', 'route')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
  route_days JSONB,                         -- [{route_id, service_date}] whose seats this touched, before and after
  changed_by TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX changes_entity_idx ON changes (kind, entity_id);
