-- JustBuy notifications (already applied to the JustBuy Shipments project on 2026-10-18; kept here for the record).
alter table public.registrations add column if not exists notif_seen_at timestamptz;
alter table public.companies add column if not exists notif_seen_at timestamptz;
create index if not exists shipment_events_created_idx on public.shipment_events(shipment_id, created_at desc);

create or replace function public.notif_items(p_reg uuid, p_company uuid)
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(x order by x.posted_at desc), '[]'::json) from (
    select s.tracking_no, s.description, e.status, e.location, e.note, e.happened_at, e.created_at as posted_at
    from public.shipment_events e join public.shipments s on s.id = e.shipment_id
    where (p_reg is not null and s.registration_id = p_reg) or (p_company is not null and s.company_id = p_company)
    order by e.created_at desc limit 60) x;
$$;
revoke all on function public.notif_items(uuid, uuid) from public, anon, authenticated;

create or replace function public.consumer_notifications(p_token text)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('seen_at', r.notif_seen_at, 'items', public.notif_items(r.id, null))
  from public.registrations r where r.id = public.consumer_from_token(p_token);
$$;
create or replace function public.consumer_mark_notifications_read(p_token text)
returns timestamptz language sql volatile security definer set search_path = '' as $$
  update public.registrations set notif_seen_at = now() where id = public.consumer_from_token(p_token) returning notif_seen_at;
$$;
create or replace function public.company_notifications(p_code text)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('seen_at', c.notif_seen_at, 'items', public.notif_items(null, c.id))
  from public.companies c
  where c.active and length(trim(p_code)) >= 12 and upper(replace(trim(p_code), ' ', '')) = c.access_code;
$$;
create or replace function public.company_mark_notifications_read(p_code text)
returns timestamptz language sql volatile security definer set search_path = '' as $$
  update public.companies set notif_seen_at = now()
  where active and length(trim(p_code)) >= 12 and upper(replace(trim(p_code), ' ', '')) = access_code
  returning notif_seen_at;
$$;
do $$ declare f text; begin
  foreach f in array array['consumer_notifications(text)','consumer_mark_notifications_read(text)','company_notifications(text)','company_mark_notifications_read(text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
