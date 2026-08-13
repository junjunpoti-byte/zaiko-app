-- 在庫管理台帳 — Supabase スキーマ
-- Supabaseダッシュボードの「SQL Editor」にこのファイルの内容を貼り付けて実行してください。

create extension if not exists "pgcrypto";

-- 商品
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null,
  name text not null,
  location text not null default '未設定',
  location_picks jsonb,
  memo text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

-- 入荷・消費の記録
create table if not exists public.movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id) on delete set null,
  type text not null check (type in ('in', 'out')),
  qty numeric not null check (qty > 0),
  person text,
  user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists movements_product_id_idx on public.movements (product_id);
create index if not exists movements_created_at_idx on public.movements (created_at);

-- Row Level Security: 社内共有ツールなので、ログイン済みユーザーなら
-- 誰でも読み書きできるようにする(会社アカウント全員に同じデータを見せる想定)
alter table public.products enable row level security;
alter table public.movements enable row level security;

drop policy if exists "products_all_authenticated" on public.products;
create policy "products_all_authenticated" on public.products
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "movements_all_authenticated" on public.movements;
create policy "movements_all_authenticated" on public.movements
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- リアルタイム同期を有効化(すでに追加済みの場合はエラーが出ますが無視してOK)
alter publication supabase_realtime add table public.products;
alter publication supabase_realtime add table public.movements;
