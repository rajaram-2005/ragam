-- Account-scoped transactional operations for the async Supabase memory repository.
-- This migration remains local/staged; do not apply it to hosted ragam-core yet.
-- Multi-row actions are RPCs so concurrent Vercel invocations cannot split decisions,
-- partial deletes, or session turn counts across separate HTTP requests.

ALTER TABLE public.ragam_memories
  ADD CONSTRAINT ragam_memories_status_check CHECK (status IN ('approved', 'superseded')),
  ADD CONSTRAINT ragam_memories_kind_check CHECK (kind IN ('fact', 'preference', 'decision', 'constraint'));
ALTER TABLE public.ragam_memory_candidates
  ADD CONSTRAINT ragam_memory_candidates_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
  ADD CONSTRAINT ragam_memory_candidates_decided_by_check CHECK (decided_by IS NULL OR decided_by = 'user'),
  ADD CONSTRAINT ragam_memory_candidates_decision_state_check CHECK (
    (status = 'pending' AND decided_at IS NULL AND decided_by IS NULL)
    OR (status <> 'pending' AND decided_at IS NOT NULL AND decided_by = 'user')
  );
ALTER TABLE public.ragam_chat_turns
  ADD CONSTRAINT ragam_chat_turns_role_check CHECK (role IN ('user', 'assistant', 'system'));

CREATE FUNCTION public.ragam_memory_remember(
  p_account_id text,
  p_id text,
  p_text text,
  p_kind text,
  p_subject text,
  p_tags jsonb,
  p_source_kind text,
  p_source_session text,
  p_data_class text,
  p_now bigint,
  p_max_memories integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE existing_row public.ragam_memories%ROWTYPE; live_count integer; inserted_row public.ragam_memories%ROWTYPE;
BEGIN
  IF p_account_id IS NULL OR p_account_id = '' OR p_id IS NULL OR p_id = ''
     OR p_text IS NULL OR p_text = '' OR p_kind IS NULL OR p_kind = ''
     OR jsonb_typeof(p_tags) <> 'array' OR p_max_memories < 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'memory_arguments_invalid');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_account_id, 914238));
  SELECT * INTO existing_row FROM public.ragam_memories
    WHERE account_id = p_account_id AND text = p_text AND status = 'approved' LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'memory', pg_catalog.to_jsonb(existing_row));
  END IF;
  SELECT count(*)::integer INTO live_count FROM public.ragam_memories
    WHERE account_id = p_account_id AND status = 'approved';
  IF live_count >= p_max_memories THEN
    RETURN jsonb_build_object('ok', false, 'code', 'memory_limit');
  END IF;
  INSERT INTO public.ragam_memories(
    id, account_id, text, kind, subject, tags, status, approved_by, approved_at, created_at,
    updated_at, superseded_by, source_kind, source_session, data_class, consent, purpose, training_use
  ) VALUES (
    p_id, p_account_id, p_text, p_kind, p_subject, p_tags, 'approved', 'user', p_now, p_now,
    p_now, NULL, p_source_kind, p_source_session, p_data_class, 'user_approved', 'personal_context', 'prohibited'
  ) RETURNING * INTO inserted_row;
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'memory', pg_catalog.to_jsonb(inserted_row));
END;
$$;

CREATE FUNCTION public.ragam_memory_supersede(
  p_account_id text, p_old_id text, p_new_id text, p_text text, p_kind text,
  p_subject text, p_tags jsonb, p_source_session text, p_data_class text,
  p_now bigint, p_max_memories integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE old_row public.ragam_memories%ROWTYPE; old_json jsonb; result jsonb; new_row jsonb;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_account_id, 914238));
  SELECT * INTO old_row FROM public.ragam_memories
    WHERE account_id = p_account_id AND id = p_old_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  IF old_row.status <> 'approved' THEN RETURN jsonb_build_object('ok', false, 'code', 'not_approved'); END IF;
  result := public.ragam_memory_remember(
    p_account_id, p_new_id, p_text, p_kind, p_subject, p_tags,
    'user_statement', p_source_session, p_data_class, p_now, p_max_memories
  );
  IF NOT COALESCE((result->>'ok')::boolean, false) THEN RETURN result; END IF;
  new_row := result->'memory';
  IF (result->>'duplicate')::boolean AND new_row->>'id' = p_old_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'same_memory');
  END IF;
  UPDATE public.ragam_memories SET status = 'superseded', superseded_by = new_row->>'id', updated_at = p_now
    WHERE account_id = p_account_id AND id = p_old_id;
  SELECT pg_catalog.to_jsonb(m) INTO old_json FROM public.ragam_memories m
    WHERE m.account_id = p_account_id AND m.id = p_old_id;
  RETURN jsonb_build_object('ok', true, 'superseded', old_json, 'replacement', new_row,
    'duplicate', (result->>'duplicate')::boolean);
