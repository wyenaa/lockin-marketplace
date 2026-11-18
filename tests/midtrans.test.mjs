import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifySignature, interpretNotification } from '../src/midtrans.js';

test('signature valid hanya bila seluruh data dan server key cocok', () => {
  const serverKey = 'SB-Mid-server-DUMMY';
  const data = { order_id: 'LOCKIN-TEST-001', status_code: '200', gross_amount: '300000.00', transaction_status: 'settlement' };
  const signature_key = createHash('sha512').update(data.order_id+data.status_code+data.gross_amount+serverKey).digest('hex');
  assert.equal(verifySignature({...data,signature_key},serverKey), true);
  assert.equal(verifySignature({...data, gross_amount:'100000.00',signature_key},serverKey), false);
  assert.equal(verifySignature({...data,signature_key:'abc'},serverKey), false);
});

test('status pembayaran dipetakan tanpa menganggap pending sebagai berhasil', () => {
  assert.equal(interpretNotification({transaction_status:'pending'}),'PENDING');
  assert.equal(interpretNotification({transaction_status:'settlement'}),'PAID');
  assert.equal(interpretNotification({transaction_status:'capture', fraud_status:'challenge'}),'PENDING');
  assert.equal(interpretNotification({transaction_status:'expire'}),'EXPIRED');
});
