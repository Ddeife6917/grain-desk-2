-- Run this once in Supabase: Project > SQL Editor > New query > paste this in > Run.

create extension if not exists pgcrypto;

-- Shared price log (visible to any signed-in user)
create table if not exists prices (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  date date not null,
  wheat_type text not null,
  futures_market text,
  futures_price numeric,
  cash_price numeric,
  basis numeric,
  elevator text,
  created_by uuid references auth.users(id)
);

alter table prices enable row level security;

create policy "signed in users can read prices"
  on prices for select
  to authenticated
  using (true);

create policy "signed in users can add prices"
  on prices for insert
  to authenticated
  with check (true);

create policy "signed in users can remove prices"
  on prices for delete
  to authenticated
  using (true);

-- Private contract ledger (each user only sees their own rows)
create table if not exists contracts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  user_id uuid references auth.users(id) not null default auth.uid(),
  wheat_type text not null,
  contract_type text not null,
  bushels numeric not null,
  price numeric,
  delivery_period text,
  elevator text,
  date_entered date,
  notes text
);

alter table contracts enable row level security;

create policy "users manage their own contracts"
  on contracts for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Private breakeven settings (each user only sees their own rows)
create table if not exists breakevens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null default auth.uid(),
  wheat_type text not null,
  value numeric,
  unique (user_id, wheat_type)
);

alter table breakevens enable row level security;

create policy "users manage their own breakevens"
  on breakevens for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
