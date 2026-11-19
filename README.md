# LockIn — Graduation Vendor Marketplace with Escrow & Blockchain Audit Trail

Website full stack berdasarkan delapan tampilan Figma LockIn: **landing page, katalog vendor, detail jasa/perjanjian, detail sewa standing sign, checkout, status booking, dashboard vendor, dan panel admin sengketa**. Aset SVG asli Figma disimpan di `frontend/public/assets`.

Proyek ini dikembangkan untuk Tugas Akhir mata kuliah **Teknologi Blockchain** dan **Platform Keuangan Digital**, Universitas Brawijaya.

---

## 🏗️ Struktur Proyek

```text
lockin-marketplace/
├── backend/                  # Server Node.js + Express REST API
│   ├── src/
│   │   ├── index.js          # HTTP server, routing, REST API, & file static
│   │   ├── db/
│   │   │   ├── supabase.js   # Client Supabase PostgreSQL & query helper
│   │   │   └── seed.js       # Seed data vendor & demo accounts
│   │   ├── services/
│   │   │   ├── midtrans.js   # Integrasi Snap payment, fetch status, & SHA-512
│   │   │   └── blockchain.js # Ethers.js & worker outbox Sepolia (setiap 15 dtk)
│   │   └── webhooks/
│   │       └── midtrans.js   # Webhook handler (idempotent, SHA-512 check)
│   ├── tests/                # Pengujian otomatis keamanan payment & signature
│   │   ├── midtrans.test.mjs
│   │   └── payment-security.test.mjs
│   └── package.json
│
├── frontend/                 # Client UI (Single Page Application)
│   ├── public/
│   │   ├── index.html        # Dokumen aplikasi utama
│   │   ├── app.js            # Routing, state machine, halaman, & interaksi API
│   │   ├── styles.css        # Token desain dan layout responsif Figma
│   │   └── assets/           # Aset SVG asli Figma & font lokal OFL
│   └── package.json
│
├── blockchain/               # Smart Contract (Solidity 0.8.24)
│   ├── contracts/
│   │   └── LockInEscrow.sol  # 1 Kontrak tunggal (DP, Pelunasan, & Status Update)
│   ├── DEPLOY.md             # Panduan deployment via Remix IDE & MetaMask
│   └── package.json
│
├── database/                 # Skema Database & Seed Data
│   ├── schemas/
│   │   └── schema.sql        # Skema tabel lengkap Supabase + RLS policies
│   └── seeds/
│       └── seed.sql          # Query SQL seed vendor contoh
│
├── docs/                     # Dokumentasi Lengkap
│   ├── BUSINESS_CASE.md      # Dokumen Business Case & Market Feasibility
│   ├── ARCHITECTURE.md       # Diagram arsitektur sistem
│   ├── DECISIONS.md          # Log keputusan arsitektur (ADR)
│   └── DEMO_CHECKLIST.md     # Panduan checklist skenario demo
│
├── audit-lockin.mjs          # Script audit konsistensi DB vs Sepolia on-chain
├── .env.example              # Template variabel konfigurasi
├── .gitignore                # Proteksi keamanan kredensial (.env diabaikan)
├── package.json              # Root npm workspace scripts
└── README.md
```

---

## 👥 Akun Demo

Aplikasi menyediakan 3 akun demo bawaan untuk pengujian alur peran secara langsung:

| Peran | Email | Password | Hak Akses |
| --- | --- | --- | --- |
| **Pelanggan** | `user@lockin.demo` | `LockInDemo123!` | Membuat booking, tanda tangan perjanjian digital, checkout DP & pelunasan, mengajukan keluhan/sengketa. |
| **Vendor** | `vendor@lockin.demo` | `LockInDemo123!` | Dashboard vendor, melihat pesanan masuk, menanggapi sengketa pelanggan. |
| **Admin** | `admin@lockin.demo` | `LockInDemo123!` | Panel admin, menengahi sengketa, memutuskan pelepasan dana atau persentase refund. |

> Klik **Masuk**, lalu klik tombol peran demo untuk langsung mencoba tanpa perlu registrasi ulang. Akun baru juga dapat didaftarkan sebagai pelanggan. Semua vendor contoh dimiliki oleh akun vendor demo.

