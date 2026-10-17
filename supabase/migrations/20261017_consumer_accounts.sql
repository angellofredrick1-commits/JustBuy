-- JustBuy consumer accounts: customer number, PIN sign-in, packages linked to a customer.
-- Safe to run once on the "JustBuy Shipments" Supabase project (SQL editor → paste → Run).

-- ---------- Registrations become consumer accounts ----------
create sequence if not exists public.customer_no_seq start 1001;
alter table public.registrations
  add column if not exists customer_no text unique,
  add column if not exists phone_key text,
  add column if not exists pin_hash text,
  add column if not exists failed_logins int not null default 0,
  add column if not exists locked_until timestamptz;
update public.registrations set customer_no = 'JBU-' || nextval('public.customer_no_seq') where customer_no is null;
alter table public.registrations alter column customer_no set default ('JBU-' || nextval('public.customer_no_seq'));
alter table public.registrations alter column customer_no set not null;
update public.registrations set phone_key = right(regexp_replace(phone,'\D','','g'), 9);

create or replace function public.registrations_phone_key()
returns trigger language plpgsql set search_path = '' as $$
begin new.phone_key := right(regexp_replace(new.phone,'\D','','g'), 9); return new; end; $$;
revoke all on function public.registrations_phone_key() from public, anon, authenticated;
create or replace trigger registrations_phone_key before insert or update of phone on public.registrations
  for each row execute function public.registrations_phone_key();
create unique index if not exists registrations_phone_key_uniq on public.registrations(phone_key);

-- ---------- Packages can belong to a company OR an individual ----------
alter table public.shipments add column if not exists registration_id uuid references public.registrations(id) on delete restrict;
create index if not exists shipments_registration_idx on public.shipments(registration_id, updated_at desc);
do $$ begin
  alter table public.shipments add constraint shipments_one_owner check (not (company_id is not null and registration_id is not null));
exception when duplicate_object then null; end $$;

create or replace function public.shipment_company_name()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.company_id is not null then
    select name into new.customer_name from public.companies where id = new.company_id;
  elsif new.registration_id is not null then
    select full_name || ' (' || customer_no || ')' into new.customer_name from public.registrations where id = new.registration_id;
  end if;
  return new;
end; $$;
create or replace trigger shipments_company_name before insert or update of company_id, registration_id on public.shipments
  for each row execute function public.shipment_company_name();

create or replace function public.registrations_rename_shipments()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.full_name is distinct from old.full_name then
    update public.shipments set customer_name = new.full_name || ' (' || new.customer_no || ')' where registration_id = new.id;
  end if;
  return null;
end; $$;
revoke all on function public.registrations_rename_shipments() from public, anon, authenticated;
create or replace trigger registrations_rename after update of full_name on public.registrations
  for each row execute function public.registrations_rename_shipments();

