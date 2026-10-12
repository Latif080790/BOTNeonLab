-- Portable catalog snapshot, excluding data and object OIDs.
select 'column' as kind, table_name||'.'||column_name as key,
  concat_ws('|',data_type,udt_name,is_nullable,column_default) as definition
from information_schema.columns where table_schema='public'
union all
select 'constraint',c.relname||'.'||k.conname,pg_get_constraintdef(k.oid)
from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
union all
select 'index',tablename||'.'||indexname,indexdef from pg_indexes where schemaname='public'
union all
select 'policy',tablename||'.'||policyname,concat_ws('|',permissive,roles::text,cmd,qual,with_check) from pg_policies where schemaname='public'
union all
select 'trigger',c.relname||'.'||t.tgname,pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid
join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal
union all
select 'function',p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
  md5(regexp_replace(p.prosrc,'\s','','g'))||'|'||p.prosecdef||'|'||coalesce(p.proacl::text,'DEFAULT')||'|'||coalesce(p.proconfig::text,'')
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
union all
select 'grant',table_name||'.'||grantee||'.'||privilege_type,is_grantable from information_schema.role_table_grants where table_schema='public'
order by kind,key;
