-- Initial Ragam Core relational schema for the Vercel Functions + Supabase target.
-- This file is staged for review and local/disposable validation only. It has NOT been
-- applied to the hosted ragam-core project. No user data is copied by this migration.
--
-- Browser roles receive no policies. The server-only service-role client bypasses RLS,
-- so every server request MUST authenticate first and include explicit account ownership
-- filters. RLS is a second barrier, not a substitute for application authorization.

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE public.ragam_accounts (
  id             text PRIMARY KEY,
  email          text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('owner', 'member')),
  created_at     bigint NOT NULL,
  updated_at     bigint NOT NULL,
  last_login_at  bigint,
  failed_logins  integer NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until   bigint
);
CREATE UNIQUE INDEX ragam_accounts_email_normalized_uq ON public.ragam_accounts (lower(email));

CREATE TABLE public.ragam_password_resets (
  account_id   text PRIMARY KEY REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  code_hash    text NOT NULL,
  requested_at bigint NOT NULL,
  expires_at   bigint NOT NULL,
  consumed_at  bigint
);

-- Session tokens are random and opaque. Store only SHA-256 hex digests; never raw cookies.
CREATE TABLE public.ragam_sessions (
  token_hash  char(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  account_id  text NOT NULL REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  created_at  bigint NOT NULL,
  expires_at  bigint NOT NULL,
  revoked_at  bigint,
  last_seen_at bigint
);
CREATE INDEX ragam_sessions_account_expiry_idx ON public.ragam_sessions(account_id, expires_at);

-- Serialize session caps and revocations across independent Vercel invocations. The only
-- session credential accepted here is a SHA-256 digest; the browser token is never persisted.
CREATE FUNCTION public.ragam_create_session(
  p_account_id text,
  p_token_hash text,
  p_now bigint,
  p_expires_at bigint,
  p_per_account integer,
  p_installation_limit integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  active_for_account integer;
  active_for_installation integer;
  victims_to_revoke integer;
BEGIN
  IF p_account_id IS NULL OR p_account_id = '' OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_expires_at <= p_now OR p_per_account < 1 OR p_installation_limit < 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'session_arguments_invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(99712013, 1);
  IF NOT EXISTS (SELECT 1 FROM public.ragam_accounts WHERE id = p_account_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'account_not_found');
  END IF;

  DELETE FROM public.ragam_sessions WHERE expires_at <= p_now;
  SELECT count(*)::integer INTO active_for_account
    FROM public.ragam_sessions
    WHERE account_id = p_account_id AND revoked_at IS NULL AND expires_at > p_now;
  victims_to_revoke := GREATEST(0, active_for_account - p_per_account + 1);
  IF victims_to_revoke > 0 THEN
    WITH victims AS (
      SELECT token_hash FROM public.ragam_sessions
      WHERE account_id = p_account_id AND revoked_at IS NULL AND expires_at > p_now
      ORDER BY expires_at ASC, created_at ASC
      LIMIT victims_to_revoke
    )
    UPDATE public.ragam_sessions AS sessions
       SET revoked_at = p_now
     WHERE sessions.token_hash IN (SELECT token_hash FROM victims);
  END IF;

  SELECT count(*)::integer INTO active_for_installation
    FROM public.ragam_sessions WHERE revoked_at IS NULL AND expires_at > p_now;
  IF active_for_installation >= p_installation_limit THEN
    RETURN jsonb_build_object('ok', false, 'code', 'session_limit');
  END IF;

  INSERT INTO public.ragam_sessions(token_hash, account_id, created_at, expires_at, revoked_at, last_seen_at)
  VALUES (p_token_hash, p_account_id, p_now, p_expires_at, NULL, p_now);
  RETURN jsonb_build_object('ok', true, 'expires_at', p_expires_at);
END;
$$;

CREATE FUNCTION public.ragam_revoke_session(p_token_hash text, p_now bigint)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed integer;
BEGIN
  UPDATE public.ragam_sessions SET revoked_at = p_now
   WHERE token_hash = p_token_hash AND revoked_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

CREATE FUNCTION public.ragam_revoke_sessions(p_account_id text, p_except_hash text, p_now bigint)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed integer;
BEGIN
  UPDATE public.ragam_sessions SET revoked_at = p_now
   WHERE account_id = p_account_id AND revoked_at IS NULL
     AND (p_except_hash IS NULL OR token_hash <> p_except_hash);
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$$;

REVOKE ALL ON FUNCTION public.ragam_create_session(text, text, bigint, bigint, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ragam_revoke_session(text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ragam_revoke_sessions(text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ragam_create_session(text, text, bigint, bigint, integer, integer) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.ragam_revoke_session(text, bigint) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.ragam_revoke_sessions(text, text, bigint) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ragam_create_session(text, text, bigint, bigint, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ragam_revoke_session(text, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.ragam_revoke_sessions(text, text, bigint) TO service_role;

-- Hash the normalized login identity before storing counters; do not persist raw email here.
CREATE TABLE public.ragam_auth_attempts (
  identity_hash char(64) PRIMARY KEY CHECK (identity_hash ~ '^[0-9a-f]{64}$'),
  failures      integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  locked_until  bigint,
  updated_at    bigint NOT NULL
);

-- Provider configuration is installation-wide in the current application. The encrypted
-- credential is application-encrypted; the encryption key belongs in a server secret.
CREATE TABLE public.ragam_provider_connections (
  id                 text PRIMARY KEY,
  base_url           text NOT NULL,
  key_ciphertext     text,
  models             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(models) = 'array'),
  model_details      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(model_details) = 'array'),
  options            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object'),
  selected_model     text NOT NULL DEFAULT '',
  verified           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(verified) = 'object'),
  checked_at         text,
  revision           bigint NOT NULL DEFAULT 0,
  created_at         bigint NOT NULL,
  updated_at         bigint NOT NULL
);

CREATE TABLE public.ragam_provider_state (
  singleton           boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_connection_id text REFERENCES public.ragam_provider_connections(id) ON DELETE SET NULL,
  selected_model      text NOT NULL DEFAULT '',
  revision            bigint NOT NULL DEFAULT 0,
  updated_at          bigint NOT NULL
);

CREATE TABLE public.ragam_provider_tier_presets (
  tier          text NOT NULL CHECK (tier IN ('lite', 'pro', 'max')),
  modality      text NOT NULL CHECK (modality IN ('chat', 'image', 'video')),
  connection_id text NOT NULL REFERENCES public.ragam_provider_connections(id) ON DELETE CASCADE,
  model         text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  updated_at    bigint NOT NULL,
  PRIMARY KEY (tier, modality)
);

CREATE TABLE public.ragam_audit_events (
  id         text PRIMARY KEY,
  seq        bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  occurred_at bigint NOT NULL,
  category   text NOT NULL,
  action     text NOT NULL,
  outcome    text NOT NULL,
  actor      text,
  subject    text,
  policy     text,
  detail     jsonb,
  redacted   jsonb
);
CREATE INDEX ragam_audit_category_time_idx ON public.ragam_audit_events(category, occurred_at DESC);
CREATE INDEX ragam_audit_subject_idx ON public.ragam_audit_events(subject);

CREATE FUNCTION private.reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'ragam audit events are append-only';
END;
$$;
CREATE TRIGGER ragam_audit_events_append_only
  BEFORE UPDATE OR DELETE ON public.ragam_audit_events
  FOR EACH ROW EXECUTE FUNCTION private.reject_audit_mutation();

CREATE TABLE public.ragam_memories (
  id              text PRIMARY KEY,
  account_id      text NOT NULL REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  text            text NOT NULL,
  kind            text NOT NULL DEFAULT 'fact',
  subject         text,
  tags            jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tags) = 'array'),
  status          text NOT NULL DEFAULT 'approved',
  approved_by     text NOT NULL CHECK (approved_by = 'user'),
  approved_at     bigint NOT NULL,
  created_at      bigint NOT NULL,
  updated_at      bigint NOT NULL,
  superseded_by   text,
  source_kind     text NOT NULL DEFAULT 'user_statement',
  source_session  text,
  data_class      text NOT NULL DEFAULT 'internal',
  consent         text NOT NULL CHECK (consent = 'user_approved'),
  purpose         text NOT NULL CHECK (purpose = 'personal_context'),
  training_use    text NOT NULL CHECK (training_use = 'prohibited'),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, superseded_by) REFERENCES public.ragam_memories(account_id, id)
);
CREATE INDEX ragam_memories_status_idx ON public.ragam_memories(account_id, status);
CREATE INDEX ragam_memories_created_idx ON public.ragam_memories(account_id, created_at DESC);
CREATE UNIQUE INDEX ragam_memories_live_text_uq ON public.ragam_memories(account_id, text) WHERE status = 'approved';

CREATE TABLE public.ragam_memory_candidates (
  id            text PRIMARY KEY,
  account_id    text NOT NULL REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  text          text NOT NULL,
  rationale     text,
  proposed_from text NOT NULL,
  proposed_at   bigint NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  decided_at    bigint,
  decided_by    text,
  memory_id     text,
  FOREIGN KEY (account_id, memory_id) REFERENCES public.ragam_memories(account_id, id) ON DELETE CASCADE
);
CREATE INDEX ragam_memory_candidates_status_idx ON public.ragam_memory_candidates(account_id, status);

CREATE TABLE public.ragam_chat_sessions (
  id         text PRIMARY KEY,
  account_id text NOT NULL REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  title      text,
  started_at bigint NOT NULL,
  last_at    bigint NOT NULL,
  turn_count integer NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
  UNIQUE (account_id, id)
);
CREATE INDEX ragam_chat_sessions_last_idx ON public.ragam_chat_sessions(account_id, last_at DESC);

CREATE TABLE public.ragam_chat_turns (
  id         text PRIMARY KEY,
  account_id text NOT NULL REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  idx        integer NOT NULL,
  role       text NOT NULL,
  content    text NOT NULL,
  created_at bigint NOT NULL,
  data_class text NOT NULL DEFAULT 'internal',
  FOREIGN KEY (account_id, session_id) REFERENCES public.ragam_chat_sessions(account_id, id) ON DELETE CASCADE,
  UNIQUE (account_id, session_id, idx)
);
CREATE INDEX ragam_chat_turns_session_idx ON public.ragam_chat_turns(account_id, session_id, idx);

CREATE TABLE public.ragam_memory_deletions (
  id           text PRIMARY KEY,
  account_id   text NOT NULL REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  memory_id    text NOT NULL,
  deleted_at   bigint NOT NULL,
  reason       text,
  requested_by text
);

CREATE TABLE public.ragam_fabric_entries (
  id                   text PRIMARY KEY,
  account_id           text NOT NULL REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  layer                text NOT NULL CHECK (layer IN ('working','episodic','semantic','preference','project','skill','failure')),
  subject              text,
  predicate            text,
  value                text,
  content              text NOT NULL,
  content_digest       text NOT NULL,
  assertion_kind       text NOT NULL CHECK (assertion_kind IN ('claimed','observed')),
  asserted_by          text NOT NULL,
  verification_status  text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','verified','refuted')),
  verified_by          text,
  verified_method      text,
  confidence           double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  confidence_basis     text NOT NULL,
  confidence_from      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(confidence_from) = 'array'),
  scope_kind           text NOT NULL CHECK (scope_kind IN ('session','project','user','global')),
  scope_id             text,
  readers              jsonb NOT NULL DEFAULT '["owner"]'::jsonb CHECK (jsonb_typeof(readers) = 'array'),
  exportable           boolean NOT NULL DEFAULT false,
  training_use         text NOT NULL CHECK (training_use = 'prohibited'),
  version              integer NOT NULL DEFAULT 1 CHECK (version > 0),
  supersedes           text,
  superseded_by        text,
  reference            text,
  seen_count           integer NOT NULL DEFAULT 1 CHECK (seen_count > 0),
  created_at           bigint NOT NULL,
  updated_at           bigint NOT NULL,
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, supersedes) REFERENCES public.ragam_fabric_entries(account_id, id),
  FOREIGN KEY (account_id, superseded_by) REFERENCES public.ragam_fabric_entries(account_id, id)
);
CREATE INDEX ragam_fabric_layer_idx ON public.ragam_fabric_entries(account_id, layer, scope_kind, scope_id);
CREATE INDEX ragam_fabric_subject_idx ON public.ragam_fabric_entries(account_id, subject, predicate);
CREATE INDEX ragam_fabric_live_idx ON public.ragam_fabric_entries(account_id, id) WHERE superseded_by IS NULL;