END;
$$;

CREATE FUNCTION public.ragam_memory_forget(
  p_account_id text, p_memory_id text, p_deletion_id text,
  p_now bigint, p_reason text, p_requested_by text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE memory_row public.ragam_memories%ROWTYPE;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_account_id, 914238));
  SELECT * INTO memory_row FROM public.ragam_memories
    WHERE account_id = p_account_id AND id = p_memory_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  UPDATE public.ragam_memories SET superseded_by = NULL
    WHERE account_id = p_account_id AND superseded_by = p_memory_id;
  UPDATE public.ragam_memory_candidates SET memory_id = NULL
    WHERE account_id = p_account_id AND memory_id = p_memory_id;
  DELETE FROM public.ragam_memories WHERE account_id = p_account_id AND id = p_memory_id;
  INSERT INTO public.ragam_memory_deletions(id, account_id, memory_id, deleted_at, reason, requested_by)
    VALUES (p_deletion_id, p_account_id, p_memory_id, p_now, p_reason, p_requested_by);
  RETURN jsonb_build_object('ok', true, 'memory_id', p_memory_id, 'text_was', length(memory_row.text) > 0);
END;
$$;

CREATE FUNCTION public.ragam_memory_forget_all(
  p_account_id text, p_now bigint, p_reason text, p_requested_by text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE memory_count integer; candidate_count integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_account_id, 914238));
  SELECT count(*)::integer INTO memory_count FROM public.ragam_memories WHERE account_id = p_account_id;
  SELECT count(*)::integer INTO candidate_count FROM public.ragam_memory_candidates WHERE account_id = p_account_id;
  INSERT INTO public.ragam_memory_deletions(id, account_id, memory_id, deleted_at, reason, requested_by)
    SELECT pg_catalog.gen_random_uuid()::text, p_account_id, m.id, p_now, p_reason, p_requested_by
      FROM public.ragam_memories AS m WHERE m.account_id = p_account_id;
  UPDATE public.ragam_memories SET superseded_by = NULL
    WHERE account_id = p_account_id AND superseded_by IS NOT NULL;
  UPDATE public.ragam_memory_candidates SET memory_id = NULL
    WHERE account_id = p_account_id AND memory_id IS NOT NULL;
  DELETE FROM public.ragam_memory_candidates WHERE account_id = p_account_id;
  DELETE FROM public.ragam_memories WHERE account_id = p_account_id;
  RETURN jsonb_build_object('ok', true, 'deleted_memories', memory_count, 'deleted_candidates', candidate_count);
END;
$$;

CREATE FUNCTION public.ragam_memory_decide_candidate(
  p_account_id text, p_candidate_id text, p_approve boolean, p_memory_id text,
  p_kind text, p_subject text, p_tags jsonb, p_now bigint, p_max_memories integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE candidate_row public.ragam_memory_candidates%ROWTYPE; result jsonb; changed_row public.ragam_memory_candidates%ROWTYPE;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_account_id, 914238));
  SELECT * INTO candidate_row FROM public.ragam_memory_candidates
    WHERE account_id = p_account_id AND id = p_candidate_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  IF candidate_row.status <> 'pending' THEN RETURN jsonb_build_object('ok', false, 'code', 'already_decided'); END IF;
  IF NOT p_approve THEN
    UPDATE public.ragam_memory_candidates SET status = 'rejected', decided_at = p_now, decided_by = 'user'
      WHERE account_id = p_account_id AND id = p_candidate_id RETURNING * INTO changed_row;
    RETURN jsonb_build_object('ok', true, 'approved', false, 'candidate', pg_catalog.to_jsonb(changed_row));
  END IF;
  result := public.ragam_memory_remember(
    p_account_id, p_memory_id, candidate_row.text, p_kind, p_subject, p_tags,
    'proposed:' || candidate_row.proposed_from, NULL, 'internal', p_now, p_max_memories
  );
  IF NOT COALESCE((result->>'ok')::boolean, false) THEN RETURN result; END IF;
  UPDATE public.ragam_memory_candidates SET status = 'approved', decided_at = p_now, decided_by = 'user',
      memory_id = (result->'memory'->>'id')
    WHERE account_id = p_account_id AND id = p_candidate_id RETURNING * INTO changed_row;
  RETURN jsonb_build_object('ok', true, 'approved', true, 'duplicate', (result->>'duplicate')::boolean,
    'candidate', pg_catalog.to_jsonb(changed_row), 'memory', result->'memory');
