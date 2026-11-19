// LockIn — Seed data dan helper database (Supabase-aware)
// Menyediakan fungsi inisialisasi vendor + demo accounts di Supabase.
import { supabase } from './supabase.js';

export const DEMO_VENDORS = [
  { id: 1, name: 'Teman Wisuda',  category: 'PA Wisuda',          price: 250000, deposit: 0,      rating: 4.9, completed: 48, verified: true,  color: 'pink',   description: 'Pendamping wisuda seharian: bantu toga, barang bawaan, dan kebutuhan di hari istimewamu.' },
  { id: 2, name: 'Glow Graduation', category: 'GCC',              price: 450000, deposit: 0,      rating: 4.9, completed: 36, verified: true,  color: 'blue',   description: 'Dokumentasi foto dan video pendek wisuda. Termasuk 30 file edit dan satu kali revisi.' },
  { id: 3, name: 'Nara Beauty',   category: 'Hijab & Hair Stylist', price: 350000, deposit: 0,   rating: 4.8, completed: 52, verified: true,  color: 'green',  description: 'Hijab styling dan hair do untuk satu orang, satu hari. Tampil percaya diri di hari wisuda.' },
  { id: 4, name: 'Aurelia Makeup', category: 'MUA',               price: 500000, deposit: 0,      rating: 4.9, completed: 64, verified: true,  color: 'gold',   description: 'Makeup wisuda natural dan tahan lama, termasuk persiapan serta konsultasi tampilan.' },
  { id: 5, name: 'Ruang Akrilik', category: 'Standing Sign',      price: 150000, deposit: 100000, rating: 4.8, completed: 28, verified: true,  color: 'purple', description: 'Acrylic standing sign 40 × 60 cm, sewa satu hari. Nama dan teks disiapkan sebelum hari H.' },
  { id: 6, name: 'Cerita Kampus', category: 'GCC',                price: 375000, deposit: 0,      rating: 4.7, completed: 23, verified: true,  color: 'red',    description: 'Abadikan momen wisuda dengan foto dan video vertikal. Termasuk 20 file edit dan satu revisi.' },
];

/** Seed vendor demo ke Supabase jika belum ada */
export async function seedVendors(vendorUserId) {
  if (!supabase) return;
  const { data, error } = await supabase.from('vendors').select('id').limit(1);
  if (error || data?.length) return; // table not ready or already has data
  await supabase.from('vendors').insert(
    DEMO_VENDORS.map(({ id: _, ...v }) => ({ ...v, owner_id: vendorUserId }))
  );
  console.log('[Seed] Vendor demo berhasil ditambahkan ke Supabase.');
}
