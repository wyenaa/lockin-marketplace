-- ============================================================
-- LockIn — Database Schema untuk Supabase (PostgreSQL)
-- Jalankan di: Supabase Dashboard → SQL Editor
-- ============================================================

-- Enable UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Users (extends Supabase Auth) ──────────────────────────
CREATE TABLE IF NOT EXISTS public.users (
  id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  email   TEXT UNIQUE NOT NULL,
  role    TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','vendor','admin')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Sessions ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sessions (
  token   TEXT PRIMARY KEY,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
  expires BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON public.sessions(user_id);

-- ── Vendors ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vendors (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id    UUID REFERENCES public.users(id),
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  price       INTEGER NOT NULL DEFAULT 0,
  deposit     INTEGER NOT NULL DEFAULT 0,
  rating      REAL DEFAULT 0,
  completed   INTEGER DEFAULT 0,
  verified    BOOLEAN DEFAULT FALSE,
  color       TEXT,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Bookings ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bookings (
  id                  TEXT PRIMARY KEY,
  user_id             UUID REFERENCES public.users(id),
  vendor_id           UUID REFERENCES public.vendors(id),
  event_date          TEXT NOT NULL,
  location            TEXT,
  start_time          TEXT,
  price               INTEGER NOT NULL,
  deposit             INTEGER DEFAULT 0,
  paid                INTEGER DEFAULT 0,
  state               TEXT NOT NULL DEFAULT 'Pending',
  late_booking        BOOLEAN DEFAULT FALSE,
  vendor_accepted_at  TIMESTAMPTZ,
  completion_evidence TEXT,
  off_platform_reported BOOLEAN DEFAULT FALSE,
  agreement           TEXT,
  hash                TEXT,
  expires             BIGINT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS bookings_user_id_idx    ON public.bookings(user_id);
CREATE INDEX IF NOT EXISTS bookings_vendor_id_idx  ON public.bookings(vendor_id);
CREATE INDEX IF NOT EXISTS bookings_state_idx      ON public.bookings(state);

-- ── Payments ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payments (
  id                TEXT PRIMARY KEY,
  booking_id        TEXT REFERENCES public.bookings(id),
  method            TEXT,
  amount            INTEGER NOT NULL,
  outcome           TEXT DEFAULT 'pending',
  payment_type      TEXT DEFAULT 'DP' CHECK (payment_type IN ('DP','FINAL')),
  provider_order_id TEXT,
  redirect_url      TEXT,
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payments_booking_id_idx ON public.payments(booking_id);
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_order_id_uidx ON public.payments(provider_order_id) WHERE provider_order_id IS NOT NULL;

-- ── Disputes & Sengketa ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.disputes (
  id                  TEXT PRIMARY KEY,
  booking_id          TEXT UNIQUE REFERENCES public.bookings(id),
  reason              TEXT NOT NULL,
  evidence            TEXT NOT NULL,
  evidence_url        TEXT,
  response            TEXT DEFAULT '',
  vendor_evidence_url TEXT,
  decision            TEXT,
  decision_reason     TEXT,
  refund              INTEGER DEFAULT 0,
  vendor_response_due TIMESTAMPTZ,
  decided_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── Bukti Kerja & Sengketa (Evidence Records) ───────────────
CREATE TABLE IF NOT EXISTS public.evidence_records (
  id          BIGSERIAL PRIMARY KEY,
  booking_id  TEXT REFERENCES public.bookings(id),
  uploader_id UUID REFERENCES public.users(id),
  role        TEXT NOT NULL CHECK (role IN ('customer', 'vendor', 'admin')),
  category    TEXT NOT NULL CHECK (category IN ('COMPLETION_PROOF', 'DISPUTE_PROOF', 'VENDOR_RESPONSE', 'OFF_PLATFORM_REPORT')),
  file_url    TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS evidence_booking_id_idx ON public.evidence_records(booking_id);

-- ── Audit Trail ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit (
  id          BIGSERIAL PRIMARY KEY,
  booking_id  TEXT REFERENCES public.bookings(id),
  state       TEXT NOT NULL,
  hash        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_booking_id_idx ON public.audit(booking_id);

-- ── Leads (vendor interest) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.leads (
  id         BIGSERIAL PRIMARY KEY,
  contact    TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Ledger (simulasi escrow) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ledger_entries (
  id          BIGSERIAL PRIMARY KEY,
  booking_id  TEXT REFERENCES public.bookings(id),
  payment_id  TEXT REFERENCES public.payments(id),
  entry_type  TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ledger_booking_id_idx ON public.ledger_entries(booking_id);

-- ── Blockchain Jobs (outbox queue) ──────────────────────────
CREATE TABLE IF NOT EXISTS public.blockchain_jobs (
  id          BIGSERIAL PRIMARY KEY,
  booking_id  TEXT REFERENCES public.bookings(id),
  payment_id  TEXT REFERENCES public.payments(id),
  status      TEXT NOT NULL DEFAULT 'QUEUED',
  tx_hash     TEXT,
  last_error  TEXT,
  retry_after BIGINT NOT NULL DEFAULT 0,
  UNIQUE(booking_id, payment_id)
);
CREATE INDEX IF NOT EXISTS blockchain_jobs_status_idx ON public.blockchain_jobs(status);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE public.users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendors        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disputes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blockchain_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads          ENABLE ROW LEVEL SECURITY;

-- Service role (backend) bypass RLS
-- Backend menggunakan SUPABASE_SERVICE_ROLE_KEY → akses penuh
-- Frontend client menggunakan ANON_KEY → terbatas oleh RLS

-- Vendors: semua bisa baca
CREATE POLICY "vendors_public_read" ON public.vendors FOR SELECT USING (TRUE);
-- Leads: siapa saja bisa insert
CREATE POLICY "leads_public_insert" ON public.leads FOR INSERT WITH CHECK (TRUE);