END;
$$;

CREATE FUNCTION public.ragam_memory_append_turn(
  p_account_id text, p_session_id text, p_turn_id text, p_role text, p_content text,
  p_data_class text, p_now bigint, p_max_turns integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE session_row public.ragam_chat_sessions%ROWTYPE; turn_index integer;
BEGIN
  SELECT * INTO session_row FROM public.ragam_chat_sessions
    WHERE account_id = p_account_id AND id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  IF session_row.turn_count >= p_max_turns THEN RETURN jsonb_build_object('ok', false, 'code', 'session_limit'); END IF;
  turn_index := session_row.turn_count;
  INSERT INTO public.ragam_chat_turns(id, account_id, session_id, idx, role, content, created_at, data_class)
    VALUES (p_turn_id, p_account_id, p_session_id, turn_index, p_role, p_content, p_now, p_data_class);
  UPDATE public.ragam_chat_sessions SET turn_count = turn_count + 1, last_at = p_now
    WHERE account_id = p_account_id AND id = p_session_id;
  RETURN jsonb_build_object('ok', true, 'turn', jsonb_build_object(
    'id', p_turn_id, 'session_id', p_session_id, 'idx', turn_index, 'role', p_role, 'created_at', p_now
  ));
END;
$$;

CREATE FUNCTION public.ragam_memory_delete_session(p_account_id text, p_session_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE session_row public.ragam_chat_sessions%ROWTYPE; turn_count integer;
BEGIN
  SELECT * INTO session_row FROM public.ragam_chat_sessions
    WHERE account_id = p_account_id AND id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  SELECT count(*)::integer INTO turn_count FROM public.ragam_chat_turns
    WHERE account_id = p_account_id AND session_id = p_session_id;
  DELETE FROM public.ragam_chat_sessions WHERE account_id = p_account_id AND id = p_session_id;
  RETURN jsonb_build_object('ok', true, 'turns_removed', turn_count);
END;
$$;

CREATE FUNCTION public.ragam_memory_stats(p_account_id text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'memories', (SELECT count(*) FROM public.ragam_memories WHERE account_id = p_account_id AND status = 'approved'),
    'supersededMemories', (SELECT count(*) FROM public.ragam_memories WHERE account_id = p_account_id AND status = 'superseded'),
    'pendingCandidates', (SELECT count(*) FROM public.ragam_memory_candidates WHERE account_id = p_account_id AND status = 'pending'),
    'sessions', (SELECT count(*) FROM public.ragam_chat_sessions WHERE account_id = p_account_id),
    'turns', (SELECT count(*) FROM public.ragam_chat_turns WHERE account_id = p_account_id),
    'deletionsRecorded', (SELECT count(*) FROM public.ragam_memory_deletions WHERE account_id = p_account_id)
  );
$$;

REVOKE ALL ON FUNCTION public.ragam_memory_remember(text,text,text,text,text,jsonb,text,text,text,bigint,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ragam_memory_supersede(text,text,text,text,text,text,jsonb,text,text,bigint,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ragam_memory_forget(text,text,text,bigint,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ragam_memory_forget_all(text,bigint,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ragam_memory_decide_candidate(text,text,boolean,text,text,text,jsonb,bigint,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ragam_memory_append_turn(text,text,text,text,text,text,bigint,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ragam_memory_delete_session(text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ragam_memory_stats(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ragam_memory_remember(text,text,text,text,text,jsonb,text,text,text,bigint,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ragam_memory_supersede(text,text,text,text,text,text,jsonb,text,text,bigint,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ragam_memory_forget(text,text,text,bigint,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.ragam_memory_forget_all(text,bigint,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.ragam_memory_decide_candidate(text,text,boolean,text,text,text,jsonb,bigint,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ragam_memory_append_turn(text,text,text,text,text,text,bigint,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ragam_memory_delete_session(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.ragam_memory_stats(text) TO service_role;