---

## 🔄 Alur Utama Aplikasi

1. **Eksplorasi Katalog:** Cari vendor berdasarkan kategori (PA Wisuda, GCC/Fotografer, MUA, Stylist, Rental Standing Sign), kota Malang, dan tanggal acara. Urutkan berdasarkan harga atau rating.
2. **Kunci Kesepakatan (Digital Agreement):** Buka detail vendor, tentukan tanggal, jam mulai, dan lokasi acara. Pelanggan menyetujui perjanjian digital. Backend mengunci snapshot perjanjian, menghasilkan hash SHA-256 unik, menyimpan booking, dan menahan slot selama 24 jam.
3. **Pembayaran Bertahap (DP 30% & Pelunasan):** 
   - Jasa wisuda membayar DP 30% via Midtrans Snap (QRIS, Virtual Account BCA/BNI/BRI/Mandiri, atau E-Wallet).
   - Setelah DP berhasil terverifikasi via webhook, pelanggan dapat melakukan pelunasan sisa 70% sebelum tanggal acara.
   - Layanan sewa (standing sign) membayar biaya sewa dan deposit jaminan sekaligus.
4. **Pencatatan Bukti On-Chain (Blockchain):** Setiap pembayaran DP dan pelunasan yang valid otomatis diproses oleh antrian worker dan dicatat ke smart contract Ethereum Sepolia (`LockInEscrow.sol`). Tautan transaksi dapat langsung diverifikasi di Etherscan.
5. **Dashboard & Konfirmasi Selesai:** Booking muncul pada akun pelanggan dan dashboard vendor. Konfirmasi selesai dapat dilakukan setelah tanggal acara berlangsung. Pada layanan sewa, deposit dikembalikan setelah barang dikonfirmasi kembali dalam kondisi baik.
6. **Manajemen Sengketa (Dispute):** Keluhan dapat diajukan mulai hari acara hingga 48 jam setelahnya dengan menyertakan alasan dan tautan bukti. Vendor dapat memberikan tanggapan melalui dashboard, dan Admin memutuskan pelepasan dana, refund sebagian (0–100%), atau refund penuh. Keputusan bersifat final dan terkunci.
7. **Aturan Pembatalan & Refund:** Pembatalan menghitung pengembalian dana proporsional sesuai aturan (H-7: 100%, H-6 s.d. H-3: 50%, H-2 s.d. hari H: 0%). Riwayat audit mencatat nominal refund secara transparan.

---

## 💳 Payment Gateway & Blockchain (Sepolia)

Aplikasi telah terintegrasi dengan:
1. **Midtrans Sandbox (Snap API):** Pembayaran DP dan pelunasan menggunakan Snap redirect. Webhook diverifikasi dengan signature SHA-512 (`order_id + status_code + gross_amount + serverKey`), dilengkapi pencegahan pembayaran ganda (idempotency) dan sinkronisasi manual (`/api/bookings/:id/sync-payment`).
2. **Ethereum Sepolia Testnet (Smart Contract Tunggal):** Bukti pembayaran DP dan pelunasan dicatat ke smart contract `LockInEscrow.sol` yang mendukung pelacakan status booking (`DPPaid`, `FinalPaid`, `Completed`, `Disputed`, `Resolved`). Worker backend memproses antrian job blockchain (`blockchain_jobs`) setiap 15 detik.
3. **Mode Simulasi Fallback:** Jika kredensial Midtrans atau Sepolia belum diatur di `.env`, aplikasi tetap dapat diuji secara interaktif melalui tombol simulasi lokal (sukses, gagal, kedaluwarsa).

---

## ⚙️ Menjalankan Aplikasi di Windows

### Prasyarat
- Node.js versi 22 atau lebih baru.
- Editor kode (VS Code).
- Akun Midtrans Sandbox & Supabase (opsional, tersedia mode simulasi).

### 1. Jalankan Server
Buka terminal di folder proyek:

```powershell
cd "d:\kulyah\blockChain"
npm run dev
```