CREATE TABLE public.ragam_fabric_provenance (
  id         text PRIMARY KEY,
  account_id text NOT NULL REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  entry_id   text NOT NULL,
  kind       text NOT NULL,
  source     text NOT NULL,
  detail     text,
  digest     text,
  at         bigint NOT NULL,
  FOREIGN KEY (account_id, entry_id) REFERENCES public.ragam_fabric_entries(account_id, id) ON DELETE CASCADE
);
CREATE INDEX ragam_fabric_provenance_entry_idx ON public.ragam_fabric_provenance(account_id, entry_id);

-- Tombstones intentionally omit deleted memory content and provenance.
CREATE TABLE public.ragam_fabric_tombstones (
  id                 text PRIMARY KEY,
  account_id         text NOT NULL REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  entry_id           text NOT NULL,
  layer              text NOT NULL,
  deleted_at         bigint NOT NULL,
  actor              text NOT NULL,
  reason             text NOT NULL CHECK (length(reason) > 0),
  provenance_removed integer NOT NULL CHECK (provenance_removed >= 0)
);

CREATE TABLE public.ragam_knowledge_documents (
  id             text PRIMARY KEY,
  account_id     text NOT NULL REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  title          text NOT NULL,
  source_label   text,
  mime           text,
  sha256         text NOT NULL,
  content_key    text NOT NULL,
  size_bytes     bigint NOT NULL CHECK (size_bytes >= 0),
  classification text NOT NULL DEFAULT 'internal',
  status         text NOT NULL DEFAULT 'active',
  chunk_count    integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  ingested_at    bigint NOT NULL,
  updated_at     bigint NOT NULL,
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(meta) = 'object'),
  UNIQUE (account_id, id)
);
CREATE UNIQUE INDEX ragam_knowledge_sha_active_uq ON public.ragam_knowledge_documents(account_id, sha256) WHERE status = 'active';
CREATE UNIQUE INDEX ragam_knowledge_key_active_uq ON public.ragam_knowledge_documents(account_id, content_key) WHERE status = 'active';
CREATE INDEX ragam_knowledge_status_idx ON public.ragam_knowledge_documents(account_id, status);

