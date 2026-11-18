# LockIn

Website full stack berdasarkan delapan tampilan Figma LockIn: landing page, katalog vendor, detail jasa/perjanjian, detail sewa standing sign, checkout, status booking, dashboard vendor, dan admin sengketa. Aset SVG asli Figma disimpan di `public/assets`.

## Menjalankan di Windows

Prasyarat: Node.js 24 atau lebih baru. Tidak perlu menginstal database atau dependency untuk menjalankan aplikasi.

```powershell
cd "D:\semester 7\blockchain"
npm.cmd start
```

Buka **http://127.0.0.1:3000**. Untuk pengembangan dengan restart otomatis, gunakan `npm.cmd run dev`. `npm.cmd` menghindari pembatasan eksekusi `npm.ps1` di PowerShell.

Database SQLite dibuat otomatis di `data/lockin.sqlite`, termasuk enam vendor contoh dan tiga akun demo. Data booking tetap tersimpan setelah server dimatikan. `HOST`, `PORT`, dan `DB_PATH` dapat diberikan melalui environment variable; nilai default host adalah `127.0.0.1`. Server tidak membaca file `.env` secara otomatis.

## Akun demo

| Peran | Email | Password |
| --- | --- | --- |
| Pelanggan | user@lockin.demo | LockInDemo123! |
| Vendor | vendor@lockin.demo | LockInDemo123! |
| Admin | admin@lockin.demo | LockInDemo123! |

Klik **Masuk**, lalu tombol peran demo untuk mencoba. Akun baru dapat didaftarkan sebagai pelanggan. Semua vendor contoh dimiliki akun vendor demo. Keluar untuk beralih peran; peran tidak dapat diubah oleh pelanggan melalui API.

## Alur utama

1. Cari vendor berdasarkan kategori, kota Malang, dan tanggal. Urutkan harga atau rating.
2. Buka detail, isi tanggal, jam, dan alamat acara, lalu setujui perjanjian.
3. Backend mengunci snapshot perjanjian, menghasilkan hash SHA-256, menyimpan booking, dan menahan slot selama 24 jam.
4. Checkout menyediakan QRIS, virtual account, serta e-wallet dalam sandbox. Uji sukses, gagal, atau kedaluwarsa. Jasa membayar DP 30%, lalu sisa pelunasan; sewa membayar biaya sewa dan deposit sekaligus.
5. Booking muncul pada akun pelanggan dan dashboard vendor. Konfirmasi selesai tersedia untuk booking lunas setelah tanggal acara. Sewa yang selesai dianggap telah dikembalikan dalam kondisi baik; deposit dikembalikan secara simulasi.
6. Keluhan dapat diajukan pada hari acara sampai 48 jam setelah akhir hari acara. Sertakan kronologi dan keterangan atau tautan bukti. Vendor menanggapi dari dashboard; admin memutuskan pelepasan dana, refund sebagian, atau refund penuh. Keputusan tidak bisa dikirim dua kali.
7. Pembatalan menghitung refund sesuai aturan yang ditampilkan dan melepas slot. Riwayat audit menyimpan nominal refund.

## Batas implementasi

- **Pembayaran dan escrow adalah simulasi** sesuai checkout sandbox di desain. Tidak ada uang sungguhan, webhook gateway, rekening penampungan, atau transfer refund. Biaya layanan contoh Rp0.
- **Blockchain adalah simulasi lokal**. Hash SHA-256 dan rantai audit disimpan di SQLite; belum ada smart contract atau transaksi Sepolia. Aplikasi tidak menampilkan transaksi/explorer palsu.
- Nama, harga, dan rating merupakan data contoh untuk menggantikan placeholder desain. Katalog saat ini hanya Malang.
- Bukti sengketa berupa teks dan tautan; unggah berkas belum tersedia. Pendaftaran vendor pada landing page menyimpan minat kontak, belum membuat vendor baru atau mengirim pesan.
- Font Plus Jakarta Sans dan Caveat disimpan lokal beserta lisensi OFL di `public/assets`; antarmuka dapat dimuat tanpa koneksi ke Google Fonts.
- Aplikasi disiapkan untuk dijalankan lokal. Sebelum deployment publik, ganti/hapus akun demo, tambahkan rate limiting, HTTPS dengan cookie Secure, backup database, serta integrasi gateway/blockchain bila dibutuhkan. Belum ada deployment hosting.

