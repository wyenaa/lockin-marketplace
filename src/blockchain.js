// Modul pencatatan bukti transaksi ke smart contract Ethereum Sepolia.
// Outbox pattern: pembayaran dicatat dulu di DB, lalu blockchain job diproses terpisah.
// Jika RPC/gas bermasalah, pembayaran tidak diubah menjadi gagal.
import { Contract, JsonRpcProvider, Wallet, id as ethersId } from 'ethers';

const ABI = [
  'function recordDpPayment(bytes32 bookingRefHash, bytes32 agreementHash, bytes32 paymentRefHash) external',
  'function recordFinalPayment(bytes32 bookingRefHash, bytes32 agreementHash, bytes32 paymentRefHash) external',
  'function recordedPayments(bytes32 paymentRefHash) view returns (bool)'
];
let active = false;
const contracts = new Map();
let provider;

function ready() {
  return Boolean(process.env.SEPOLIA_RPC_URL && process.env.SEPOLIA_WRITER_PRIVATE_KEY && process.env.SEPOLIA_DP_CONTRACT_ADDRESS);
}

async function getContract(paymentType) {
  if (!['DP', 'FINAL'].includes(paymentType)) throw new Error('Jenis pembayaran tidak dikenal.');
  if (!provider) {
    provider = new JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
    const network = await provider.getNetwork();
    if (network.chainId !== 11155111n) throw new Error('RPC bukan jaringan Ethereum Sepolia.');
  }
  const address = paymentType === 'FINAL' ? process.env.SEPOLIA_FINAL_CONTRACT_ADDRESS : process.env.SEPOLIA_DP_CONTRACT_ADDRESS;
  if (!address) throw new Error(`Alamat kontrak untuk ${paymentType} belum diatur.`);
  if (!contracts.has(paymentType)) {
    const wallet = new Wallet(process.env.SEPOLIA_WRITER_PRIVATE_KEY, provider);
    contracts.set(paymentType, new Contract(address, ABI, wallet));
  }
  return contracts.get(paymentType);
}

// Memproses antrian blockchain job dari database.
// db harus berupa instance DatabaseSync dari node:sqlite.
export async function syncBlockchainJobs(db) {
  if (!ready() || active) return;
  active = true;
  try {
    const jobs = db.prepare(`
      SELECT j.*, b.hash as agreement_hash, p.provider_order_id, p.payment_type
      FROM blockchain_jobs j
      JOIN bookings b ON b.id = j.booking_id
      JOIN payments p ON p.id = j.payment_id
      WHERE j.status IN ('QUEUED','RETRY','SUBMITTED') AND j.retry_after <= ?
      ORDER BY j.id ASC LIMIT 3
    `).all(Date.now());
    for (const job of jobs) {
      try {
        const c = await getContract(job.payment_type);
        const bookingRefHash = ethersId(job.booking_id);
        const agreementHash = job.agreement_hash.startsWith('0x') ? job.agreement_hash : `0x${job.agreement_hash}`;
        const paymentHash = ethersId(job.provider_order_id);
        // Cek transaksi yang sudah dikirim sebelumnya.
        if (job.status === 'SUBMITTED' && job.tx_hash) {
          const receipt = await provider.getTransactionReceipt(job.tx_hash);
          if (receipt?.status === 1) {
            db.prepare(`UPDATE blockchain_jobs SET status='CONFIRMED',last_error=NULL WHERE id=?`).run(job.id);
          } else if (receipt?.status === 0) {
            db.prepare(`UPDATE blockchain_jobs SET status='RETRY',last_error='Transaksi reverted',retry_after=? WHERE id=?`).run(Date.now() + 60000, job.id);
          }
          continue;
        }
        // Cek apakah sudah tercatat di smart contract (idempotent).
        const alreadyRecorded = await c.recordedPayments(paymentHash);
        if (alreadyRecorded) {
          db.prepare(`UPDATE blockchain_jobs SET status='CONFIRMED',last_error=NULL WHERE id=?`).run(job.id);
          continue;
        }
        // Kirim transaksi ke smart contract.
        const tx = job.payment_type === 'FINAL'
          ? await c.recordFinalPayment(bookingRefHash, agreementHash, paymentHash)
          : await c.recordDpPayment(bookingRefHash, agreementHash, paymentHash);
        db.prepare('UPDATE blockchain_jobs SET status=?,tx_hash=?,last_error=NULL WHERE id=?').run('SUBMITTED', tx.hash, job.id);
      } catch (error) {
        console.error('Sepolia sync:', error.message);
        db.prepare(`UPDATE blockchain_jobs SET status='RETRY',last_error=?,retry_after=? WHERE id=?`).run(String(error.message).slice(0, 300), Date.now() + 60000, job.id);
      }
    }
  } finally {
    active = false;
  }
}

export function isBlockchainConfigured() { return ready(); }
