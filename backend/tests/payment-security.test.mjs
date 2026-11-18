import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifySignature, interpretNotification } from '../src/services/midtrans.js';

const serverKey = 'SB-Mid-server-FAKE-LOCAL-TEST';
const valid = {
  order_id: 'LOCKIN-DP-TEST-001',
  status_code: '200',
  gross_amount: '300000.00',
  transaction_status: 'settlement'
};

function signed(fields, key = serverKey) {
  return {
    ...fields,
    signature_key: createHash('sha512')
      .update(fields.order_id + fields.status_code + fields.gross_amount + key)
      .digest('hex')
  };
}

test('Signature sah diterima', () => {
  assert.equal(verifySignature(signed(valid), serverKey), true);
});

test('Nominal diubah setelah tanda tangan -> ditolak', () => {
  assert.equal(verifySignature({ ...signed(valid), gross_amount: '1.00' }, serverKey), false);
});

test('Order ID diubah setelah tanda tangan -> ditolak', () => {
  assert.equal(verifySignature({ ...signed(valid), order_id: 'PESANAN-LAIN' }, serverKey), false);
});

test('Status code diubah setelah tanda tangan -> ditolak', () => {
  assert.equal(verifySignature({ ...signed(valid), status_code: '201' }, serverKey), false);
});

test('Server key berbeda -> ditolak', () => {
  assert.equal(verifySignature(signed(valid), 'KUNCI-SALAH'), false);
});

test('Signature hilang atau rusak -> ditolak', () => {
  assert.equal(verifySignature(valid, serverKey), false);
  assert.equal(verifySignature({ ...valid, signature_key: 'rusak' }, serverKey), false);
});

test('Pending, challenge, dan authorize tanpa settlement tidak dianggap PAID', () => {
  assert.equal(interpretNotification({ transaction_status: 'pending' }), 'PENDING');
  assert.equal(interpretNotification({ transaction_status: 'capture', fraud_status: 'challenge' }), 'PENDING');
  assert.equal(interpretNotification({ transaction_status: 'authorize' }), 'PENDING');
});

test('Settlement dan capture dengan fraud accept dianggap PAID', () => {
  assert.equal(interpretNotification({ transaction_status: 'settlement' }), 'PAID');
  assert.equal(interpretNotification({ transaction_status: 'capture', fraud_status: 'accept' }), 'PAID');
});

test('Expire, cancel, failure, deny ditandai non-PAID', () => {
  assert.equal(interpretNotification({ transaction_status: 'expire' }), 'EXPIRED');
  for (const status of ['cancel', 'failure', 'deny']) {
    assert.equal(interpretNotification({ transaction_status: status }), 'FAILED');
  }
});
