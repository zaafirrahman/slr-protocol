-- =====================================================================
-- LitReview Studio — skema Supabase (login mandiri + token tracking)
-- Cara pakai: Supabase Dashboard > SQL Editor > New query > tempel > Run.
-- Aman dijalankan ulang (idempotent).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- Tabel ----------------------------------------------------
create table if not exists public.users (
  id                uuid primary key default gen_random_uuid(),
  username          text not null,
  api_key_hash      text not null unique,          -- SHA-256 dari key; key asli TIDAK disimpan
  is_active         boolean not null default true,  -- false = diblokir
  daily_token_limit bigint,                         -- opsional, per hari (zona WIB); null = tanpa batas
  created_at        timestamptz not null default now()
);
create unique index if not exists users_username_ci on public.users (lower(username));

create table if not exists public.token_logs (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references public.users(id) on delete cascade,
  model_name        text,
  prompt_tokens     int not null default 0,
  cache_hit_tokens  int not null default 0,
  completion_tokens int not null default 0,
  total_tokens      int not null default 0,
  created_at        timestamptz not null default now()
);
create index if not exists token_logs_user_time on public.token_logs (user_id, created_at desc);

-- ---------- RLS: semua tabel tertutup untuk anon key -----------------
alter table public.users        enable row level security;
alter table public.token_logs   enable row level security;
-- Sengaja TANPA policy: anon key tidak bisa baca/tulis tabel apa pun secara langsung.

-- ---------- Fungsi 1: daftar (dipanggil dari /signup lokal) ----------
create or replace function public.register_user(p_username text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name text := btrim(coalesce(p_username, ''));
  v_key  text;
begin
  if length(v_name) < 3 or length(v_name) > 60 then
    raise exception 'USERNAME_INVALID';
  end if;
  if exists (select 1 from users where lower(username) = lower(v_name)) then
    raise exception 'USERNAME_TAKEN';
  end if;

  v_key := 'slr_' || encode(gen_random_bytes(24), 'hex');
  insert into users (username, api_key_hash)
  values (v_name, encode(digest(v_key, 'sha256'), 'hex'));
  return v_key;                                    -- satu-satunya kali key asli terlihat
exception when unique_violation then
  raise exception 'USERNAME_TAKEN';
end;
$$;

-- ---------- Fungsi 2: cek akun + kuota (dipanggil Edge Function) -----
create or replace function public.check_user(p_key_hash text)
returns table (user_id uuid, username text, status text)
language sql
security definer
set search_path = public
as $$
  select u.id, u.username,
    case
      when not u.is_active then 'disabled'
      when u.daily_token_limit is not null and coalesce((
             select sum(t.total_tokens) from token_logs t
             where t.user_id = u.id
               and t.created_at >= (date_trunc('day', now() at time zone 'Asia/Jakarta') at time zone 'Asia/Jakarta')
           ), 0) >= u.daily_token_limit then 'quota'
      else 'ok'
    end
  from users u
  where u.api_key_hash = p_key_hash;
$$;

-- ---------- View ringkasan untuk Table Editor / dashboard ------------
create or replace view public.usage_per_user with (security_invoker = true) as
select u.username,
       u.is_active,
       u.daily_token_limit,
       count(t.id)                                   as calls,
       coalesce(sum(t.prompt_tokens), 0)             as prompt_tokens,
       coalesce(sum(t.completion_tokens), 0)         as completion_tokens,
       coalesce(sum(t.total_tokens), 0)              as total_tokens,
       coalesce(sum(t.total_tokens) filter (
         where t.created_at >= (date_trunc('day', now() at time zone 'Asia/Jakarta') at time zone 'Asia/Jakarta')
       ), 0)                                         as tokens_today,
       max(t.created_at)                             as last_used,
       u.created_at                                  as registered_at
from users u
left join token_logs t on t.user_id = u.id
group by u.id
order by total_tokens desc;

-- ---------- Hak akses (taruh PALING AKHIR) ---------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant execute on function public.register_user(text) to anon;   -- hanya ini yang terbuka
grant execute on function public.check_user(text)           to service_role;