CREATE TABLE public.ragam_knowledge_chunks (
  id           text PRIMARY KEY,
  account_id   text NOT NULL REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  document_id  text NOT NULL,
  idx          integer NOT NULL,
  text         text NOT NULL,
  start_offset integer NOT NULL,
  end_offset   integer NOT NULL,
  token_count  integer NOT NULL DEFAULT 0,
  FOREIGN KEY (account_id, document_id) REFERENCES public.ragam_knowledge_documents(account_id, id) ON DELETE CASCADE,
  UNIQUE (account_id, id),
  UNIQUE (account_id, document_id, idx)
);
CREATE INDEX ragam_knowledge_chunks_document_idx ON public.ragam_knowledge_chunks(account_id, document_id, idx);

CREATE TABLE public.ragam_knowledge_acl (
  account_id   text NOT NULL REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  document_id  text NOT NULL,
  principal    text NOT NULL,
  permission   text NOT NULL DEFAULT 'read' CHECK (permission IN ('read','write','admin')),
  granted_at   bigint NOT NULL,
  PRIMARY KEY (account_id, document_id, principal, permission),
  FOREIGN KEY (account_id, document_id) REFERENCES public.ragam_knowledge_documents(account_id, id) ON DELETE CASCADE
);

-- Keep existing embeddings as opaque bytes until a separately measured vector migration is approved.
CREATE TABLE public.ragam_knowledge_embeddings (
  account_id text NOT NULL REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  chunk_id   text NOT NULL,
  model      text NOT NULL,
  dim        integer NOT NULL CHECK (dim > 0),
  vector     bytea NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (account_id, chunk_id),
  FOREIGN KEY (account_id, chunk_id) REFERENCES public.ragam_knowledge_chunks(account_id, id) ON DELETE CASCADE
);

