// LockIn — Vendor catalog used by the local fallback. Supabase remains authoritative when configured.
import { supabase } from './supabase.js';

export const DEMO_VENDOR_OWNER_ID = 'd9d01426-73a7-43e6-86fe-d296b200d0b1';

export const DEMO_VENDORS = [
  { id: 'e0000000-0000-4000-8000-000000000001', name: 'Lolita Makeup', category: 'MUA', city: 'Malang', instagram: '', whatsapp: 'lolitamakeup.id', price: 199000, price_max: 349000, price_type: 'listed', deposit: 0, rating: 4.9, completed: 48, verified: true, color: 'gold', description: 'Wisuda: makeup 249rb, +hairdo 349rb. Bundling ibu dan anak mulai 399rb. Home service Malang Raya.' },
  { id: 'e0000000-0000-4000-8000-000000000002', name: 'Makeup Rinsil', category: 'MUA', city: 'Malang', instagram: '', whatsapp: 'bridestory.com/makeup-rinsil', price: 250000, price_max: 250000, price_type: 'estimate', deposit: 0, rating: 4.9, completed: 48, verified: true, color: 'pink', description: 'Soft makeup wisuda elegan, hijabdo simple termasuk. Free home service Malang Kota.' },
  { id: 'e0000000-0000-4000-8000-000000000003', name: 'Magda MUA', category: 'MUA', city: 'Malang', instagram: '', whatsapp: 'magdamua.com', price: 500000, price_max: 500000, price_type: 'listed', deposit: 0, rating: 4.9, completed: 48, verified: true, color: 'purple', description: 'Makeup photoshoot dan graduation premium. Tahan lama seharian.' },
  { id: 'e0000000-0000-4000-8000-000000000004', name: 'Hijab Do Malang', category: 'Hijab & Hair Stylist', city: 'Malang', instagram: 'hijabdo.malang', whatsapp: '', price: 150000, price_max: 150000, price_type: 'contact', deposit: 0, rating: 4.9, completed: 48, verified: true, color: 'green', description: 'Certified personal stylist wisuda. Hijab rapi, styling modern, tepat waktu.' },
  { id: 'e0000000-0000-4000-8000-000000000005', name: 'Lolita Makeup (add-on hairdo)', category: 'Hijab & Hair Stylist', city: 'Malang', instagram: '', whatsapp: 'lolitamakeup.id/harga', price: 100000, price_max: 150000, price_type: 'listed', deposit: 0, rating: 4.9, completed: 48, verified: true, color: 'green', description: 'Hairdo 100-150rb. Hijabdo simple sudah termasuk di paket wisuda.' },
  { id: 'e0000000-0000-4000-8000-000000000006', name: 'Dokumentasi Wisuda (Foto Wisuda Outdoor)', category: 'GCC', city: 'Malang', instagram: 'dokumentasiwisuda', whatsapp: '', price: 250000, price_max: 250000, price_type: 'listed', deposit: 0, rating: 4.9, completed: 48, verified: true, color: 'blue', description: 'Foto wisuda outdoor estetik, personal dan grup wisudawan.' },
  { id: 'e0000000-0000-4000-8000-000000000007', name: 'Moment Graduation', category: 'GCC', city: 'Malang', instagram: 'moment.graduation', whatsapp: '', price: 350000, price_max: 350000, price_type: 'contact', deposit: 0, rating: 4.9, completed: 48, verified: true, color: 'blue', description: 'Foto-video pre, day, post graduation. Malang dan Surabaya.' },
  { id: 'e0000000-0000-4000-8000-000000000008', name: 'Glow Studio PA (Pendamping Wisuda)', category: 'PA Wisuda', city: 'Malang', instagram: '', whatsapp: 'glowstudio.id', price: 300000, price_max: 300000, price_type: 'estimate', deposit: 0, rating: 4.9, completed: 48, verified: true, color: 'pink', description: 'Pendampingan wisuda wisudawan mandiri: handle toga, perlengkapan, dan pendampingan seharian.' },
  { id: 'e0000000-0000-4000-8000-000000000009', name: 'Arbeya Flo', category: 'Standing Sign', city: 'Malang', instagram: 'arbeya.flo', whatsapp: '', price: 75000, price_max: 75000, price_type: 'contact', deposit: 100000, rating: 4.9, completed: 48, verified: true, color: 'purple', description: 'Sewa dan jual papan akrilik wisuda custom nama dan ucapan, free antar.' }
];

/** Optional bootstrap helper; matches existing vendor by name/category to preserve its UUID. */
export async function seedVendors(vendorUserId = DEMO_VENDOR_OWNER_ID) {
  if (!supabase) return;
  for (const vendor of DEMO_VENDORS) {
    const { data: existing, error: readError } = await supabase.from('vendors').select('id').ilike('name', vendor.name).maybeSingle();
    if (readError) throw new Error(`Gagal memeriksa vendor ${vendor.name}: ${readError.message}`);
    const { id: _seedId, ...fields } = vendor;
    const result = existing
      ? await supabase.from('vendors').update({ ...fields, owner_id: vendorUserId }).eq('id', existing.id)
      : await supabase.from('vendors').insert({ ...vendor, owner_id: vendorUserId });
    const { error } = result;
    if (error) throw new Error(`Gagal menyimpan vendor ${vendor.name}: ${error.message}`);
  }
}
