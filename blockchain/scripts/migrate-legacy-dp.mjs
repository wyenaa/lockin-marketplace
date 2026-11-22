import { createClient } from '@supabase/supabase-js';
import {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  ZeroHash,
  getAddress,
  id,
  isHexString
} from 'ethers';
import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
config({ path: resolve(ROOT, '.env'), quiet: true });

const BOOKING_IDS = ['LI-017E6D2BA3', 'LI-0FC106D35F', 'LI-3A3F7B5E96'];
const NEW_CONTRACT_ADDRESS = '0x03A831F7f3d46Ca2F9513F1454d3fE7e91E4D8c2';
const SEPOLIA_CHAIN_ID = 11155111n;
const STATUS = { NONE: 0n, DP_PAID: 2n };
const OLD_DP_ABI = [
  'function recordedPayments(bytes32 paymentRefHash) view returns (bool)',
  'event DpPaymentRecorded(bytes32 indexed bookingRefHash, bytes32 indexed paymentRefHash, bytes32 agreementHash, uint256 recordedAt)'
];
const NEW_CONTRACT_ABI = [
  'function authorizedWriter() view returns (address)',
  'function getBooking(bytes32 bookingRefHash) view returns (bytes32 agreementHash, uint8 status, uint256 updatedAt)',
  'function recordedPayments(bytes32 paymentRefHash) view returns (bool)',
  'function migratedLegacyTransactions(bytes32 legacyTxHash) view returns (bool)',
  'function migrateLegacyDpPayment(bytes32 bookingRefHash, bytes32 agreementHash, bytes32 paymentRefHash, address legacyContract, bytes32 legacyTxHash)'
];

function redact(message) {
  let result = String(message || 'unknown error');
  for (const secret of [
    process.env.SEPOLIA_WRITER_PRIVATE_KEY,
    process.env.SEPOLIA_RPC_URL,
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_ANON_KEY,
    process.env.MIDTRANS_SERVER_KEY,
    process.env.MIDTRANS_SIGNATURE_SECRET_KEY
  ]) {
    if (secret) result = result.split(secret).join('[REDACTED]');
  }
  return result;
}

function assertBytes32(value, label) {
  if (!isHexString(value, 32) || value.toLowerCase() === ZeroHash)
    throw new Error(`${label} harus berupa hash bytes32 nonzero.`);
  return value;
}

async function readRows(supabase, table, columns, bookingIds) {
  const { data, error } = await supabase.from(table).select(columns).in('booking_id', bookingIds);
  if (error || !Array.isArray(data)) throw new Error(`Gagal membaca ${table} dari Supabase.`);
  return data;
}

