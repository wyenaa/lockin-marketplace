-- LockIn's canonical 9-vendor demo catalog.
-- Run manually after database/schemas/schema.sql and the auth profile bootstrap.
-- Existing matching vendors keep their UUID (including Makeup Rinsil); no bookings are updated.
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS city TEXT NOT NULL DEFAULT 'Malang';
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS instagram TEXT;
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS whatsapp TEXT;
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS price_max INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS price_type TEXT NOT NULL DEFAULT 'listed';
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS package_id TEXT;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS package_name TEXT;

DO $$
DECLARE
  demo_owner UUID;
  v RECORD;
  existing_id UUID;
BEGIN
  SELECT id INTO demo_owner
  FROM public.users
  WHERE lower(email) = lower('vendor@lockin.demo') AND role = 'vendor'
  LIMIT 1;
  IF demo_owner IS NULL THEN
    RAISE EXCEPTION 'Profil public.users untuk vendor@lockin.demo belum tersedia. Jalankan bootstrap auth yang sudah diperiksa terlebih dahulu.';
  END IF;

  FOR v IN
    SELECT * FROM (VALUES
      ('e0000000-0000-4000-8000-000000000001'::uuid, 'Lolita Makeup', 'MUA', 'Malang', '', 'lolitamakeup.id', 199000, 349000, 'listed', 0, 4.9::real, 'gold', 'Wisuda: makeup 249rb, +hairdo 349rb. Bundling ibu dan anak mulai 399rb. Home service Malang Raya.'),
      ('e0000000-0000-4000-8000-000000000002'::uuid, 'Makeup Rinsil', 'MUA', 'Malang', '', 'bridestory.com/makeup-rinsil', 250000, 250000, 'estimate', 0, 4.9::real, 'pink', 'Soft makeup wisuda elegan, hijabdo simple termasuk. Free home service Malang Kota.'),
      ('e0000000-0000-4000-8000-000000000003'::uuid, 'Magda MUA', 'MUA', 'Malang', '', 'magdamua.com', 500000, 500000, 'listed', 0, 4.9::real, 'purple', 'Makeup photoshoot dan graduation premium. Tahan lama seharian.'),
      ('e0000000-0000-4000-8000-000000000004'::uuid, 'Hijab Do Malang', 'Hijab & Hair Stylist', 'Malang', 'hijabdo.malang', '', 150000, 150000, 'contact', 0, 4.9::real, 'green', 'Certified personal stylist wisuda. Hijab rapi, styling modern, tepat waktu.'),
      ('e0000000-0000-4000-8000-000000000005'::uuid, 'Lolita Makeup (add-on hairdo)', 'Hijab & Hair Stylist', 'Malang', '', 'lolitamakeup.id/harga', 100000, 150000, 'listed', 0, 4.9::real, 'green', 'Hairdo 100-150rb. Hijabdo simple sudah termasuk di paket wisuda.'),
      ('e0000000-0000-4000-8000-000000000006'::uuid, 'Dokumentasi Wisuda (Foto Wisuda Outdoor)', 'GCC', 'Malang', 'dokumentasiwisuda', '', 250000, 250000, 'listed', 0, 4.9::real, 'blue', 'Foto wisuda outdoor estetik, personal dan grup wisudawan.'),
      ('e0000000-0000-4000-8000-000000000007'::uuid, 'Moment Graduation', 'GCC', 'Malang', 'moment.graduation', '', 350000, 350000, 'contact', 0, 4.9::real, 'blue', 'Foto-video pre, day, post graduation. Malang dan Surabaya.'),
      ('e0000000-0000-4000-8000-000000000008'::uuid, 'Glow Studio PA (Pendamping Wisuda)', 'PA Wisuda', 'Malang', '', 'glowstudio.id', 300000, 300000, 'estimate', 0, 4.9::real, 'pink', 'Pendampingan wisuda wisudawan mandiri: handle toga, perlengkapan, dan pendampingan seharian.'),
      ('e0000000-0000-4000-8000-000000000009'::uuid, 'Arbeya Flo', 'Standing Sign', 'Malang', 'arbeya.flo', '', 75000, 75000, 'contact', 100000, 4.9::real, 'purple', 'Sewa dan jual papan akrilik wisuda custom nama dan ucapan, free antar.')
    ) AS catalog(id, name, category, city, instagram, whatsapp, price, price_max, price_type, deposit, rating, color, description)
  LOOP
    SELECT id INTO existing_id
    FROM public.vendors
    WHERE lower(trim(name)) = lower(trim(v.name))
    ORDER BY created_at NULLS LAST
    LIMIT 1;

    IF existing_id IS NULL THEN
      INSERT INTO public.vendors (id, owner_id, name, category, city, instagram, whatsapp, price, price_max, price_type, deposit, rating, completed, verified, color, description)
      VALUES (v.id, demo_owner, v.name, v.category, v.city, NULLIF(v.instagram, ''), NULLIF(v.whatsapp, ''), v.price, v.price_max, v.price_type, v.deposit, v.rating, 48, TRUE, v.color, v.description)
      ON CONFLICT (id) DO NOTHING;
    ELSE
      UPDATE public.vendors SET
        owner_id = demo_owner, name = v.name, category = v.category, city = v.city,
        instagram = NULLIF(v.instagram, ''), whatsapp = NULLIF(v.whatsapp, ''),
        price = v.price, price_max = v.price_max, price_type = v.price_type, deposit = v.deposit,
        rating = v.rating, completed = 48, verified = TRUE, color = v.color, description = v.description
      WHERE id = existing_id;
    END IF;
    existing_id := NULL;
  END LOOP;
END $$;

-- Review the catalog and UUIDs before enabling customer bookings.
SELECT id, name, category, city, price, price_max, owner_id
FROM public.vendors
WHERE name IN (
  'Lolita Makeup', 'Makeup Rinsil', 'Magda MUA', 'Hijab Do Malang',
  'Lolita Makeup (add-on hairdo)', 'Dokumentasi Wisuda (Foto Wisuda Outdoor)',
  'Moment Graduation', 'Glow Studio PA (Pendamping Wisuda)', 'Arbeya Flo'
)
ORDER BY created_at;
