import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildBookingBlockchainEvidence, unavailableBookingBlockchainEvidence } from '../src/utils/booking-blockchain-evidence.js';

const validHash = '0x' + 'a'.repeat(64);

test('booking evidence maps only the linked successful DP/FINAL jobs and exposes tx only for valid CONFIRMED', () => {
  const payments = [
    { id: 'dp-success', payment_type: 'DP', outcome: 'success', created_at: '2026-11-20T10:00:00Z' },
    { id: 'dp-failed-newer', payment_type: 'DP', outcome: 'failed', created_at: '2026-11-22T10:00:00Z' },
    { id: 'final-success', payment_type: 'FINAL', outcome: 'success', created_at: '2026-11-21T10:00:00Z' }
  ];
  const jobs = [
    { payment_id: 'dp-success', status: 'CONFIRMED', tx_hash: validHash },
    { payment_id: 'final-success', status: 'QUEUED', tx_hash: validHash },
    { payment_id: 'unrelated', status: 'CONFIRMED', tx_hash: validHash }
  ];
  assert.deepEqual(buildBookingBlockchainEvidence(payments, jobs), {
    available: true,
    dp: { status: 'CONFIRMED', txHash: validHash },
    final: { status: 'QUEUED', txHash: null }
  });
});

test('all blockchain job states are distinct; invalid, unconfirmed, and missing tx hashes are never exposed', () => {
  for (const status of ['QUEUED', 'SUBMITTED', 'RETRY']) {
    const result = buildBookingBlockchainEvidence(
      [{ id: status, payment_type: 'DP', outcome: 'success' }],
      [{ payment_id: status, status, tx_hash: validHash }]
    );
    assert.equal(result.dp.status, status);
    assert.equal(result.dp.txHash, null);
  }
  const malformed = buildBookingBlockchainEvidence(
    [{ id: 'bad-hash', payment_type: 'DP', outcome: 'success' }],
    [{ payment_id: 'bad-hash', status: 'CONFIRMED', tx_hash: 'javascript:alert(1)' }]
  );
  assert.equal(malformed.dp.status, 'CONFIRMED');
  assert.equal(malformed.dp.txHash, null);
  assert.equal(buildBookingBlockchainEvidence([], []).dp.status, 'NOT_AVAILABLE');
  assert.deepEqual(unavailableBookingBlockchainEvidence().dp, { status: 'UNAVAILABLE', txHash: null });
});

test('customer and vendor evidence card uses safe Etherscan links and explains testnet status', async () => {
  const html = await readFile('frontend/public/index.html', 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\ninitializeLockIn\(\);\s*$/, '');
  const dummyEl = { innerHTML: '', value: '', style: {}, classList: { toggle: () => {} } };
  const context = vm.createContext({
    console, Math, Date, Intl, URL, String, Number, Boolean, Array, Object, JSON, RegExp,
    document: { addEventListener: () => {}, getElementById: () => dummyEl, querySelectorAll: () => [] },
    addEventListener: () => {}, scrollTo: () => {}, history: { pushState: () => {}, replaceState: () => {} },
    location: { hash: '#status' }, fetch: async () => ({ ok: true, json: async () => ({}) })
  });
  context.window = context;
  vm.runInContext(script, context);

  const confirmed = context.blockchainEvidenceCard({ available: true,
    dp: { status: 'CONFIRMED', txHash: validHash },
    final: { status: 'SUBMITTED', txHash: validHash }
  });
  assert.match(confirmed, /Bukti Blockchain/);
  assert.match(confirmed, /Pembayaran booking ini memiliki bukti pencatatan di jaringan Ethereum Sepolia yang dapat diperiksa secara publik\./);
  assert.match(confirmed, /Pembayaran DP/);
  assert.match(confirmed, /Pelunasan/);
  assert.equal((confirmed.match(/https:\/\/sepolia\.etherscan\.io\/tx\//g) || []).length, 1);
  assert.match(confirmed, /Terkonfirmasi di Sepolia/);
  assert.match(confirmed, /Transaksi dikirim, menunggu konfirmasi/);
  assert.match(confirmed, /Apa manfaat blockchain untuk saya\?/);
  assert.match(confirmed, /Transparansi/);
  assert.match(confirmed, /Riwayat yang sulit dimanipulasi/);
  assert.match(confirmed, /Referensi tambahan/);
  assert.match(confirmed, /pembayaran dan escrow masih berupa simulasi/);

  const unsafe = context.blockchainEvidenceCard({ available: true,
    dp: { status: 'CONFIRMED', txHash: 'javascript:alert(1)' },
    final: { status: 'RETRY', txHash: validHash }
  });
  assert.doesNotMatch(unsafe, /href="javascript:/);
  assert.doesNotMatch(unsafe, /Lihat Bukti di Etherscan/);
  assert.match(unsafe, /Menunggu percobaan pencatatan ulang/);
  assert.match(context.blockchainEvidenceCard({ available: true }), /Belum ada job blockchain/);
  assert.match(context.blockchainEvidenceCard(unavailableBookingBlockchainEvidence()), /Status pencatatan tidak dapat dimuat/);
});
