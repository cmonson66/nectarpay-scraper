import { createClient } from '@supabase/supabase-js';

// dotenv is optional -- if the repo loads env another way, skip it silently.
try {
  await import('dotenv/config');
} catch {
  /* no dotenv installed */
}

function pick(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

export function getSupabase() {
  const url = pick('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_PROJECT_URL');
  const key = pick('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_KEY');

  if (!url || !key) {
    throw new Error(
      'Missing Supabase credentials. Expected SUPABASE_URL and ' +
        'SUPABASE_SERVICE_ROLE_KEY in .env (aliases are also accepted).'
    );
  }

  return createClient(url, key, { auth: { persistSession: false } });
}

export function getPlacesKey() {
  const key = pick('GOOGLE_PLACES_API_KEY', 'GOOGLE_MAPS_API_KEY', 'PLACES_API_KEY', 'GOOGLE_API_KEY');
  if (!key) {
    throw new Error(
      'Missing Google Places key. Expected GOOGLE_PLACES_API_KEY or GOOGLE_MAPS_API_KEY in .env.'
    );
  }
  return key;
}

/**
 * Page through a table with a stable sort key. The `.order(orderBy)`
 * tiebreaker is deliberate: bulk-inserted rows share created_at, and without
 * a unique ordering column .range() pages overlap and skip.
 */
export async function fetchAll(supabase, table, columns, { orderBy = 'id', pageSize = 1000, filter } = {}) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    let q = supabase
      .from(table)
      .select(columns)
      .order(orderBy, { ascending: true })
      .range(from, from + pageSize - 1);

    if (typeof filter === 'function') q = filter(q);

    const { data, error } = await q;
    if (error) throw new Error(`fetchAll(${table}): ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}
