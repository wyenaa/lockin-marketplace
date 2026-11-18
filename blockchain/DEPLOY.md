## 🔗 Panduan Deploy Smart Contract via Remix IDE

Smart contract LockIn menggunakan **Remix IDE** (web-based, tanpa install).

### Langkah deploy:

1. **Buka** https://remix.ethereum.org

2. **Upload contract files:**
   - Di panel kiri, klik ikon 📁 → `contracts/`
   - Upload kedua file: `LockInBookingLog.sol` dan `LockInFinalPaymentLog.sol`

3. **Compile:**
   - Klik tab **Solidity Compiler** (ikon ⚙️)
   - Compiler version: `0.8.24`
   - Klik **Compile LockInBookingLog.sol**
   - Ulangi untuk `LockInFinalPaymentLog.sol`

4. **Connect MetaMask ke Sepolia:**
   - Buka MetaMask → pilih network **Sepolia Testnet**
   - Dapatkan Sepolia ETH gratis: https://sepoliafaucet.com

5. **Deploy:**
   - Klik tab **Deploy & Run Transactions**
   - Environment: **Injected Provider - MetaMask**
   - Pilih contract `LockInBookingLog`
   - Di field `writer` isi alamat wallet yang private key-nya dipakai backend
   - Klik **Deploy** → konfirmasi di MetaMask
   - **Salin alamat contract** yang muncul → isi `SEPOLIA_DP_CONTRACT_ADDRESS` di `.env`
   - Ulangi untuk `LockInFinalPaymentLog` → isi `SEPOLIA_FINAL_CONTRACT_ADDRESS`

6. **Isi `.env` backend:**
   ```
   SEPOLIA_DP_CONTRACT_ADDRESS=0x...
   SEPOLIA_FINAL_CONTRACT_ADDRESS=0x...
   SEPOLIA_WRITER_PRIVATE_KEY=0x...  (private key wallet yang dipakai di step 5)
   ```

> ⚠️ **JANGAN** gunakan wallet yang berisi ETH mainnet. Gunakan wallet khusus testnet.

### Verifikasi di Etherscan:
Setelah transaksi blockchain dikirim, cek di:
https://sepolia.etherscan.io/address/<CONTRACT_ADDRESS>