CREATE TABLE public.ragam_knowledge_index_runs (
  id          text PRIMARY KEY,
  account_id  text NOT NULL REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  at          bigint NOT NULL,
  kind        text NOT NULL,
  documents   integer NOT NULL,
  chunks      integer NOT NULL,
  duration_ms bigint NOT NULL,
  outcome     text NOT NULL,
  detail      jsonb
);

CREATE TABLE public.ragam_knowledge_deletions (
  id           text PRIMARY KEY,
  account_id   text NOT NULL REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  at           bigint NOT NULL,
  document_id  text NOT NULL,
  title        text,
  chunks       integer NOT NULL,
  acl_rows     integer NOT NULL,
  embeddings   integer NOT NULL,
  reason       text,
  requested_by text
);

-- Skills are reviewed installation-wide procedures unless an explicit owner is set.
CREATE TABLE public.ragam_skills (
  id             text PRIMARY KEY,
  scope          text NOT NULL CHECK (scope IN ('installation','account')),
  account_id     text REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  name           text NOT NULL,
  active_version integer NOT NULL CHECK (active_version > 0),
  updated_at     bigint NOT NULL,
  CHECK ((scope = 'installation' AND account_id IS NULL) OR (scope = 'account' AND account_id IS NOT NULL)),
  UNIQUE (account_id, name)
);

