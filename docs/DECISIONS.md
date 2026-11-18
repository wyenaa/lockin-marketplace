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

## ADR-003: 1 Smart Contract Tunggal dengan Pembaruan Status (LockInEscrow.sol)
- **Keputusan:** Menggunakan **1 smart contract tunggal** (`LockInEscrow.sol`) yang mengelola pencatatan DP, pelunasan, dan status update booking dalam satu siklus hidup (`BookingStatus`).
- **Alasan:**
  - Menghindari overhead deploy dan maintain 2 alamat kontrak berbeda.
  - Menyediakan single source of truth on-chain untuk setiap booking dengan state tracking terpusat (`DPPaid`, `FinalPaid`, `Completed`, `Disputed`, `Resolved`).
  - Memudahkan audit di Etherscan dengan 1 contract address dan event `BookingStatusUpdated`.

## ADR-004: Pola Outbox untuk Pencatatan Blockchain
- **Keputusan:** Notifikasi webhook dari Midtrans tidak langsung memblokir response untuk menunggu transaksi blockchain selesai (yang memakan waktu 12–30 detik per block di Sepolia).
- **Alasan:** Backend mencatat status `PAID` di database dan memasukkan job ke tabel `blockchain_jobs` (`QUEUED`). Worker asinkron memproses antrian setiap 15 detik dengan mekanisme retry.
