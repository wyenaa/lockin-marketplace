// LockIn — Supabase client
// Digunakan oleh semua modul backend untuk akses database.
import ws from 'ws';
if (!globalThis.WebSocket) {
  globalThis.WebSocket = ws;
}

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('[Supabase] SUPABASE_URL atau SUPABASE_SERVICE_ROLE_KEY belum diisi di .env — database tidak aktif.');
}

export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    })
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

// Login/pendaftaran menggunakan client anon terpisah. Jangan gunakan client
// service_role untuk signInWithPassword: sesi pengguna bisa menggantikan
// authorization header untuk seluruh query database berikutnya.
export function createUserAuthClient() {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('SUPABASE_ANON_KEY belum dikonfigurasi untuk login.');
  }
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}
