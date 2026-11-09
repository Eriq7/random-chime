-- 运行: supabase db query --linked -f supabase/checks/rls.sql
-- 期望看到报错 "RLS CHECK PASSED (rolled back)";别的结果都说明规则坏了。
-- 扮演两个假用户 A 和 B 检查行级权限。整段永远以 raise exception 收尾,假用户和假数据全部回滚,不留任何东西。
do $$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  n int;
  failed text := '';
  as_user text := 'select set_config(''request.jwt.claims'', json_build_object(''sub'', %L, ''role'', ''authenticated'')::text, true)';
begin
  insert into auth.users (id, email, aud, role) values
    (a, 'rls-a@example.invalid', 'authenticated', 'authenticated'),
    (b, 'rls-b@example.invalid', 'authenticated', 'authenticated');

  -- A 存一条;同一个 client_id 再存必须被挡;不能改、不能删。
  execute format(as_user, a);
  execute 'set local role authenticated';
  insert into public.focus_sessions (client_id, ended_at, minutes) values ('c1', now(), 40);
  select count(*) into n from public.focus_sessions;
  if n <> 1 then failed := failed || ' A cannot read own row;'; end if;
  begin
    insert into public.focus_sessions (client_id, ended_at, minutes) values ('c1', now(), 40);
    failed := failed || ' duplicate client_id allowed;';
  exception when unique_violation then null;
  end;
  begin
    update public.focus_sessions set minutes = 1;
    failed := failed || ' update allowed;';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.focus_sessions;
    failed := failed || ' delete allowed;';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.focus_sessions (client_id, ended_at, minutes) values ('c2', now(), 0);
    failed := failed || ' zero minutes allowed;';
  exception when check_violation then null;
  end;

  -- B 看不到也碰不到 A 的行,也不能冒充 A 写入。
  execute 'reset role';
  execute format(as_user, b);
  execute 'set local role authenticated';
  select count(*) into n from public.focus_sessions;
  if n <> 0 then failed := failed || ' B reads A rows;'; end if;
  begin
    insert into public.focus_sessions (user_id, client_id, ended_at, minutes) values (a, 'b1', now(), 40);
    failed := failed || ' B writes row as A;';
  exception when insufficient_privilege then null;
  end;

  -- 没登录:完全不能访问。
  execute 'reset role';
  execute 'set local role anon';
  begin
    select count(*) into n from public.focus_sessions;
    failed := failed || ' anon reads focus_sessions;';
  exception when insufficient_privilege then null;
  end;

  execute 'reset role';
  if failed = '' then
    raise exception 'RLS CHECK PASSED (rolled back)';
  else
    raise exception 'RLS CHECK FAILED (rolled back):%', failed;
  end if;
end
$$;
