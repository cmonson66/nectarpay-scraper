-- ============================================================================
-- 017_crypto_signals.sql
-- Crypto adoption signal layer for NectarPay lead scoring.
--
-- SAFETY NOTE: this migration is ADDITIVE ONLY.
--   - no DROP, no DELETE, no TRUNCATE, no UPDATE of existing rows
--   - every statement is IF NOT EXISTS / CREATE OR REPLACE
--   - wrapped in a single transaction; if any statement fails, nothing lands
-- Run it in the Supabase SQL editor against the nectarpay project.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Signal table: every known crypto touchpoint in AZ (ATMs + accepting shops)
-- ---------------------------------------------------------------------------
create table if not exists crypto_signals (
  id            bigserial primary key,
  source        text not null,                 -- 'google_places' | 'osm'
  source_id     text not null,                 -- Places id, or 'node/123456'
  signal_type   text not null,                 -- 'atm' | 'merchant'
  name          text,
  brand         text,                          -- Bitcoin Depot, CoinFlip, ...
  address       text,
  city          text,
  lat           double precision not null,
  lng           double precision not null,
  weight        numeric not null default 1,
  raw           jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  constraint crypto_signals_source_key unique (source, source_id),
  constraint crypto_signals_type_chk check (signal_type in ('atm', 'merchant'))
);

create index if not exists crypto_signals_lat_lng_idx on crypto_signals (lat, lng);
create index if not exists crypto_signals_type_idx    on crypto_signals (signal_type);

-- ---------------------------------------------------------------------------
-- 2. Score columns on leads (nullable, so nothing existing is disturbed)
-- ---------------------------------------------------------------------------
alter table nectarpay_leads add column if not exists crypto_score           numeric;
alter table nectarpay_leads add column if not exists crypto_atm_count       integer;
alter table nectarpay_leads add column if not exists crypto_merchant_count  integer;
alter table nectarpay_leads add column if not exists crypto_nearest_atm_m   numeric;
alter table nectarpay_leads add column if not exists crypto_scored_at       timestamptz;

create index if not exists nectarpay_leads_crypto_score_idx
  on nectarpay_leads (crypto_score desc nulls last);

-- ---------------------------------------------------------------------------
-- 3. Bulk scoring RPC.
--    Keyed on place_id (text) rather than id, so it does not depend on the
--    surrogate key type. Touches ONLY the five crypto_* columns -- it can
--    never blank an email, a name, or Eric's status/notes.
-- ---------------------------------------------------------------------------
create or replace function apply_crypto_scores(payload jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  touched integer;
begin
  update nectarpay_leads l
     set crypto_score          = s.crypto_score,
         crypto_atm_count      = s.atm_count,
         crypto_merchant_count = s.merchant_count,
         crypto_nearest_atm_m  = s.nearest_atm_m,
         crypto_scored_at      = now()
    from jsonb_to_recordset(payload) as s(
           place_id       text,
           crypto_score   numeric,
           atm_count      integer,
           merchant_count integer,
           nearest_atm_m  numeric
         )
   where l.place_id = s.place_id;

  get diagnostics touched = row_count;
  return touched;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Convenience view: leads that are both high-fit AND in a crypto-dense area
-- ---------------------------------------------------------------------------
-- select * so this cannot fail on a column-name assumption
create or replace view crypto_priority_leads as
select *
  from nectarpay_leads
 where crypto_score is not null
   and crypto_score > 0
 order by crypto_score desc;

commit;

-- ============================================================================
-- Rollback (only if you want the layer gone -- destructive, run deliberately):
--
--   begin;
--   drop view if exists crypto_priority_leads;
--   drop function if exists apply_crypto_scores(jsonb);
--   alter table nectarpay_leads drop column if exists crypto_score;
--   alter table nectarpay_leads drop column if exists crypto_atm_count;
--   alter table nectarpay_leads drop column if exists crypto_merchant_count;
--   alter table nectarpay_leads drop column if exists crypto_nearest_atm_m;
--   alter table nectarpay_leads drop column if exists crypto_scored_at;
--   drop table if exists crypto_signals;
--   commit;
-- ============================================================================
