-- Rollback for the separately reviewed sync reconciliation DBA bootstrap.
-- Run as a DBA role in disposable rehearsal or production maintenance, not from application migrations.

RESET ROLE;

DROP TRIGGER IF EXISTS gbrain_guard_sync_reconciliation_audit_update ON sync_reconciliation_audit;
DROP TRIGGER IF EXISTS gbrain_guard_sources_generation_update ON sources;

DO $$
DECLARE
  bootstrap_role text;
  membership record;
BEGIN
  FOREACH bootstrap_role IN ARRAY ARRAY[
    'gbrain_hard_purge',
    'gbrain_source_repair',
    'gbrain_reconciliation_apply',
    'gbrain_reconciliation_approve',
    'gbrain_normal_sync',
    'gbrain_reconciliation_owner'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = bootstrap_role) THEN
      FOR membership IN
        SELECT pg_get_userbyid(roleid) AS granted_role, pg_get_userbyid(member) AS member_role
        FROM pg_auth_members
        WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = bootstrap_role)
           OR member = (SELECT oid FROM pg_roles WHERE rolname = bootstrap_role)
      LOOP
        EXECUTE format('REVOKE %I FROM %I', membership.granted_role, membership.member_role);
      END LOOP;
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regclass('public.sources') IS NOT NULL THEN
    ALTER TABLE public.sources OWNER TO CURRENT_USER;
  END IF;
  IF to_regclass('public.sync_reconciliation_audit') IS NOT NULL THEN
    ALTER TABLE public.sync_reconciliation_audit OWNER TO CURRENT_USER;
  END IF;
  IF to_regclass('public.sync_reconciliation_role_policy') IS NOT NULL THEN
    ALTER TABLE public.sync_reconciliation_role_policy OWNER TO CURRENT_USER;
  END IF;
  IF to_regprocedure('public.gbrain_guard_sync_reconciliation_audit_update()') IS NOT NULL THEN
    ALTER FUNCTION public.gbrain_guard_sync_reconciliation_audit_update() OWNER TO CURRENT_USER;
  END IF;
  IF to_regprocedure('public.gbrain_guard_sources_generation_update()') IS NOT NULL THEN
    ALTER FUNCTION public.gbrain_guard_sources_generation_update() OWNER TO CURRENT_USER;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.gbrain_guard_sync_reconciliation_audit_update();
DROP FUNCTION IF EXISTS public.gbrain_guard_sources_generation_update();

DELETE FROM public.sync_reconciliation_role_policy
WHERE role_name IN (
  'gbrain_normal_sync',
  'gbrain_reconciliation_approve',
  'gbrain_reconciliation_apply',
  'gbrain_source_repair',
  'gbrain_hard_purge'
);

DO $$
DECLARE
  bootstrap_role text;
BEGIN
  FOREACH bootstrap_role IN ARRAY ARRAY[
    'gbrain_hard_purge',
    'gbrain_source_repair',
    'gbrain_reconciliation_apply',
    'gbrain_reconciliation_approve',
    'gbrain_normal_sync',
    'gbrain_reconciliation_owner'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = bootstrap_role) THEN
      EXECUTE format('DROP OWNED BY %I', bootstrap_role);
    END IF;
  END LOOP;
END $$;

DROP ROLE IF EXISTS gbrain_hard_purge;
DROP ROLE IF EXISTS gbrain_source_repair;
DROP ROLE IF EXISTS gbrain_reconciliation_apply;
DROP ROLE IF EXISTS gbrain_reconciliation_approve;
DROP ROLE IF EXISTS gbrain_normal_sync;
DROP ROLE IF EXISTS gbrain_reconciliation_owner;
