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
6. **Simpan Alamat Kontrak ke `.env`:**
   - Salin alamat contract hasil deploy (misal `0x...`)
   - Masukkan ke file `.env`:
     ```env
     SEPOLIA_CONTRACT_ADDRESS=0x...
     ```

### Verifikasi Transaksi Publik:
Cek transaksi dan event di Sepolia Etherscan:
`https://sepolia.etherscan.io/address/<SEPOLIA_CONTRACT_ADDRESS>`
