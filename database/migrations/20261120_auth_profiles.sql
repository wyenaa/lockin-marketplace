-- Bootstrap akun yang SUDAH dibuat di Supabase Authentication.
-- Jalankan melalui SQL Editor setelah memeriksa email dan role yang benar.
-- Jangan pernah menentukan admin/vendor secara otomatis dari user_metadata;
-- metadata tersebut tidak boleh menjadi dasar otorisasi.
-- 1. Tinjau dahulu akun (hasilnya jangan dibagikan ke orang lain):
SELECT id, email, raw_user_meta_data->>'role' AS claimed_role
FROM auth.users ORDER BY created_at;

-- 2. Ganti email pada VALUES berikut dengan ketiga akun yang BENAR.
-- Role pada VALUES adalah keputusan admin proyek, bukan role yang dikirim user.
-- Jika belum siap mengisi ketiganya, JANGAN jalankan INSERT ini.
WITH approved_accounts (email, role) AS (
  VALUES
    ('user@lockin.demo', 'customer'),
    ('vendor@lockin.demo', 'vendor'),
    ('admin@lockin.demo', 'admin')
)
INSERT INTO public.users (id, name, email, role)
SELECT a.id,
       COALESCE(NULLIF(a.raw_user_meta_data->>'name',''), split_part(a.email,'@',1)),
       a.email, p.role
FROM auth.users AS a
JOIN approved_accounts AS p ON lower(p.email) = lower(a.email)
WHERE p.role IN ('customer','vendor','admin')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, email = EXCLUDED.email, role = EXCLUDED.role;

-- 3. Hak minimal untuk service_role mengelola profil dan sesi backend.
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT ON public.users TO service_role;
GRANT SELECT, INSERT, DELETE ON public.sessions TO service_role;

-- 4. Validasi setelah bootstrap:
SELECT role, count(*) AS jumlah FROM public.users GROUP BY role ORDER BY role;
