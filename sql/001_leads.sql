-- NectarPay leads table. Run once in Supabase SQL editor.
create table if not exists public.nectarpay_leads (
  place_id text primary key,
  name text not null,
  address text,
  city text,
  phone text,
  website text,
  emails text[] default '{}',
  rating numeric,
  review_count integer default 0,
  vertical text,
  vertical_label text,
  source_query text,
  score integer default 0,
  band text check (band in ('HOT','WARM','COOL')),
  scraped_at timestamptz,
  -- Eric's pipeline fields: scraper NEVER touches these on re-run
  status text default 'NEW' check (status in ('NEW','EMAILED','VISITED','MEETING','CLOSED_WON','CLOSED_LOST','DO_NOT_CONTACT')),
  notes text,
  assigned_to text default 'Eric',
  updated_at timestamptz default now()
);

create index if not exists idx_leads_band on public.nectarpay_leads (band);
create index if not exists idx_leads_vertical on public.nectarpay_leads (vertical);
create index if not exists idx_leads_status on public.nectarpay_leads (status);

-- Keep updated_at fresh
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_leads_touch on public.nectarpay_leads;
create trigger trg_leads_touch
  before update on public.nectarpay_leads
  for each row execute function public.touch_updated_at();