Buka browser di: **`http://127.0.0.1:4000`**

## 🧪 Testing & Audit

### Menjalankan Unit Test
Pengujian mencakup verifikasi signature SHA-512, pemetaan status notifikasi Midtrans, pencegahan tampering nominal/order ID, dan validasi keamanan transaksi:

```powershell
npm test
```

### Menjalankan Audit Database & Blockchain
Memeriksa konsistensi antara data booking di database dengan receipt event on-chain di smart contract Sepolia:

```powershell
npm run audit
```

---

## 📡 Daftar Endpoint API Utama

| Method | Endpoint | Fungsi |
| --- | --- | --- |
| `GET` | `/api/health` | Status server, database, midtrans, dan blockchain |
| `POST` | `/api/auth/register` | Pendaftaran akun pelanggan baru |
| `POST` | `/api/auth/login` | Login session (cookie HttpOnly/SameSite) |
| `POST` | `/api/auth/logout` | Menghapus sesi login |
| `GET` | `/api/auth/me` | Informasi profil pengguna yang sedang login |
| `GET` | `/api/vendors` | Katalog vendor (filter kategori, kota, tanggal, sort harga/rating) |
| `GET` | `/api/vendors/:id` | Detail vendor beserta daftar tanggal yang sudah terpesan |
| `GET` | `/api/bookings` | Daftar booking sesuai peran (pelanggan/vendor/admin) |
| `POST` | `/api/bookings` | Pembuatan booking baru & penguncian hash perjanjian SHA-256 |
| `GET` | `/api/bookings/:id` | Detail booking, data pembayaran, ledger, & job blockchain |
| `POST` | `/api/bookings/:id/payment` | Checkout Snap Midtrans atau simulasi pembayaran |
| `POST` | `/api/bookings/:id/sync-payment` | Sinkronisasi status transaksi dari Midtrans API |
| `POST` | `/api/bookings/:id/complete` | Konfirmasi penyelesaian acara setelah tanggal pelaksanaan |
| `POST` | `/api/bookings/:id/cancel` | Pembatalan pemesanan & kalkulasi refund |
| `POST` | `/api/bookings/:id/dispute` | Pengajuan keluhan/sengketa oleh pelanggan |
| `GET` | `/api/bookings/:id/audit` | Riwayat audit perubahan state booking |
| `GET` | `/api/disputes` | Daftar sengketa untuk vendor dan admin |
| `POST` | `/api/disputes/:id/response` | Tanggapan vendor terhadap keluhan pelanggan |
| `POST` | `/api/disputes/:id/resolve` | Keputusan mediasi admin (release / partial / full refund) |
| `POST` | `/api/leads` | Pendaftaran minat vendor baru dari landing page |
| `POST` | `/webhooks/midtrans` | Webhook notifikasi pembayaran dari Midtrans |

---

## 🛡️ Catatan Keamanan & Batasan Prototipe

- **Autentikasi & Sesi:** Password di-hash menggunakan algoritma `scrypt` dengan salt unik acak 16 byte. Sesi disimpan server-side dan dikirimkan via cookie `HttpOnly`, `SameSite=Lax`.
- **Proteksi Request:** Endpoint mutasi memvalidasi origin browser, validasi input teks/tanggal, kepemilikan data, dan validitas transisi state machine booking.
- **Batasan Keuangan:** Seluruh transaksi menggunakan Midtrans Sandbox dan Ethereum Sepolia Testnet. Smart contract bertindak sebagai pencatat audit log bukti transaksi (*notarization*), tidak menyimpan maupun mentransfer uang rupiah di blockchain.
- **Aset Lokal:** Font *Plus Jakarta Sans* dan *Caveat* disimpan lokal di `frontend/public/assets` dengan lisensi SIL Open Font License (OFL), sehingga tampilan dapat berjalan sempurna tanpa koneksi Google Fonts eksternal.

---

## 📄 Lisensi
Dikembangkan sebagai proyek Tugas Akhir akademik oleh Tim LockIn, Fakultas Ilmu Komputer, Universitas Brawijaya.  
All rights reserved © 2026 LockIn.
