-- One active BYOK connection per authenticated Supabase user. Provider credentials are
-- AES-256-GCM ciphertext produced by the trusted Core API; this table never stores a
-- plaintext provider key. Browser roles have no table privileges. The Core API uses the
-- service-role credential only after authenticating the user's Supabase session and
-- always filters records by that authenticated user id.
create table if not exists public.byok_provider_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  provider_id text not null check (provider_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  base_url text not null check (base_url like 'https://%'),
  credential jsonb not null check (
    jsonb_typeof(credential) = 'object'
    and credential->>'version' = '1'
    and credential ? 'iv'
    and credential ? 'data'
    and credential ? 'tag'
  ),
  models text[] not null default '{}',
  selected_model text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint byok_selected_model_is_listed check (selected_model = '' or selected_model = any(models))
);

create index if not exists byok_provider_connections_provider_idx
  on public.byok_provider_connections (provider_id);

create or replace function public.set_byok_provider_connection_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

drop trigger if exists set_byok_provider_connection_updated_at
  on public.byok_provider_connections;
create trigger set_byok_provider_connection_updated_at
  before update on public.byok_provider_connections
  for each row execute function public.set_byok_provider_connection_updated_at();

alter table public.byok_provider_connections enable row level security;
revoke all on table public.byok_provider_connections from anon, authenticated;
grant select, insert, update, delete on table public.byok_provider_connections to service_role;
