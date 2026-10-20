-- JustBuy: China shipping methods, method on claims/packages, charges + paid status per package.
-- Already applied to the JustBuy Shipments project on 2026-10-20; kept here for the record.

create table if not exists public.shipping_methods (
  id text primary key,
  warehouse text not null references public.shipping_addresses(id),
  name text not null, cargo text not null,
  tiers jsonb not null,           -- [{min_kg, max_kg|null, usd_per_kg}]
  eta text not null, dispatch_days text not null,
  sort int not null default 0, active boolean not null default true
);
alter table public.shipping_methods enable row level security;
create policy "everyone reads active methods" on public.shipping_methods for select to anon, authenticated using (active);
create policy "admins manage methods" on public.shipping_methods for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

insert into public.shipping_methods(id,warehouse,name,cargo,tiers,eta,dispatch_days,sort) values
('cn_direct','cn','Direct Next-Day Delivery','General cargo or sensitive goods','[{"min_kg":0,"max_kg":null,"usd_per_kg":18}]','1–2 working days after dispatch','Tuesday, Thursday & Saturday',1),
('cn_express_general','cn','Ordinary Express — General Cargo','General cargo','[{"min_kg":0,"max_kg":100,"usd_per_kg":12},{"min_kg":100,"max_kg":300,"usd_per_kg":11.5},{"min_kg":300,"max_kg":500,"usd_per_kg":13},{"min_kg":500,"max_kg":1000,"usd_per_kg":10.5},{"min_kg":1000,"max_kg":null,"usd_per_kg":12}]','6–8 working days after dispatch','Tuesday & Friday',2),
('cn_express_sensitive','cn','Ordinary Express — Sensitive Goods','Sensitive goods','[{"min_kg":0,"max_kg":null,"usd_per_kg":17.5}]','7–12 working days after dispatch','Thursday & Sunday',3)
on conflict (id) do nothing;

create table if not exists public.shipping_settings (key text primary key, value jsonb not null);
alter table public.shipping_settings enable row level security;
create policy "everyone reads settings" on public.shipping_settings for select to anon, authenticated using (true);
create policy "admins manage settings" on public.shipping_settings for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
insert into public.shipping_settings values ('cn_high_value_surcharge_usd_per_item', '20') on conflict do nothing;

alter table public.package_claims add column if not exists shipping_method text references public.shipping_methods(id);
alter table public.shipments
  add column if not exists shipping_method text references public.shipping_methods(id),
  add column if not exists charge_amount numeric(12,2),
  add column if not exists charge_currency text not null default 'USD' check (charge_currency in ('USD','TZS')),
  add column if not exists charge_note text,
  add column if not exists paid boolean not null default false,
  add column if not exists paid_at timestamptz;

-- Functions changed/added (full bodies are in the live database):
--   consumer_claims(token)                          + shipping_method, shipping_method_name
--   consumer_submit_claim(token, tracking, desc, method)   method required; old 3-argument version revoked
--   consumer_set_claim_method(token, claim, method) while Request sent / Package found
--   consumer_me(token)                              packages + shipping method, charges, paid, paid_at
--   trigger shipments_paid_at                       sets/clears paid_at with the paid flag
