-- GBrain isolated content recovery pre-rehearsal schema
-- Version: recovery_v3_pre_rehearsal_1
-- This migration is intentionally standalone. Apply only to disposable isolated rehearsal databases.
-- Apply path: gbrain recovery schema-provision --yes, then verify with gbrain recovery schema-status.
-- Rollback path for rehearsal DBs only:
--   DROP INDEX IF EXISTS recovery_active_pages_source_slug_guard;
--   DROP TABLE IF EXISTS recovery_apply_state;
--   DROP TABLE IF EXISTS recovery_audit_rows;
--   DROP TABLE IF EXISTS recovery_audit_batches;
--   DROP TABLE IF EXISTS recovery_schema_version;

CREATE TABLE IF NOT EXISTS recovery_schema_version (
  version TEXT PRIMARY KEY,
  migration_sha256 TEXT NOT NULL DEFAULT repeat('0', 64) CHECK (migration_sha256 ~ '^[a-f0-9]{64}$'),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recovery_target_identity (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  nonce TEXT NOT NULL CHECK (nonce ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO recovery_target_identity (id, nonce)
VALUES (true, lower(md5(now()::text || random()::text) || md5(random()::text || now()::text)))
ON CONFLICT (id) DO NOTHING;

INSERT INTO recovery_schema_version (version)
VALUES ('recovery_v3_pre_rehearsal_1')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS recovery_audit_batches (
  run_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  payload_bundle_hash TEXT NOT NULL CHECK (payload_bundle_hash ~ '^[a-f0-9]{64}$'),
  approval_hash TEXT NOT NULL CHECK (approval_hash ~ '^[a-f0-9]{64}$'),
  tool_commit TEXT NOT NULL,
  target_identity TEXT NOT NULL,
  allowlist_hash TEXT NOT NULL CHECK (allowlist_hash ~ '^[a-f0-9]{64}$'),
  batch_hash TEXT NOT NULL CHECK (batch_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id, batch_id)
);

CREATE TABLE IF NOT EXISTS recovery_audit_rows (
  id SERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  row_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('add_exact','merge_exact')),
  canonical_manifest_row JSONB NOT NULL,
  before_image JSONB NOT NULL,
  after_image JSONB NOT NULL,
  cas_predicate JSONB NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  approval_hash TEXT NOT NULL CHECK (approval_hash ~ '^[a-f0-9]{64}$'),
  row_hash TEXT NOT NULL CHECK (row_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(run_id, batch_id, row_key)
);

CREATE TABLE IF NOT EXISTS recovery_apply_state (
  run_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  row_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('committed','rolled_back')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id, batch_id, row_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS recovery_active_pages_source_slug_guard
  ON pages(source_id, slug)
  WHERE deleted_at IS NULL;
