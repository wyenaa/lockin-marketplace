# ✅ Checklist Skenario Demo & Pengujian LockIn

Gunakan checklist ini saat presentasi atau pengujian prototipe:

## 1. Persiapan Awal
- [ ] Backend running (`npm run dev`) pada port 4000.
- [ ] Database Supabase aktif dan tabel terbuat (`schema.sql`).
- [ ] RPC Sepolia aktif dan address smart contract terpasang di `.env`.
- [ ] Server log menampilkan:
  - `Supabase: aktif`
  - `Midtrans: aktif (Sandbox)`
  - `Blockchain: aktif (Sepolia)`

## 2. Alur Pengguna (Pelanggan)
- [ ] Buka `http://127.0.0.1:4000`.
- [ ] Pilih vendor dari katalog (misal: "Glow Graduation" atau "Aurelia Makeup").
- [ ] Isi tanggal, jam, alamat acara, dan centang persetujuan perjanjian digital.
- [ ] Klik **Buat Pemesanan** → Snapshot perjanjian terkunci dengan hash SHA-256.
- [ ] Klik **Bayar DP (30%)** → dialihkan ke Midtrans Snap sandbox.
- [ ] Selesaikan pembayaran sandbox (QRIS / Virtual Account demo).
- [ ] Webhook terverifikasi → status booking berubah menjadi `DPPaid`.
- [ ] Worker mencatat transaksi ke Sepolia → tx hash muncul dan dapat dicek di Etherscan.

## 3. Alur Pelunasan
- [ ] Pelanggan membuka detail booking yang berstatus `DPPaid`.
- [ ] Klik **Bayar Pelunasan (70%)** → dialihkan kembali ke Snap checkout.
- [ ] Bayar pelunasan → status booking berubah menjadi `Paid` (Lunas).
- [ ] Transaksi kedua dicatat ke smart contract `LockInFinalPaymentLog.sol`.

## 4. Alur Penyelesaian & Sengketa
- [ ] Konfirmasi selesai setelah tanggal acara.
- [ ] Uji skenario sengketa (dispute) jika hasil tidak sesuai.
- [ ] Login sebagai admin → panel sengketa untuk memutuskan refund sebagian / penuh / lepas dana ke vendor.

## 5. Audit & Verifikasi
- [ ] Jalankan `npm run test` → 11 unit tests passed.
- [ ] Jalankan `npm run audit` → verifikasi hash database dan receipt transaksi on-chain.
