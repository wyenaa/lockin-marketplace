const VALID_STATUSES = new Set(['CONFIRMED', 'QUEUED', 'SUBMITTED', 'RETRY']);
const TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

function emptyRow(status) {
  return { status, txHash: null };
}

export function unavailableBookingBlockchainEvidence() {
  return {
    available: false,
    dp: emptyRow('UNAVAILABLE'),
    final: emptyRow('UNAVAILABLE')
  };
}

export function buildBookingBlockchainEvidence(payments, jobs) {
  if (!Array.isArray(payments) || !Array.isArray(jobs)) return unavailableBookingBlockchainEvidence();

  const successfulByType = { DP: [], FINAL: [] };
  for (const payment of payments) {
    if (payment?.outcome === 'success' && successfulByType[payment.payment_type])
      successfulByType[payment.payment_type].push(payment);
  }

  const evidence = { available: true, dp: emptyRow('NOT_AVAILABLE'), final: emptyRow('NOT_AVAILABLE') };
  const timestamp = value => {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
  };
  for (const [paymentType, key] of [['DP', 'dp'], ['FINAL', 'final']]) {
    const latestPayment = successfulByType[paymentType]
      .sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at))[0];
    if (!latestPayment) continue;

    const job = jobs.find(row => row.payment_id === latestPayment.id);
    if (!job) continue;
    const status = VALID_STATUSES.has(job.status) ? job.status : 'UNKNOWN';
    const txHash = status === 'CONFIRMED' && typeof job.tx_hash === 'string' && TX_HASH_PATTERN.test(job.tx_hash)
      ? job.tx_hash
      : null;
    evidence[key] = { status, txHash };
  }
  return evidence;
}
