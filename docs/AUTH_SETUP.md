# LockIn — Penyelarasan Login dan Hak Akses

- Login diproses melalui `POST /api/auth/login` dan Supabase Auth memakai **anon key**.
- Query database dan penyimpanan sesi menggunakan service-role client yang **terpisah**.
- Role dan nama pengguna dikembalikan dari `public.users`, bukan ditebak dari email atau `user_metadata.role`.
- Login dengan akun yang belum ada di `public.users` akan ditolak dengan pesan sinkronisasi profil.
- Pendaftaran mandiri selalu membuat akun **customer**; akun vendor dan admin ditetapkan oleh pengelola, bukan dari input user.
- Logout menghapus sesi server. Role di browser hanya mengatur tampilan; API tetap mengecek hak akses.

## Setup akun demo Supabase yang sudah dibuat

1. Pastikan `.env` server berisi `SUPABASE_URL`, `SUPABASE_ANON_KEY`, dan `SUPABASE_SERVICE_ROLE_KEY` milik proyek yang sama.
2. Di SQL Editor, buka `database/migrations/20261120_auth_profiles.sql`, baca dan isi tiga **email asli** pada `VALUES`. Pastikan masing-masing memang layak diberi role customer/vendor/admin.
3. Jalankan SQL tersebut. Periksa hasil query akhir: satu akun tiap role.
4. Restart backend, login melalui halaman `Masuk` menggunakan email dan password Supabase Auth yang sah.
5. Coba akses role lain: customer tidak boleh memanggil API admin/vendor yang membutuhkan otorisasi.

Jangan memasukkan SQL mentah dari seluruh `schema.sql` untuk memperbaiki login. Tabel `vendors` tetap memerlukan data vendor dan `owner_id` yang menunjuk pada `public.users.id` milik vendor.

**Catatan:** Jika email confirmation Supabase aktif, pelanggan perlu memverifikasi email sebelum bisa login. Pengujian otomatis lokal tidak menguji koneksi Supabase live.
