-- AI Refrigerator — cloud sync schema.
-- One row per (user, kind, item). Row-Level Security ties every row to the
-- signed-in user, so each account only ever sees its own fridge.

create table if not exists public.fridge_data (
  user_id    uuid        not null default auth.uid() references auth.users on delete cascade,
  kind       text        not null check (kind in ('preset', 'custom_item', 'saved_session')),
  item_id    text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, item_id)
);

alter table public.fridge_data enable row level security;

drop policy if exists "own rows" on public.fridge_data;
create policy "own rows" on public.fridge_data
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