-- ---------- Sessions (only reachable through the functions below) ----------
create table if not exists public.consumer_sessions (
  token text primary key,
  registration_id uuid not null references public.registrations(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '60 days'
);
alter table public.consumer_sessions enable row level security;

create or replace function public.consumer_new_session(p_reg uuid)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare t text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  delete from public.consumer_sessions where expires_at < now();
  insert into public.consumer_sessions(token, registration_id) values (t, p_reg);
  return t;
end; $$;
revoke all on function public.consumer_new_session(uuid) from public, anon, authenticated;

create or replace function public.consumer_from_token(p_token text)
returns uuid language sql stable security definer set search_path = '' as $$
  select registration_id from public.consumer_sessions where token = p_token and expires_at > now();
$$;
revoke all on function public.consumer_from_token(text) from public, anon, authenticated;

create or replace function public.check_pin(p_pin text)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_pin is null or p_pin !~ '^\d{4,6}$' then raise exception 'Your PIN must be 4 to 6 digits.'; end if;
end; $$;
revoke all on function public.check_pin(text) from public, anon, authenticated;

-- ---------- Public account functions ----------
-- Register with a PIN and sign in straight away
create or replace function public.consumer_register(p_name text, p_phone text, p_pin text, p_email text default null, p_city text default null, p_shops text default null)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare
  n text := nullif(trim(p_name), '');
  ph text := nullif(regexp_replace(trim(coalesce(p_phone,'')), '\s+', ' ', 'g'), '');
  em text := nullif(lower(trim(coalesce(p_email,''))), '');
  rid uuid;
begin
  if n is null or length(n) < 2 or length(n) > 120 then raise exception 'Please enter your full name.'; end if;
  if ph is null or length(regexp_replace(ph, '\D', '', 'g')) < 9 or length(ph) > 30 then raise exception 'Please enter a valid phone number.'; end if;
  if em is not null and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Please enter a valid email address, or leave it empty.'; end if;
  perform public.check_pin(p_pin);
  if exists (select 1 from public.registrations where phone_key = right(regexp_replace(ph,'\D','','g'), 9)) then
    raise exception 'This phone number is already registered. Sign in to My account instead.';
  end if;
  insert into public.registrations(full_name, phone, email, city, shops, pin_hash)
  values (n, ph, em, nullif(trim(coalesce(p_city,'')),''), left(nullif(trim(coalesce(p_shops,'')),''),300), extensions.crypt(p_pin, extensions.gen_salt('bf')))
  returning id into rid;
  return json_build_object('token', public.consumer_new_session(rid));
end; $$;

-- Sign in with phone + PIN. 5 wrong PINs in a row lock the account for 15 minutes.
create or replace function public.consumer_login(p_phone text, p_pin text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare r public.registrations%rowtype;
begin
  select * into r from public.registrations
   where phone_key = right(regexp_replace(coalesce(p_phone,''),'\D','','g'), 9)
     and length(regexp_replace(coalesce(p_phone,''),'\D','','g')) >= 9;
  if not found then return json_build_object('error','not_registered'); end if;
  if r.pin_hash is null then return json_build_object('error','needs_pin'); end if;
  if r.locked_until is not null and r.locked_until > now() then return json_build_object('error','locked'); end if;
  if r.pin_hash <> extensions.crypt(coalesce(p_pin,''), r.pin_hash) then
    update public.registrations set failed_logins = failed_logins + 1,
      locked_until = case when failed_logins + 1 >= 5 then now() + interval '15 minutes' else null end
    where id = r.id;
    return json_build_object('error', case when r.failed_logins + 1 >= 5 then 'locked' else 'wrong_pin' end);
  end if;
  update public.registrations set failed_logins = 0, locked_until = null where id = r.id;
  return json_build_object('token', public.consumer_new_session(r.id));
end; $$;

-- First sign-in for people who registered before PINs existed, or after the admin reset their PIN
create or replace function public.consumer_set_first_pin(p_phone text, p_pin text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare rid uuid;
begin
  perform public.check_pin(p_pin);
  update public.registrations set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf')), failed_logins = 0, locked_until = null
   where phone_key = right(regexp_replace(coalesce(p_phone,''),'\D','','g'), 9) and pin_hash is null
   returning id into rid;
  if rid is null then raise exception 'This account already has a PIN. Sign in with it instead.'; end if;
  return json_build_object('token', public.consumer_new_session(rid));
end; $$;

-- Everything the account page shows: profile, addresses, packages with updates
create or replace function public.consumer_me(p_token text)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'profile', json_build_object('customer_no', r.customer_no, 'full_name', r.full_name, 'phone', r.phone, 'email', r.email,
                                 'city', r.city, 'shops', r.shops, 'created_at', r.created_at),
    'addresses', (select json_agg(json_build_object('id', a.id, 'label', a.label, 'lines', a.lines) order by a.sort) from public.shipping_addresses a),
    'packages', coalesce((
      select json_agg(json_build_object(
        'tracking_no', s.tracking_no, 'description', s.description, 'origin', s.origin, 'destination', s.destination,
        'pieces', s.pieces, 'weight_kg', s.weight_kg, 'status', s.status, 'eta', s.eta, 'customer_note', s.customer_note,
        'created_at', s.created_at, 'updated_at', s.updated_at,
        'events', coalesce((select json_agg(json_build_object('status', e.status, 'location', e.location, 'note', e.note, 'happened_at', e.happened_at)
                                            order by e.happened_at desc, e.created_at desc)
                            from public.shipment_events e where e.shipment_id = s.id), '[]'::json)
      ) order by s.updated_at desc)
      from public.shipments s where s.registration_id = r.id), '[]'::json)
  )
  from public.registrations r where r.id = public.consumer_from_token(p_token);
$$;

create or replace function public.consumer_update_profile(p_token text, p_name text, p_email text, p_city text, p_shops text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare rid uuid := public.consumer_from_token(p_token);
  n text := nullif(trim(p_name), ''); em text := nullif(lower(trim(coalesce(p_email,''))), '');
begin
  if rid is null then raise exception 'Your session has ended. Please sign in again.'; end if;
  if n is null or length(n) < 2 or length(n) > 120 then raise exception 'Please enter your full name.'; end if;
  if em is not null and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Please enter a valid email address, or leave it empty.'; end if;
  update public.registrations set full_name = n, email = em,
    city = left(nullif(trim(coalesce(p_city,'')),''),80), shops = left(nullif(trim(coalesce(p_shops,'')),''),300)
  where id = rid;
  return public.consumer_me(p_token);
end; $$;

create or replace function public.consumer_change_pin(p_token text, p_old text, p_new text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare rid uuid := public.consumer_from_token(p_token); h text;
begin
  if rid is null then raise exception 'Your session has ended. Please sign in again.'; end if;
  select pin_hash into h from public.registrations where id = rid;
  if h is null or h <> extensions.crypt(coalesce(p_old,''), h) then raise exception 'Your current PIN is not correct.'; end if;
  perform public.check_pin(p_new);
  update public.registrations set pin_hash = extensions.crypt(p_new, extensions.gen_salt('bf')) where id = rid;
  delete from public.consumer_sessions where registration_id = rid and token <> p_token; -- sign out other devices
  return true;
end; $$;

create or replace function public.consumer_logout(p_token text)
returns boolean language sql volatile security definer set search_path = '' as $$
  delete from public.consumer_sessions where token = p_token returning true;
$$;

-- Admin: clear a customer's PIN so they choose a new one at their next sign-in
create or replace function public.admin_reset_pin(p_reg uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  update public.registrations set pin_hash = null, failed_logins = 0, locked_until = null where id = p_reg;
  delete from public.consumer_sessions where registration_id = p_reg;
  return true;
end; $$;

do $$ declare f text; begin
  foreach f in array array['consumer_register(text,text,text,text,text,text)','consumer_login(text,text)','consumer_set_first_pin(text,text)',
    'consumer_me(text)','consumer_update_profile(text,text,text,text,text)','consumer_change_pin(text,text,text)','consumer_logout(text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
revoke all on function public.admin_reset_pin(uuid) from public, anon;
grant execute on function public.admin_reset_pin(uuid) to authenticated;
