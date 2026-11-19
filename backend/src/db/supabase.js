// LockIn — Supabase client
// Digunakan oleh semua modul backend untuk akses database.
import ws from 'ws';
if (!globalThis.WebSocket) {
  globalThis.WebSocket = ws;
}

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('[Supabase] SUPABASE_URL atau SUPABASE_SERVICE_ROLE_KEY belum diisi di .env — database tidak aktif.');
}

export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;

/** Helper: jalankan query dan lempar error jika gagal */
export async function query(fn) {
  if (!supabase) throw new Error('Supabase belum dikonfigurasi.');
  const result = await fn(supabase);
  if (result.error) throw Object.assign(new Error(result.error.message), { status: 500 });
  return result.data;
}

/** Cek apakah Supabase terkonfigurasi */
export const isSupabaseConfigured = () => !!supabase;
