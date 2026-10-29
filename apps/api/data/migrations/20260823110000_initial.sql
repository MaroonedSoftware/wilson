-- migrate:up

-- =========================================================================
-- What every later migration assumes: the runtime role, its grants, the
-- `runner` schema, and the updated_at trigger.
--
-- app_user is the role the API is meant to run as, so the process that
-- serves requests cannot change the schema or read past its grants. dbmate
-- keeps connecting as the owning superuser. NOSUPERUSER / NOBYPASSRLS so it
-- is bound by whatever row-level security a later table adds.
--
-- Created in a guard because roles belong to the whole cluster, not one
-- database: the dev and test databases can share a server, and a plain
-- CREATE ROLE would fail on the second. It is created NOLOGIN; LOGIN and a
-- password are set per environment, never committed here.
--
-- The default privileges have no IN SCHEMA and are set before any schema or
-- table exists, so every table, sequence and schema this and every later
-- migration creates grants to app_user with no per-table step.
-- =========================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user NOLOGIN NOSUPERUSER NOINHERIT NOBYPASSRLS;
    END IF;
END $$;

ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES GRANT USAGE, SELECT ON SEQUENCES TO app_user;
ALTER DEFAULT PRIVILEGES GRANT USAGE ON SCHEMAS TO app_user;

-- public exists before any migration runs, so the schema default above
-- misses it.
GRANT USAGE ON SCHEMA public TO app_user;

CREATE SCHEMA IF NOT EXISTS runner;

-- =========================================================================
-- runner.set_updated_at(): a BEFORE UPDATE trigger that moves updated_at to
-- the transaction's timestamp when the row actually changed, so no writer has
-- to remember to. An update that changes nothing keeps the old row, and the
-- old updated_at with it.
--
-- runner.add_updated_at_trigger(table) installs it, and does nothing on a
-- table without an updated_at column. Every table with one calls it right
-- after its CREATE TABLE.
-- =========================================================================

CREATE FUNCTION runner.set_updated_at() RETURNS TRIGGER
    LANGUAGE plpgsql
AS $$
BEGIN
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
        NEW.updated_at := CURRENT_TIMESTAMP;
        RETURN NEW;
    END IF;
    RETURN OLD;
END;
$$;

CREATE FUNCTION runner.add_updated_at_trigger(tbl REGCLASS) RETURNS VOID
    LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = tbl AND attname = 'updated_at' AND NOT attisdropped
    ) THEN
        EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON %s', tbl);
        EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION runner.set_updated_at()', tbl);
    END IF;
END;
$$;

-- migrate:down

-- The role stays: it belongs to the cluster, and another database on the
-- same server may still hold grants to it, which would make DROP ROLE fail.
-- The up guard reuses it. The grants are reversed so a re-up sets them again.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM app_user';
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE USAGE, SELECT ON SEQUENCES FROM app_user';
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE USAGE ON SCHEMAS FROM app_user';
        EXECUTE 'REVOKE USAGE ON SCHEMA public FROM app_user';
    END IF;
END $$;

DROP FUNCTION runner.add_updated_at_trigger(REGCLASS);
DROP FUNCTION runner.set_updated_at();
DROP SCHEMA IF EXISTS runner;