CREATE TABLE public.ragam_skill_versions (
  skill_id    text NOT NULL REFERENCES public.ragam_skills(id) ON DELETE CASCADE,
  version     integer NOT NULL CHECK (version > 0),
  content     text NOT NULL,
  digest      text NOT NULL,
  created_at  bigint NOT NULL,
  created_by  text,
  PRIMARY KEY (skill_id, version)
);

CREATE TABLE public.ragam_skill_deletions (
  id           text PRIMARY KEY,
  skill_id     text NOT NULL,
  deleted_at   bigint NOT NULL,
  requested_by text,
  reason       text NOT NULL,
  CHECK (length(reason) > 0)
);

CREATE TABLE public.ragam_styles (
  account_id text PRIMARY KEY REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  style      jsonb NOT NULL CHECK (jsonb_typeof(style) = 'object'),
  updated_at bigint NOT NULL
);

-- Metadata only: these rows do not make function invocations durable workers. A background
-- provider job that exceeds the bounded Vercel request must be declined until a worker is approved.
CREATE TABLE public.ragam_media_jobs (
  id          text PRIMARY KEY,
  account_id  text NOT NULL REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('image','video')),
  state       text NOT NULL CHECK (state IN ('queued','running','validating','succeeded','failed','cancelled','timed_out')),
  progress    double precision NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
  stage       text NOT NULL,
  params      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object'),
  history     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(history) = 'array'),
  artifact_id text,
  error_code  text,
  created_at  bigint NOT NULL,
  started_at  bigint,
  finished_at bigint,
  updated_at  bigint NOT NULL,
  UNIQUE (account_id, id)
);
CREATE INDEX ragam_media_jobs_account_created_idx ON public.ragam_media_jobs(account_id, created_at DESC);

CREATE TABLE public.ragam_media_artifacts (
  id           text PRIMARY KEY,
  account_id   text NOT NULL REFERENCES public.ragam_accounts(id) ON DELETE CASCADE,
  job_id       text,
  object_key   text NOT NULL UNIQUE,
  sha256       text NOT NULL,
  content_type text NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes > 0),
  created_at   bigint NOT NULL,
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, job_id) REFERENCES public.ragam_media_jobs(account_id, id)
);
ALTER TABLE public.ragam_media_jobs
  ADD CONSTRAINT ragam_media_jobs_artifact_fk
  FOREIGN KEY (account_id, artifact_id) REFERENCES public.ragam_media_artifacts(account_id, id) ON DELETE SET NULL;

-- Enable RLS on every table. No anon/authenticated policies are created: browser access is denied.
-- The privileged server client bypasses RLS and must enforce ownership in every repository method.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ragam_accounts', 'ragam_password_resets', 'ragam_sessions', 'ragam_auth_attempts',
    'ragam_provider_connections', 'ragam_provider_state', 'ragam_provider_tier_presets',
    'ragam_audit_events', 'ragam_memories', 'ragam_memory_candidates', 'ragam_chat_sessions',
    'ragam_chat_turns', 'ragam_memory_deletions', 'ragam_fabric_entries',
    'ragam_fabric_provenance', 'ragam_fabric_tombstones', 'ragam_knowledge_documents',
    'ragam_knowledge_chunks', 'ragam_knowledge_acl', 'ragam_knowledge_embeddings',
    'ragam_knowledge_index_runs', 'ragam_knowledge_deletions', 'ragam_skills',
    'ragam_skill_versions', 'ragam_skill_deletions', 'ragam_styles', 'ragam_media_jobs',
    'ragam_media_artifacts'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
  END LOOP;
END;
$$;

COMMENT ON SCHEMA private IS 'Internal helpers; not exposed to PostgREST clients.';
COMMENT ON TABLE public.ragam_sessions IS 'Stores only one-way token hashes; never raw session cookies.';
COMMENT ON TABLE public.ragam_provider_connections IS 'Installation-wide provider settings; key_ciphertext must be encrypted by Core before storage.';
COMMENT ON TABLE public.ragam_memories IS 'Personal memories require explicit user consent and are never training data.';
COMMENT ON TABLE public.ragam_fabric_tombstones IS 'Deletion receipts omit content and provenance by design.';
COMMENT ON TABLE public.ragam_knowledge_embeddings IS 'Opaque legacy embedding bytes; no vector extension or retrieval claim is implied.';
COMMENT ON TABLE public.ragam_media_jobs IS 'Durable metadata only; does not itself provide background execution.';
