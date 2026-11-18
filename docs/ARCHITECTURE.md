# 🏗️ Arsitektur Sistem LockIn

## 1. Ikhtisar Arsitektur
LockIn dirancang dengan arsitektur berlapis (layered architecture) yang memisahkan antara frontend UI, backend API service, integrasi payment gateway Midtrans, dan smart contract Ethereum Sepolia.

```
+--------------------------------------------------------------+
|                        Frontend UI                           |
|       Vanilla JS SPA / Figma Tokens / Responsive Layout      |
+------------------------------+-------------------------------+
                               | HTTP REST / JSON
                               v
+--------------------------------------------------------------+
|                     Backend (Express / Node.js)              |
|  - Auth & Session Service                                    |
|  - Booking & Escrow State Machine                            |
|  - Midtrans Snap Client & Signature Verifier                 |
|  - Blockchain Job Outbox Worker                              |
+--------------+-------------------------------+---------------+
               |                               |
               v                               v
+-------------------------------+ +----------------------------+
|     Supabase (PostgreSQL)     | |    Midtrans Sandbox        |
| - Users, Bookings, Payments   | | - Snap Token & Redirect    |
| - Audit Trail, Ledger Entries | | - Webhook Notifications    |
| - Blockchain Job Outbox       | +----------------------------+
+-------------------------------+
               | (Worker polling / Outbox queue)
               v
+--------------------------------------------------------------+
|                Ethereum Sepolia Testnet                      |
| - LockInBookingLog.sol (Bukti Pembayaran DP on-chain)        |
| - LockInFinalPaymentLog.sol (Bukti Pelunasan on-chain)       |
+--------------------------------------------------------------+
```

## 2. Prinsip Desain
1. **Separation of Concerns:** Modul dipisahkan ke `backend/`, `frontend/`, `blockchain/`, dan `database/`.
2. **Outbox Pattern:** Transaksi pembayaran dicatat terlebih dahulu ke database, baru diproses oleh worker blockchain secara terpisah. Jika ada kendala RPC / gas fee, status pembayaran pelanggan tidak terganggu.
3. **Idempotency:** Webhook Midtrans dan pencatatan blockchain dirancang aman dari duplicate event (`recordedPayments` mapping di Solidity dan update status conditional di DB).
4. **Zero Mainnet Risk:** Smart contract hanya menyimpan hash referensi (SHA-256 agreement dan keccak256 order ID), tidak menyimpan maupun mentransfer uang rupiah sungguhan di blockchain.
