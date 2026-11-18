# 🎓 LockIn — Graduation Vendor Marketplace with Escrow & Blockchain Audit Trail

Platform marketplace pemesanan vendor wisuda (PA Wisuda, MUA, Stylist, Content Creator, Rental Acrylic Sign) dengan integrasi **Midtrans Sandbox** untuk pembayaran bertahap (DP 30% & Pelunasan) serta pencatatan bukti transaksi on-chain ke **Smart Contract Tunggal Ethereum Sepolia** dengan pembaruan status siklus hidup booking.

Repository: [https://github.com/wyenaa/lockin-marketplace](https://github.com/wyenaa/lockin-marketplace)

---

## 🏗️ Struktur Folder Proyek

```
lockin-marketplace/
├── backend/                  # Server Node.js + Express API
│   ├── src/
│   │   ├── index.js          # HTTP server, routing, REST API & file static
│   │   ├── db/
│   │   │   ├── supabase.js   # Supabase client & query runner
│   │   │   └── seed.js       # Seed data vendor & demo accounts
│   │   ├── services/
│   │   │   ├── midtrans.js   # Midtrans Snap payment & signature verification
│   │   │   └── blockchain.js # Ethers.js integration & worker queue (Sepolia)
│   │   └── webhooks/
│   │       └── midtrans.js   # Webhook handler (idempotent, SHA-512 check)
│   ├── tests/                # Unit tests (payment security, signature, logic)
│   │   ├── midtrans.test.mjs
│   │   └── payment-security.test.mjs
│   └── package.json
│
├── frontend/                 # Client UI (Single Page Application)
│   ├── public/
│   │   ├── index.html        # Single-page application entry
│   │   ├── app.js            # Routing, state machine, modals, booking flow
│   │   ├── styles.css        # Responsive styling & design tokens
│   │   └── assets/           # SVG icons, logo, font lokal OFL
│   └── package.json
│
├── blockchain/               # Smart Contract Tunggal (Solidity)
│   ├── contracts/
│   │   └── LockInEscrow.sol  # 1 Kontrak tunggal (DP, Pelunasan, & Status Update)
│   ├── DEPLOY.md             # Panduan deployment smart contract via Remix IDE
│   └── package.json
│
├── database/                 # Database Schema & Seed (Supabase PostgreSQL)
│   ├── schemas/
│   │   └── schema.sql        # Skema tabel lengkap + RLS policies
│   └── seeds/
│       └── seed.sql          # SQL seed vendor demo
│
├── docs/                     # Dokumentasi arsitektur, keputusan & checklist
│   ├── ARCHITECTURE.md
│   ├── DECISIONS.md
│   └── DEMO_CHECKLIST.md
├── audit-lockin.mjs          # Script audit konsistensi DB vs Sepolia on-chain
├── .env.example              # Template variabel lingkungan
├── .gitignore
├── package.json              # Root npm workspace & scripts
└── README.md
```

---

## ⚙️ Tech Stack

| Komponen | Teknologi | Keterangan |
|---|---|---|
| **Backend** | Node.js (>=22.0.0), Express | ES Module, zero-dependency REST API core |
| **Frontend** | Vanilla JS, CSS3, HTML5 | SPA interaktif, desain Figma, assets lokal |
| **Database** | Supabase (PostgreSQL) | Auth bawaan, Row Level Security, realtime |
| **Payment Gateway** | Midtrans Sandbox (Snap API) | Pembayaran DP & pelunasan, verifikasi SHA-512 |
| **Blockchain** | Ethereum Sepolia Testnet | **1 Smart Contract tunggal (`LockInEscrow.sol`)** |
| **Worker Queue** | Outbox Pattern | Async job processing tiap 15 detik dengan retry |
| **Testing** | Node.js Test Runner | `node --test` untuk unit test & audit script |

---

## 🚀 Panduan Memulai

### 1. Prasyarat
- Node.js versi 22 atau lebih baru.
- Git.
- Akun [Midtrans Sandbox](https://sandbox.midtrans.com) (opsional, tersedia mode simulasi).
- Akun [Supabase](https://supabase.com) untuk database cloud.
- Wallet testnet MetaMask & Sepolia ETH (opsional, tersedia audit check).

### 2. Instalasi Dependency

```bash
# Install dependencies di root / backend
npm install
```

### 3. Setup Environment (.env)

Salin `.env.example` ke `.env`:
```bash
cp .env.example .env
```

Sesuaikan nilai di `.env`:
```env
PORT=4000
HOST=127.0.0.1

# Midtrans Sandbox
MIDTRANS_SERVER_KEY=SB-Mid-server-...
MIDTRANS_SIGNATURE_SECRET_KEY=Mid-server-...

# Ethereum Sepolia Testnet
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/...
SEPOLIA_WRITER_PRIVATE_KEY=...
SEPOLIA_CONTRACT_ADDRESS=0x...

# Supabase
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=ey...
```

### 4. Setup Database Supabase
1. Buka project di **Supabase Dashboard** → **SQL Editor**.
2. Salin isi file `database/schemas/schema.sql` dan jalankan (Run).
3. Opsional: jalankan `database/seeds/seed.sql` untuk vendor contoh.

### 5. Menjalankan Aplikasi

```bash
# Menjalankan server aplikasi (backend + frontend SPA)
npm run dev
```

Buka browser di:
👉 **`http://127.0.0.1:4000`**

---

## 🧪 Testing & Audit

### Menjalankan Unit Test
```bash
npm run test
```

### Menjalankan Audit Database & Blockchain
```bash
npm run audit
```

---

## 🔒 Alur Transaksi & Keamanan (1 Smart Contract Tunggal)

```
Pelanggan buat Booking
      ↓
Persetujuan Perjanjian Digital (Snapshot disimpan & di-hash SHA-256)
      ↓
Checkout DP (30%) via Midtrans Snap (QRIS / VA / E-Wallet)
      ↓
Webhook Midtrans masuk ke /webhooks/midtrans
      ↓
Verifikasi Signature SHA-512 (Timing-safe comparison)
      ↓
Update status di Database (Idempotent: cegah duplicate event)
      ↓
Worker Outbox memanggil recordDpPayment() di LockInEscrow.sol (Status: DPPaid)
      ↓
Pelunasan (Sisa 70%) sebelum hari H acara
      ↓
Worker Outbox memanggil recordFinalPayment() di LockInEscrow.sol (Status: FinalPaid)
      ↓
Konfirmasi Selesai / Penyelesaian Sengketa oleh Admin (updateStatus())
```

---

## 📄 Lisensi & Kontribusi
Dikembangkan untuk Tugas Akhir mata kuliah Teknologi Blockchain dan Platform Keuangan Digital, Universitas Brawijaya.
All rights reserved © 2026 LockIn Team.
