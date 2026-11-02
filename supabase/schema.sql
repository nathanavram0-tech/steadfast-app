-- Steadfast database. Run once in Supabase: SQL Editor > New query > paste > Run.
-- Every row belongs to one signed-in user; row level security means nobody else can read or write it.

create table if not exists public.docs (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,                 -- 'core', 'm-2026-11', 'j-2026-11', 'chat', 'brain', 'p-<photo>'
  kind text not null,               -- core | month | journal | chat | brain | photo
  body jsonb not null,              -- the document exactly as the app writes it
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists docs_user_kind on public.docs (user_id, kind);
alter table public.docs enable row level security;
drop policy if exists "own docs" on public.docs;
create policy "own docs" on public.docs for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Audit trail: every change an AI coach makes (text or voice) is written here.
create table if not exists public.audit (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  at timestamptz not null default now(),
  source text not null,             -- 'voice' | 'chat' | 'you'
  action text not null,
  detail jsonb
);
alter table public.audit enable row level security;
drop policy if exists "own audit read" on public.audit;
drop policy if exists "own audit write" on public.audit;
create policy "own audit read" on public.audit for select using (auth.uid() = user_id);
create policy "own audit write" on public.audit for insert with check (auth.uid() = user_id);
