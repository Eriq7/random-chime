-- 随机提示音:每次走满的专注存一行(热力图的数据)。浏览器直接连这张表,
-- 行级安全(RLS)是唯一保证"每个人只能看到自己的行"的东西。

-- 历史表只追加:只给 select 和 insert,不给 update 和 delete。
create table public.focus_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- 浏览器生成的 id,重传同一条不会多出一行(重复插入报 23505,前端当成功)。
  client_id text not null,
  -- 专注真正走到 0 的那一刻(浏览器时钟)。哪天算几次,由前端按本地 0 点换天去算。
  ended_at timestamptz not null,
  minutes numeric not null check (minutes > 0 and minutes <= 600),
  created_at timestamptz not null default now(),
  unique (user_id, client_id)
);

create index focus_sessions_user_ended_idx on public.focus_sessions (user_id, ended_at);

alter table public.focus_sessions enable row level security;

create policy "read own sessions" on public.focus_sessions
  for select to authenticated using (user_id = (select auth.uid()));
create policy "add own sessions" on public.focus_sessions
  for insert to authenticated with check (user_id = (select auth.uid()));

-- 表权限写明白,不依赖项目默认值。
revoke all on public.focus_sessions from anon, authenticated;
grant select, insert on public.focus_sessions to authenticated;
