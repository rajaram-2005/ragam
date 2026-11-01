-- Durable provider state and private media object bucket for the hosted Core.
-- Provider credentials remain AES-256-GCM ciphertext; the encryption key is a
-- server-only Vercel secret. Browser roles receive no Storage object policies.

ALTER TABLE public.ragam_provider_state
  ADD COLUMN IF NOT EXISTS payload jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'ragam_provider_state_payload_object'
      AND conrelid = 'public.ragam_provider_state'::regclass
  ) THEN
    ALTER TABLE public.ragam_provider_state
      ADD CONSTRAINT ragam_provider_state_payload_object
      CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.ragam_save_provider_snapshot(
  p_payload jsonb,
  p_expected_revision bigint,
  p_now bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE current_revision bigint;
DECLARE next_revision bigint;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR p_payload ->> 'schema' <> '2'
     OR jsonb_typeof(p_payload -> 'connections') <> 'object'
     OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR p_now IS NULL OR p_now < 0
     OR pg_catalog.octet_length(p_payload::text) > 2097152 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'provider_state_invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(99712013, 4);
  SELECT revision INTO current_revision
    FROM public.ragam_provider_state
    WHERE singleton = true
    FOR UPDATE;
  current_revision := COALESCE(current_revision, 0);
  IF current_revision <> p_expected_revision THEN
    RETURN jsonb_build_object('ok', false, 'code', 'provider_state_conflict');
  END IF;
  next_revision := current_revision + 1;

  INSERT INTO public.ragam_provider_state(singleton, active_connection_id, selected_model, revision, updated_at, payload)
  VALUES (true, NULL, COALESCE(p_payload -> 'klyvaron' ->> 'selectedModel', ''), next_revision, p_now, p_payload)
  ON CONFLICT (singleton) DO UPDATE
    SET active_connection_id = NULL,
        selected_model = EXCLUDED.selected_model,
        revision = EXCLUDED.revision,
        updated_at = EXCLUDED.updated_at,
        payload = EXCLUDED.payload;

  RETURN jsonb_build_object('ok', true, 'revision', next_revision);
END;
$$;

REVOKE ALL ON FUNCTION public.ragam_save_provider_snapshot(jsonb, bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ragam_save_provider_snapshot(jsonb, bigint, bigint) TO service_role;

-- Private by default; only the server service-role client can read or write objects.
INSERT INTO storage.buckets(id, name, public, file_size_limit)
VALUES ('ragam-media', 'ragam-media', false, 25165824)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit;