async function preflight() {
  const execute = process.argv.slice(2);
  if (execute.some(arg => arg !== '--execute') || execute.filter(arg => arg === '--execute').length > 1)
    throw new Error('Argumen tidak dikenal. Gunakan tanpa argumen untuk dry-run atau --execute untuk mengirim migrasi.');
  const shouldExecute = execute.includes('--execute');

  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SEPOLIA_RPC_URL', 'SEPOLIA_WRITER_PRIVATE_KEY', 'SEPOLIA_DP_CONTRACT_ADDRESS'];
  if (required.some(name => !process.env[name])) throw new Error('Konfigurasi Supabase/RPC/writer/kontrak DP belum lengkap.');

  const oldDpAddress = getAddress(process.env.SEPOLIA_DP_CONTRACT_ADDRESS);
  const newAddress = getAddress(NEW_CONTRACT_ADDRESS);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  const provider = new JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  const wallet = new Wallet(process.env.SEPOLIA_WRITER_PRIVATE_KEY, provider);
  const network = await provider.getNetwork();
  if (network.chainId !== SEPOLIA_CHAIN_ID) throw new Error('RPC tidak terhubung ke Sepolia (chain ID 11155111).');

  const [oldCode, newCode, bookingResult, paymentRows, jobRows] = await Promise.all([
    provider.getCode(oldDpAddress),
    provider.getCode(newAddress),
    supabase.from('bookings').select('id,hash').in('id', BOOKING_IDS),
    readRows(supabase, 'payments', 'id,booking_id,provider_order_id,payment_type,outcome', BOOKING_IDS),
    readRows(supabase, 'blockchain_jobs', 'id,booking_id,payment_id,status,tx_hash', BOOKING_IDS)
  ]);
  if (oldCode === '0x') throw new Error('Bytecode kontrak DP lama tidak ditemukan di Sepolia.');
  if (newCode === '0x') throw new Error('Bytecode kontrak LockInEscrow baru tidak ditemukan di Sepolia.');
  if (bookingResult.error || !Array.isArray(bookingResult.data)) throw new Error('Gagal membaca booking dari Supabase.');

  const bookings = new Map(bookingResult.data.map(booking => [booking.id, booking]));
  if (BOOKING_IDS.some(id => !bookings.has(id))) throw new Error('Satu atau lebih booking target tidak ditemukan.');
  const oldContract = new Contract(oldDpAddress, OLD_DP_ABI, provider);
  const newContract = new Contract(newAddress, NEW_CONTRACT_ABI, provider);
  const configuredWriter = getAddress(wallet.address);
  const authorizedWriter = getAddress(await newContract.authorizedWriter());
  if (configuredWriter !== authorizedWriter) throw new Error('Wallet backend tidak cocok dengan authorizedWriter kontrak baru.');

  const prepared = [];
  for (const bookingId of BOOKING_IDS) {
    const booking = bookings.get(bookingId);
    const agreementHash = assertBytes32(
      booking.hash?.startsWith('0x') ? booking.hash : `0x${booking.hash || ''}`,
      `agreementHash ${bookingId}`
    );
    const successes = paymentRows.filter(row => row.booking_id === bookingId && row.payment_type === 'DP' && row.outcome === 'success');
    if (successes.length !== 1) throw new Error(`${bookingId}: diharapkan tepat satu pembayaran DP sukses; ditemukan ${successes.length}.`);
    const payment = successes[0];
    const jobs = jobRows.filter(row => row.booking_id === bookingId && row.payment_id === payment.id && row.status === 'CONFIRMED');
    if (jobs.length !== 1 || !jobs[0].tx_hash) throw new Error(`${bookingId}: job DP CONFIRMED beserta tx hash tidak tunggal/tersedia.`);
    const job = jobs[0];
    const bookingRefHash = id(bookingId);
    const paymentRefHash = id(payment.provider_order_id || job.payment_id);
    const legacyTxHash = assertBytes32(job.tx_hash, `tx hash DP lama ${bookingId}`);

    const receipt = await provider.getTransactionReceipt(legacyTxHash);
    if (!receipt || receipt.status !== 1) throw new Error(`${bookingId}: receipt DP lama tidak sukses atau belum tersedia.`);
    if (!receipt.to || getAddress(receipt.to) !== oldDpAddress) throw new Error(`${bookingId}: alamat tujuan receipt bukan kontrak DP lama.`);
    const dpEvents = receipt.logs
      .filter(log => getAddress(log.address) === oldDpAddress)
      .flatMap(log => {
        try {
          const parsed = oldContract.interface.parseLog(log);
          return parsed?.name === 'DpPaymentRecorded' ? [parsed] : [];
        } catch { return []; }
      });
    const verifiedEvent = dpEvents.some(event =>
      event.args.bookingRefHash.toLowerCase() === bookingRefHash.toLowerCase() &&
      event.args.paymentRefHash.toLowerCase() === paymentRefHash.toLowerCase() &&
      event.args.agreementHash.toLowerCase() === agreementHash.toLowerCase()
    );
    if (!verifiedEvent) throw new Error(`${bookingId}: event DP lama tidak cocok dengan data booking/payment/agreement.`);
    if (!(await oldContract.recordedPayments(paymentRefHash)))
      throw new Error(`${bookingId}: kontrak DP lama tidak mengonfirmasi recordedPayments.`);

    const existing = await newContract.getBooking(bookingRefHash);
    const paymentAlreadyRecorded = await newContract.recordedPayments(paymentRefHash);
    const txAlreadyMigrated = await newContract.migratedLegacyTransactions(legacyTxHash);
    const existingAgreement = existing.agreementHash.toLowerCase();
    const completeMigration = txAlreadyMigrated && paymentAlreadyRecorded &&
      existingAgreement === agreementHash.toLowerCase() && existing.status >= STATUS.DP_PAID;
    if (!completeMigration && (
      existing.status !== STATUS.NONE || paymentAlreadyRecorded || txAlreadyMigrated
    )) throw new Error(`${bookingId}: state kontrak baru sudah terisi sebagian/tidak konsisten; perlu pemeriksaan manual.`);

    prepared.push({
      bookingId,
      jobId: job.id,
      bookingRefHash,
      paymentRefHash,
      agreementHash,
      legacyContract: oldDpAddress,
      legacyTxHash,
      state: completeMigration ? 'SUDAH DIMIGRASIKAN' : 'SIAP DIMIGRASIKAN'
    });
  }

  return { shouldExecute, provider, wallet, newContract, network, configuredWriter, authorizedWriter, prepared };
}

try {
  const result = await preflight();
  console.log(`Mode: ${result.shouldExecute ? 'EXECUTE' : 'DRY-RUN (tanpa transaksi)'}`);
  console.log(`Chain ID: ${result.network.chainId.toString()}`);
  console.log(`Kontrak baru: ${NEW_CONTRACT_ADDRESS}`);
  console.log(`Writer terotorisasi cocok: ${result.configuredWriter === result.authorizedWriter ? 'ya' : 'tidak'}`);
  for (const item of result.prepared) {
    console.log(`${item.bookingId} | job ${item.jobId} | ${item.state}`);
    console.log(`  bookingRefHash: ${item.bookingRefHash}`);
    console.log(`  paymentRefHash: ${item.paymentRefHash}`);
    console.log(`  agreementHash:  ${item.agreementHash}`);
    console.log(`  legacyTxHash:   ${item.legacyTxHash}`);
  }

  if (!result.shouldExecute) {
    console.log('Dry-run selesai. Tidak ada transaksi yang dikirim dan tidak ada data Supabase yang diubah.');
  } else {
    for (const item of result.prepared) {
      if (item.state === 'SUDAH DIMIGRASIKAN') {
        console.log(`${item.bookingId}: dilewati; migrasi sudah tercatat.`);
        continue;
      }
      const tx = await result.newContract.connect(result.wallet).migrateLegacyDpPayment(
        item.bookingRefHash,
        item.agreementHash,
        item.paymentRefHash,
        item.legacyContract,
        item.legacyTxHash
      );
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) throw new Error(`${item.bookingId}: receipt migrasi tidak sukses.`);
      const current = await result.newContract.getBooking(item.bookingRefHash);
      if (current.status !== STATUS.DP_PAID || current.agreementHash.toLowerCase() !== item.agreementHash.toLowerCase() ||
          !(await result.newContract.recordedPayments(item.paymentRefHash)) ||
          !(await result.newContract.migratedLegacyTransactions(item.legacyTxHash)))
        throw new Error(`${item.bookingId}: verifikasi pascatransaksi gagal.`);
      console.log(`${item.bookingId}: migrasi terkonfirmasi tx ${receipt.hash}`);
    }
  }
  await result.provider.destroy();
} catch (error) {
  console.error(`Migrasi dibatalkan: ${redact(error.message)}`);
  process.exitCode = 1;
}