## Payment Gateway & Blockchain (Sepolia)

Aplikasi telah terintegrasi dengan:
1. **Midtrans Sandbox (Snap)**: Pembayaran DP dan pelunasan menggunakan Snap redirect. Webhook diverifikasi dengan signature SHA-512, serta didukung sinkronisasi manual (`/api/bookings/:id/sync-payment`).
2. **Ethereum Sepolia Testnet**: Bukti pembayaran DP dan pelunasan dicatat secara on-chain ke smart contract (`contracts/LockInBookingLog.sol` dan `contracts/LockInFinalPaymentLog.sol`). Worker backend memproses antrian job blockchain (`blockchain_jobs`) setiap 15 detik dan tautan transaksi dapat dilihat langsung di Sepolia Etherscan.
3. **Simulasi Fallback**: Jika kredensial Midtrans / Sepolia tidak diatur di `.env`, aplikasi otomatis berjalan dalam mode simulasi interaktif (pengujian lokal tanpa koneksi eksternal).

### Konfigurasi `.env`

Salin dan sesuaikan variabel pada file `.env`:

```env
PORT=4000
MIDTRANS_SERVER_KEY=SB-Mid-server-...
MIDTRANS_SIGNATURE_SECRET_KEY=Mid-server-...
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/...
SEPOLIA_WRITER_PRIVATE_KEY=...
SEPOLIA_DP_CONTRACT_ADDRESS=0xdDF5D4Ad584679A7c2E76765097DBeD0393F6F6f
SEPOLIA_FINAL_CONTRACT_ADDRESS=0x9165Ee0C004c8D45f1B021dD8F2d8D6fF5968FCF
```

### Audit Database & Blockchain

Jalankan script verifikasi konsistensi database terhadap smart contract Sepolia:

```powershell
node audit-lockin.mjs
```

## Pengujian

```powershell
npm.cmd run check
npm.cmd test
```

Pengujian API menggunakan database memori terpisah, sehingga tidak mengubah data lokal. Mencakup akses peran, isolasi pengguna, jadwal ganda, validasi tanggal, pembayaran ulang, DP/pelunasan, sewa/deposit, kedaluwarsa, pembatalan, dan alur sengketa.

Untuk pengujian browser, instal dev dependency dengan `npm.cmd install`, lalu jalankan `npm.cmd run test:e2e` setelah dependency Playwright tersedia. Pengujian menggunakan Chrome yang sudah terpasang di Windows; `CHROME_PATH` dapat mengubah lokasi executable. Database browser test juga terpisah dalam memori.

## Struktur

```text
server.mjs          HTTP server, REST API, autentikasi, SQLite, seed data
public/index.html   Dokumen aplikasi
public/app.js       Routing, halaman, form, interaksi API
public/styles.css   Token desain dan layout responsif
public/assets/      Aset SVG asli Figma
tests/              Pengujian API dan browser
data/               Database runtime (diabaikan Git)
```

API utama: `GET /api/vendors`, `GET /api/vendors/:id`, `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET/POST /api/bookings`, `GET /api/bookings/:id`, `POST /api/bookings/:id/payment`, `POST /api/bookings/:id/complete`, `POST /api/bookings/:id/cancel`, `POST /api/bookings/:id/dispute`, `GET /api/bookings/:id/audit`, `GET /api/disputes`, `POST /api/disputes/:id/response`, `POST /api/disputes/:id/resolve`, dan `POST /api/leads`.

Password menggunakan scrypt dengan salt unik; sesi disimpan server-side dan cookie HttpOnly/SameSite. Endpoint mutasi memvalidasi origin jika browser mengirimkannya, input, akses pemilik, peran, dan transisi status. Nominal pembayaran dihitung oleh backend.
