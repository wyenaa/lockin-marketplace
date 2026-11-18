// LockIn — Pencatatan bukti transaksi ke Ethereum Sepolia
// Outbox pattern: DB → blockchain_jobs queue → worker kirim setiap 15 detik.
// Jika RPC/gas bermasalah, pembayaran TIDAK diubah menjadi gagal.
import { Contract, JsonRpcProvider, Wallet, id as ethersId } from 'ethers';
import { supabase } from '../db/supabase.js';

const ABI = [
  'function recordDpPayment(bytes32 bookingRefHash, bytes32 agreementHash, bytes32 paymentRefHash) external',
  'function recordFinalPayment(bytes32 bookingRefHash, bytes32 agreementHash, bytes32 paymentRefHash) external',
  'function recordedPayments(bytes32 paymentRefHash) view returns (bool)'
];

let active = false;
const contracts = new Map();
let provider;

function ready() {
  return Boolean(
    process.env.SEPOLIA_RPC_URL &&
    process.env.SEPOLIA_WRITER_PRIVATE_KEY &&
    process.env.SEPOLIA_DP_CONTRACT_ADDRESS
  );
}

async function getContract(paymentType) {
  if (!['DP', 'FINAL'].includes(paymentType)) throw new Error('Jenis pembayaran tidak dikenal.');
  if (!provider) {
    provider = new JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
    const network = await provider.getNetwork();
    if (network.chainId !== 11155111n) throw new Error('RPC bukan jaringan Ethereum Sepolia.');
  }
  const address = paymentType === 'FINAL'
    ? process.env.SEPOLIA_FINAL_CONTRACT_ADDRESS
    : process.env.SEPOLIA_DP_CONTRACT_ADDRESS;
  if (!address) throw new Error(`Alamat kontrak untuk ${paymentType} belum diatur.`);
  if (!contracts.has(paymentType)) {
    const wallet = new Wallet(process.env.SEPOLIA_WRITER_PRIVATE_KEY, provider);
    contracts.set(paymentType, new Contract(address, ABI, wallet));
  }
  return contracts.get(paymentType);
}

/**
 * Worker: proses antrian blockchain_jobs dari Supabase.
 * Dipanggil setiap 15 detik dari index.js.
 */
export async function syncBlockchainJobs() {
  if (!ready() || active || !supabase) return;
  active = true;
  try {
    const { data: jobs } = await supabase
      .from('blockchain_jobs')
      .select(`
        *,
        bookings(hash),
        payments(provider_order_id, payment_type)
      `)
      .in('status', ['QUEUED', 'RETRY', 'SUBMITTED'])
      .lte('retry_after', Date.now())
      .order('id', { ascending: true })
      .limit(3);

    if (!jobs?.length) return;

    for (const job of jobs) {
      try {
        const paymentType = job.payments?.payment_type || 'DP';
        const c = await getContract(paymentType);
        const bookingRefHash = ethersId(job.booking_id);
        const rawHash = job.bookings?.hash || '';
        const agreementHash = rawHash.startsWith('0x') ? rawHash : `0x${rawHash}`;
        const paymentHash = ethersId(job.payments?.provider_order_id || job.payment_id);

        // Cek transaksi yang sudah dikirim sebelumnya (SUBMITTED)
        if (job.status === 'SUBMITTED' && job.tx_hash) {
          const receipt = await provider.getTransactionReceipt(job.tx_hash);
          if (receipt?.status === 1) {
            await supabase.from('blockchain_jobs').update({ status: 'CONFIRMED', last_error: null }).eq('id', job.id);
          } else if (receipt?.status === 0) {
            await supabase.from('blockchain_jobs').update({ status: 'RETRY', last_error: 'Transaksi reverted', retry_after: Date.now() + 60000 }).eq('id', job.id);
          }
          continue;
        }

        // Idempotency: cek apakah sudah tercatat di smart contract
        const alreadyRecorded = await c.recordedPayments(paymentHash);
        if (alreadyRecorded) {
          await supabase.from('blockchain_jobs').update({ status: 'CONFIRMED', last_error: null }).eq('id', job.id);
          continue;
        }

        // Kirim transaksi ke Sepolia
        const tx = paymentType === 'FINAL'
          ? await c.recordFinalPayment(bookingRefHash, agreementHash, paymentHash)
          : await c.recordDpPayment(bookingRefHash, agreementHash, paymentHash);

        await supabase.from('blockchain_jobs').update({ status: 'SUBMITTED', tx_hash: tx.hash, last_error: null }).eq('id', job.id);
      } catch (error) {
        console.error('[Blockchain worker]', error.message);
        await supabase.from('blockchain_jobs').update({
          status: 'RETRY',
          last_error: String(error.message).slice(0, 300),
          retry_after: Date.now() + 60000
        }).eq('id', job.id);
      }
    }
  } finally {
    active = false;
  }
}

export const isBlockchainConfigured = () => ready();
