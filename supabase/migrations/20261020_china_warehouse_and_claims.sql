-- JustBuy: China warehouse address, warehouse intake, package claims with two-way matching.
-- Already applied to the JustBuy Shipments project on 2026-10-20; kept here for the record.

insert into public.shipping_addresses(id,label,sort,lines) values
('cn','China',0,'[
  {"label":"Recipient 收件人","value":"众达泛非空运"},
  {"label":"Phone 电话","value":"13622206244"},
  {"label":"Address 收件地址","value":"广东省广州市白云区凤和东路81号4栋101坦桑仓"}
]')
on conflict (id) do update set label = excluded.label, sort = excluded.sort, lines = excluded.lines;

-- Case, spaces and dashes don't matter when comparing tracking numbers
create or replace function public.norm_tracking(t text)
returns text language sql immutable set search_path = '' as $$
  select nullif(upper(regexp_replace(coalesce(t,''), '[^A-Za-z0-9]', '', 'g')), '');
$$;

create table if not exists public.warehouse_intake (
  id uuid primary key default gen_random_uuid(),
  warehouse text not null default 'cn' references public.shipping_addresses(id),
  supplier_tracking text not null,
  tracking_key text generated always as (public.norm_tracking(supplier_tracking)) stored,
  description text, pieces int, weight_kg numeric(10,2),
  received_at timestamptz not null default now(),
  notes text,
  created_at timestamptz not null default now()
);
create unique index if not exists warehouse_intake_key_uniq on public.warehouse_intake(tracking_key);
alter table public.warehouse_intake enable row level security;
create policy "admins manage intake" on public.warehouse_intake
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

create table if not exists public.package_claims (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.registrations(id) on delete restrict,
  supplier_tracking text not null check (length(supplier_tracking) between 4 and 60),
  tracking_key text generated always as (public.norm_tracking(supplier_tracking)) stored,
  description text check (description is null or length(description) <= 200),
  status text not null default 'requested' check (status in ('requested','found','shipped','rejected')),
  intake_id uuid references public.warehouse_intake(id) on delete restrict,
  shipment_id uuid references public.shipments(id) on delete restrict,
  admin_note text,
  created_at timestamptz not null default now(),
  found_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index if not exists package_claims_once_per_customer on public.package_claims(registration_id, tracking_key);
create index if not exists package_claims_key_idx on public.package_claims(tracking_key);
create index if not exists package_claims_reg_idx on public.package_claims(registration_id, created_at desc);
alter table public.package_claims enable row level security;
create policy "admins manage claims" on public.package_claims
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- Matching (a parcel matches only ONE claim, the earliest; later claims on the same number wait for the admin)
create or replace function public.claims_match_on_claim()
returns trigger language plpgsql security definer set search_path = '' as $$
declare iid uuid;
begin
  if new.status = 'requested' and new.intake_id is null then
    select w.id into iid from public.warehouse_intake w
     where w.tracking_key = public.norm_tracking(new.supplier_tracking)
       and not exists (select 1 from public.package_claims c where c.intake_id = w.id and c.id <> new.id and c.status <> 'rejected')
     limit 1;
    if iid is not null then new.intake_id := iid; new.status := 'found'; new.found_at := now(); end if;
  end if;
  new.updated_at := now();
  return new;
end; $$;
revoke all on function public.claims_match_on_claim() from public, anon, authenticated;
create or replace trigger claims_match before insert or update on public.package_claims
  for each row execute function public.claims_match_on_claim();

create or replace function public.claims_match_on_intake()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.package_claims c where c.intake_id = new.id and c.status <> 'rejected') then
    update public.package_claims set intake_id = new.id, status = 'found', found_at = now()
     where id = (select id from public.package_claims
                  where tracking_key = new.tracking_key and status = 'requested' and intake_id is null
                  order by created_at limit 1);
  end if;
  return null;
end; $$;
revoke all on function public.claims_match_on_intake() from public, anon, authenticated;
create or replace trigger intake_match after insert or update of supplier_tracking on public.warehouse_intake
  for each row execute function public.claims_match_on_intake();

-- Customer functions: consumer_claims, consumer_submit_claim, consumer_withdraw_claim
-- and notif_items (now also returns "Package found" for claims) — see the live database for full bodies;
-- they match what PR "China warehouse, sidebar navigation and package claims" describes.
