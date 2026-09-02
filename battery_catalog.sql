-- Run this once in the batteries Supabase project (mjaondxwicsbpibolraj)
-- via the SQL editor. This is a NEW table, separate from battery_specs -
-- battery_specs keeps working exactly as it does today (dimension/spec
-- lookup, populated lazily on first plate-search click, never bulk-
-- rewritten). battery_catalog is written wholesale every 12 hours by
-- catalog-sync.js and is what a new "search by name" feature reads from.

create table if not exists battery_catalog (
    sku text primary key,
    name text,
    category text,
    price_ex_gst numeric,
    price_incl_gst numeric,
    click_collect_price numeric,
    branch_stock boolean,
    national_stock boolean,
    image_url text,
    technology text,
    voltage text,
    cca integer,
    scraped_at timestamptz not null default now()
  );

-- Speeds up name/SKU search once this table has ~200 rows in it.
create index if not exists battery_catalog_name_idx on battery_catalog using gin (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(sku, '')));

-- RLS: same posture as the tyres table - service role (used by
-- catalog-sync.js) bypasses RLS entirely, and this table only needs to be
-- publicly READABLE (for the customer-facing search endpoint), never
-- publicly writable.
alter table battery_catalog enable row level security;

create policy "Public can read battery_catalog"
  on battery_catalog for select
  using (true);
