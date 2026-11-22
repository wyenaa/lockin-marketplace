## 🔗 Panduan Deploy Smart Contract Tunggal (LockInEscrow.sol) via Remix IDE

Smart contract LockIn disatukan dalam **1 smart contract tunggal**: `LockInEscrow.sol`.

### Langkah deploy:

1. **Buka Remix IDE:** https://remix.ethereum.org
2. **Upload Contract:**
   - Di panel kiri (File Explorer), buka folder `contracts/`
   - Upload file `LockInEscrow.sol` dari folder `blockchain/contracts/`
3. **Compile:**
   - Buka tab **Solidity Compiler**
   - Compiler version: `0.8.24` (atau yang kompatibel dengan `^0.8.24`)
   - Klik **Compile LockInEscrow.sol**
4. **Hubungkan MetaMask:**
   - Ubah jaringan MetaMask ke **Ethereum Sepolia Testnet**
   - Pastikan memiliki saldo Sepolia ETH (faucet gratis: https://sepoliafaucet.com)
5. **Deploy:**
   - Buka tab **Deploy & Run Transactions**
   - Environment: **Injected Provider - MetaMask**
   - Contract: Pilih `LockInEscrow`
   - Parameter constructor `writer`: Masukkan alamat address wallet backend yang private key-nya Anda gunakan.
   - Klik tombol **Deploy** dan konfirmasi transaksi di MetaMask.
6. **Verifikasi deployment sebelum mengaktifkan worker:**
   - Pastikan alamat kontrak memiliki bytecode di Sepolia.
   - Panggil `authorizedWriter()` dan cocokkan dengan alamat wallet dari `SEPOLIA_WRITER_PRIVATE_KEY` backend.
   - Pastikan RPC backend menunjuk ke Sepolia (chain ID `11155111`).
   - Jalankan pengujian lokal pada `test/LockInEscrow.t.sol` sebelum deploy.
7. **Simpan Alamat Kontrak ke `.env`:**
   - Salin alamat contract hasil deploy (misal `0x...`)
   - Masukkan ke file `.env`:
     ```env
     SEPOLIA_CONTRACT_ADDRESS=0x...
     ```

### Migrasi Riwayat DP Lama

Kontrak baru tidak membaca state dari `LockInBookingLog` atau `LockInFinalPaymentLog`. Jangan menghapus atau mengubah kontrak/job lama. Untuk setiap booking yang DP-nya sudah `CONFIRMED` di kontrak DP lama:

1. Verifikasi receipt sukses, alamat kontrak lama, payment reference, booking reference, dan agreement hash dari sumber tepercaya.
2. Dengan akun writer yang terotorisasi, panggil `migrateLegacyDpPayment(bookingRefHash, agreementHash, paymentRefHash, legacyContract, legacyTxHash)` satu kali di kontrak baru.
3. `bookingRefHash` dan `paymentRefHash` harus dihitung sama seperti worker backend (`keccak256` atas string ID/reference); `agreementHash` harus sama dengan hash booking yang tersimpan.
4. Periksa event `LegacyDpPaymentMigrated`, `recordedPayments(paymentRefHash)`, dan status booking `DPPaid` pada kontrak baru.
5. Baru setelah seluruh DP lama yang diperlukan terverifikasi dan dimigrasikan, arahkan worker ke alamat kontrak baru. Periksa tiga job FINAL `RETRY` dan pastikan tidak ada receipt FINAL sukses di kontrak lama sebelum worker memprosesnya.

Fungsi migrasi adalah **attestation dari writer**, bukan verifikasi lintas-kontrak on-chain. Event menyimpan alamat kontrak dan tx hash lama agar auditor dapat menelusuri bukti asal. Event/status lama tetap berada di kontrak lama dan tidak dihapus. Jangan mengubah status job `CONFIRMED` atau menjalankan ulang DP lama; migrasi state dibuat melalui fungsi khusus di kontrak baru.

### Verifikasi Transaksi Publik:
Cek transaksi dan event di Sepolia Etherscan:
`https://sepolia.etherscan.io/address/<SEPOLIA_CONTRACT_ADDRESS>`
