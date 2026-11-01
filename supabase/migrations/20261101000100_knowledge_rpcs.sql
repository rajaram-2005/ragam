-- Account-scoped transactional operations for hosted knowledge metadata.
-- This migration remains local/staged; do not apply it to hosted ragam-core yet.
-- Document, chunks and ACL grants are created atomically; purge removes all derived
-- rows and records a content-free deletion receipt in the same transaction.

CREATE FUNCTION public.ragam_knowledge_insert_document(
  p_account_id text,
  p_document jsonb,
  p_chunks jsonb,
  p_principals jsonb,
  p_now bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  inserted_document public.ragam_knowledge_documents%ROWTYPE;
  existing_document public.ragam_knowledge_documents%ROWTYPE;
  chunk jsonb;
  principal text;
  inserted_count integer;
  chunk_ids jsonb := '[]'::jsonb;
BEGIN
  IF p_account_id IS NULL OR p_account_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR jsonb_typeof(p_document) <> 'object'
     OR jsonb_typeof(p_chunks) <> 'array'
     OR jsonb_array_length(p_chunks) < 1 OR jsonb_array_length(p_chunks) > 10000
     OR jsonb_typeof(p_principals) <> 'array'
     OR p_now < 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'knowledge_arguments_invalid');
  END IF;

  IF coalesce(p_document->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR coalesce(p_document->>'title', '') = '' OR length(p_document->>'title') > 500
     OR coalesce(p_document->>'sha256', '') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_document->>'content_key', '') = ''
     OR coalesce(p_document->>'classification', '') NOT IN ('public','internal','confidential','restricted')
     OR coalesce(p_document->>'status', '') <> 'active'
     OR coalesce(p_document->>'size_bytes', '') !~ '^[0-9]+$'
     OR coalesce(p_document->>'chunk_count', '') !~ '^[0-9]+$'
     OR jsonb_typeof(p_document->'meta') <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'knowledge_document_invalid');
  END IF;

  FOR chunk IN SELECT value FROM jsonb_array_elements(p_chunks) LOOP
    IF jsonb_typeof(chunk) <> 'object'
       OR coalesce(chunk->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR coalesce(chunk->>'idx', '') !~ '^[0-9]+$'
       OR coalesce(chunk->>'start_offset', '') !~ '^[0-9]+$'
       OR coalesce(chunk->>'end_offset', '') !~ '^[0-9]+$'
       OR coalesce(chunk->>'token_count', '') !~ '^[0-9]+$'
       OR jsonb_typeof(chunk->'text') <> 'string' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'knowledge_chunk_invalid');
    END IF;
  END LOOP;

  FOR principal IN SELECT value #>> '{}' FROM jsonb_array_elements(p_principals) LOOP
    IF principal IS NULL OR length(principal) < 1 OR length(principal) > 255 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'knowledge_principal_invalid');
    END IF;
  END LOOP;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_account_id, 4));
  INSERT INTO public.ragam_knowledge_documents (
    id, account_id, title, source_label, mime, sha256, content_key, size_bytes,
    classification, status, chunk_count, ingested_at, updated_at, meta
  ) VALUES (
    p_document->>'id', p_account_id, p_document->>'title', p_document->>'source_label', p_document->>'mime',
    p_document->>'sha256', p_document->>'content_key', (p_document->>'size_bytes')::bigint,
    p_document->>'classification', 'active', jsonb_array_length(p_chunks), p_now, p_now, p_document->'meta'
  ) ON CONFLICT DO NOTHING
  RETURNING * INTO inserted_document;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count = 0 THEN
    SELECT * INTO existing_document FROM public.ragam_knowledge_documents
     WHERE account_id = p_account_id AND status = 'active'
       AND (sha256 = p_document->>'sha256' OR content_key = p_document->>'content_key')
     ORDER BY ingested_at DESC LIMIT 1;
    IF existing_document.id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'knowledge_duplicate_race');
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'duplicate', true,
      'reason', CASE WHEN existing_document.sha256 = p_document->>'sha256'
        THEN 'identical content hash' ELSE 'whitespace/case-normalised duplicate' END,
      'document', to_jsonb(existing_document), 'chunk_ids', '[]'::jsonb
    );
  END IF;

  FOR chunk IN SELECT value FROM jsonb_array_elements(p_chunks) LOOP
    INSERT INTO public.ragam_knowledge_chunks (
      id, account_id, document_id, idx, text, start_offset, end_offset, token_count
    ) VALUES (
      chunk->>'id', p_account_id, inserted_document.id, (chunk->>'idx')::integer,
      chunk->>'text', (chunk->>'start_offset')::integer, (chunk->>'end_offset')::integer,
      (chunk->>'token_count')::integer
    );
    chunk_ids := chunk_ids || jsonb_build_array(chunk->>'id');
  END LOOP;

  INSERT INTO public.ragam_knowledge_acl(account_id, document_id, principal, permission, granted_at)
  VALUES (p_account_id, inserted_document.id, p_account_id, 'admin', p_now)
  ON CONFLICT DO NOTHING;
  FOR principal IN SELECT DISTINCT value #>> '{}' FROM jsonb_array_elements(p_principals) LOOP
    INSERT INTO public.ragam_knowledge_acl(account_id, document_id, principal, permission, granted_at)
    VALUES (p_account_id, inserted_document.id, principal, 'read', p_now)
    ON CONFLICT DO NOTHING;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true, 'duplicate', false, 'reason', NULL,
    'document', to_jsonb(inserted_document), 'chunk_ids', chunk_ids
  );
