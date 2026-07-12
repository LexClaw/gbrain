-- Separately reviewed DBA bootstrap for sync reconciliation roles.
-- Run as a DBA role in disposable rehearsal or production maintenance, not from application migrations.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_reconciliation_owner') THEN
    CREATE ROLE gbrain_reconciliation_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_normal_sync') THEN
    CREATE ROLE gbrain_normal_sync NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_reconciliation_approve') THEN
    CREATE ROLE gbrain_reconciliation_approve NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_reconciliation_apply') THEN
    CREATE ROLE gbrain_reconciliation_apply NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_source_repair') THEN
    CREATE ROLE gbrain_source_repair NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_hard_purge') THEN
    CREATE ROLE gbrain_hard_purge NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO gbrain_normal_sync, gbrain_reconciliation_approve, gbrain_reconciliation_apply, gbrain_source_repair, gbrain_hard_purge;

ALTER TABLE sources OWNER TO gbrain_reconciliation_owner;
ALTER TABLE sync_reconciliation_audit OWNER TO gbrain_reconciliation_owner;
ALTER TABLE sync_reconciliation_role_policy OWNER TO gbrain_reconciliation_owner;

REVOKE ALL PRIVILEGES ON pages, content_chunks, ingest_log, sources, sync_reconciliation_audit, sync_reconciliation_role_policy
  FROM PUBLIC, gbrain_normal_sync, gbrain_reconciliation_approve, gbrain_reconciliation_apply, gbrain_source_repair, gbrain_hard_purge;

GRANT SELECT, INSERT ON pages, content_chunks, ingest_log TO gbrain_normal_sync;
GRANT UPDATE (slug, type, page_kind, title, compiled_truth, frontmatter, timeline, raw_path, source_path, content_hash, embedding, embedding_voyage, embedding_model, embedding_dimensions, updated_at, effective_date, contextual_retrieval_mode, corpus_generation, generation)
  ON pages TO gbrain_normal_sync;
GRANT SELECT ON sources TO gbrain_normal_sync;
GRANT UPDATE (last_commit, last_sync_at, newest_content_at, chunker_version) ON sources TO gbrain_normal_sync;
GRANT SELECT, INSERT ON sync_reconciliation_audit TO gbrain_normal_sync;
GRANT SELECT ON sync_reconciliation_role_policy TO gbrain_normal_sync;

GRANT SELECT ON sync_reconciliation_audit, sync_reconciliation_role_policy TO gbrain_reconciliation_approve;
GRANT UPDATE (authorized, after_state, result) ON sync_reconciliation_audit TO gbrain_reconciliation_approve;

GRANT SELECT ON pages, sources, sync_reconciliation_audit, sync_reconciliation_role_policy TO gbrain_reconciliation_apply;
GRANT UPDATE (deleted_at, updated_at) ON pages TO gbrain_reconciliation_apply;
GRANT UPDATE (after_state, result, failure, completed_at, apply_attempt, applying_claimed_at) ON sync_reconciliation_audit TO gbrain_reconciliation_apply;

GRANT SELECT ON sources, sync_reconciliation_role_policy TO gbrain_source_repair;
GRANT UPDATE (local_path, registration_generation) ON sources TO gbrain_source_repair;

GRANT SELECT ON pages, sync_reconciliation_audit, sync_reconciliation_role_policy TO gbrain_hard_purge;
GRANT DELETE ON pages TO gbrain_hard_purge;
GRANT UPDATE (after_state, result, completed_at) ON sync_reconciliation_audit TO gbrain_hard_purge;

CREATE OR REPLACE FUNCTION public.gbrain_guard_sync_reconciliation_audit_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user = 'gbrain_reconciliation_approve' THEN
    IF OLD.result = 'proposed' AND NEW.result = 'approved' AND NEW.authorized IS TRUE THEN
      RETURN NEW;
    END IF;
  ELSIF current_user = 'gbrain_reconciliation_apply' THEN
    IF OLD.result IN ('approved', 'failed') AND NEW.result = 'applying' AND OLD.authorized IS TRUE AND NEW.authorized IS TRUE THEN
      RETURN NEW;
    END IF;
    IF OLD.result = 'applying' AND NEW.result IN ('applied', 'failed') AND NEW.authorized = OLD.authorized THEN
      RETURN NEW;
    END IF;
  ELSIF current_user = 'gbrain_hard_purge' THEN
    IF NEW.authorized = OLD.authorized AND ((OLD.result = 'applied' AND NEW.result = 'purging') OR (OLD.result = 'purging' AND NEW.result = 'purged')) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'sync reconciliation transition % -> % is not allowed for %', OLD.result, NEW.result, current_user USING ERRCODE = '42501';
END;
$$;

CREATE OR REPLACE FUNCTION public.gbrain_guard_sources_generation_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.local_path IS DISTINCT FROM NEW.local_path THEN
    IF NEW.registration_generation <= OLD.registration_generation THEN
      RAISE EXCEPTION 'sources.local_path changes must increment registration_generation' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.gbrain_guard_sync_reconciliation_audit_update() OWNER TO gbrain_reconciliation_owner;
ALTER FUNCTION public.gbrain_guard_sources_generation_update() OWNER TO gbrain_reconciliation_owner;

DROP TRIGGER IF EXISTS gbrain_guard_sync_reconciliation_audit_update ON sync_reconciliation_audit;
CREATE TRIGGER gbrain_guard_sync_reconciliation_audit_update
BEFORE UPDATE ON sync_reconciliation_audit
FOR EACH ROW EXECUTE FUNCTION public.gbrain_guard_sync_reconciliation_audit_update();

DROP TRIGGER IF EXISTS gbrain_guard_sources_generation_update ON sources;
CREATE TRIGGER gbrain_guard_sources_generation_update
BEFORE UPDATE OF local_path, registration_generation ON sources
FOR EACH ROW EXECUTE FUNCTION public.gbrain_guard_sources_generation_update();

REVOKE ALL ON FUNCTION public.gbrain_guard_sync_reconciliation_audit_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gbrain_guard_sources_generation_update() FROM PUBLIC;
