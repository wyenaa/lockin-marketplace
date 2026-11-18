# 📋 Log Keputusan Arsitektur & Teknologi (ADR)

## ADR-001: Pemisahan Folder Menjadi Modular
- **Keputusan:** Membagi kode dari yang sebelumnya flat di root menjadi folder terstruktur: `backend/`, `frontend/`, `blockchain/`, dan `database/`.
- **Alasan:** Memudahkan maintainability, pengujian terisolasi, dan deploy komponen secara independen.

## ADR-002: Pemilihan Supabase (PostgreSQL Cloud)
- **Keputusan:** Menggunakan Supabase sebagai database utama menggantikan SQLite lokal atau XAMPP.
- **Alasan:**
  - PostgreSQL cloud dapat diakses kapan saja tanpa perlu server lokal tetap menyala.
  - Memiliki fitur Auth terintegrasi serta Row Level Security (RLS) untuk isolasi data pelanggan vs vendor vs admin.
  - Mendukung realtime event dan skema relasional yang aman untuk transaksi finansial.

## ADR-003: Dua Smart Contract Terpisah (DP & Final Payment)
- **Keputusan:** Menggunakan 2 smart contract terpisah: `LockInBookingLog.sol` untuk DP dan `LockInFinalPaymentLog.sol` untuk pelunasan.
- **Alasan:**
  - Memisahkan audit event DP dan Pelunasan agar query on-chain lebih sederhana dan bersih.
  - Memudahkan audit independen di Etherscan tanpa parameter enum yang kompleks.

## ADR-004: Pola Outbox untuk Pencatatan Blockchain
- **Keputusan:** Notifikasi webhook dari Midtrans tidak langsung memblokir response untuk menunggu transaksi blockchain selesai (yang memakan waktu 12–30 detik per block di Sepolia).
- **Alasan:** Backend mencatat status `PAID` di database dan memasukkan job ke tabel `blockchain_jobs` (`QUEUED`). Worker asinkron memproses antrian setiap 15 detik dengan mekanisme retry.