END;
$$;

CREATE FUNCTION public.ragam_knowledge_purge_document(
  p_account_id text,
  p_document_id text,
  p_reason text,
  p_requested_by text,
  p_now bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  document_row public.ragam_knowledge_documents%ROWTYPE;
  chunk_count integer;
  acl_count integer;
  embedding_count integer;
BEGIN
  IF p_account_id IS NULL OR p_account_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_document_id IS NULL OR p_document_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_now < 0 OR length(coalesce(p_reason, '')) > 1000 THEN
    RETURN jsonb_build_object('deleted', false, 'code', 'knowledge_arguments_invalid');
  END IF;

  SELECT * INTO document_row FROM public.ragam_knowledge_documents
   WHERE account_id = p_account_id AND id = p_document_id FOR UPDATE;
  IF document_row.id IS NULL THEN
    RETURN jsonb_build_object('deleted', false, 'reason', 'unknown document');
  END IF;

  SELECT count(*)::integer INTO chunk_count FROM public.ragam_knowledge_chunks
   WHERE account_id = p_account_id AND document_id = p_document_id;
  SELECT count(*)::integer INTO acl_count FROM public.ragam_knowledge_acl
   WHERE account_id = p_account_id AND document_id = p_document_id;
  SELECT count(*)::integer INTO embedding_count FROM public.ragam_knowledge_embeddings e
   JOIN public.ragam_knowledge_chunks c ON c.account_id = e.account_id AND c.id = e.chunk_id
   WHERE c.account_id = p_account_id AND c.document_id = p_document_id;

  DELETE FROM public.ragam_knowledge_documents WHERE account_id = p_account_id AND id = p_document_id;
  INSERT INTO public.ragam_knowledge_deletions (
    id, account_id, at, document_id, title, chunks, acl_rows, embeddings, reason, requested_by
  ) VALUES (
    pg_catalog.gen_random_uuid()::text, p_account_id, p_now, p_document_id, document_row.title,
    chunk_count, acl_count, embedding_count, p_reason, p_requested_by
  );

  RETURN jsonb_build_object(
    'deleted', true, 'documentId', p_document_id, 'title', document_row.title,
    'chunks', chunk_count, 'aclRows', acl_count, 'embeddings', embedding_count,
    'sha256', document_row.sha256
  );
END;
$$;

CREATE FUNCTION public.ragam_knowledge_stats(p_account_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_account_id IS NULL OR p_account_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'knowledge_account_invalid');
  END IF;
  RETURN jsonb_build_object(
    'documents', (SELECT count(*)::bigint FROM public.ragam_knowledge_documents WHERE account_id = p_account_id AND status = 'active'),
    'chunks', (SELECT count(*)::bigint FROM public.ragam_knowledge_chunks WHERE account_id = p_account_id),
    'embeddings', (SELECT count(*)::bigint FROM public.ragam_knowledge_embeddings WHERE account_id = p_account_id),
    'aclRows', (SELECT count(*)::bigint FROM public.ragam_knowledge_acl WHERE account_id = p_account_id),
    'deletions', (SELECT count(*)::bigint FROM public.ragam_knowledge_deletions WHERE account_id = p_account_id),
    'bytesIndexed', (SELECT coalesce(sum(size_bytes), 0)::bigint FROM public.ragam_knowledge_documents WHERE account_id = p_account_id AND status = 'active')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ragam_knowledge_insert_document(text,jsonb,jsonb,jsonb,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ragam_knowledge_purge_document(text,text,text,text,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ragam_knowledge_stats(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ragam_knowledge_insert_document(text,jsonb,jsonb,jsonb,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.ragam_knowledge_purge_document(text,text,text,text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.ragam_knowledge_stats(text) TO service_role;

COMMENT ON FUNCTION public.ragam_knowledge_insert_document(text,jsonb,jsonb,jsonb,bigint) IS 'Atomically inserts one account-owned document, its chunks and ACL grants, or returns the active deduplication match.';
COMMENT ON FUNCTION public.ragam_knowledge_purge_document(text,text,text,text,bigint) IS 'Atomically purges one account-owned document and derived rows, retaining only a content-free deletion receipt.';
