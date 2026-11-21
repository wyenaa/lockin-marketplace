import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const server = spawn(process.execPath, ['backend/src/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: '0',
    HOST: '127.0.0.1',
    SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    MIDTRANS_SERVER_KEY: '',
    CONTRACT_ADDRESS: '',
    PRIVATE_KEY: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let baseUrl;
let startupOutput = '';
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Server tidak siap: ${startupOutput}`)), 10000);
  server.stdout.on('data', chunk => {
    startupOutput += chunk;
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(startupOutput);
    if (match) {
      clearTimeout(timer);
      baseUrl = `http://127.0.0.1:${match[1]}`;
      resolve();
    }
  });
  server.once('error', reject);
});

function eventDate(daysAhead) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const today = new Date(Date.UTC(
    Number(parts.find(p => p.type === 'year').value),
    Number(parts.find(p => p.type === 'month').value) - 1,
    Number(parts.find(p => p.type === 'day').value) + daysAhead
  ));
  return today.toISOString().slice(0, 10);
}

async function request(path, { cookie, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

test('customer cancellation persists refund and blocks repeated or unauthorized cancellation', async t => {
  await ready;
  t.after(() => server.kill());
  const activeFrontend = await readFile('frontend/public/index.html', 'utf8');
  assert.match(activeFrontend, /function initializeLockIn\(\)/);
  assert.match(activeFrontend, /apiRequest\('\/api\/bookings'\)/);
  assert.match(activeFrontend, /data-a="cancel-booking"/);

  const login = await request('/api/auth/login', {
    method: 'POST', body: { email: 'user@lockin.demo', password: 'LockInDemo123!' }
  });
  assert.equal(login.status, 200);
  const cookie = login.cookie;
  const vendorIds = [1, 2, 3, 4, 5, 6].map(n => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
  const create = async (vendorIndex, daysAhead) => {
    const result = await request('/api/bookings', {
      cookie, method: 'POST', body: {
        vendorId: vendorIds[vendorIndex - 1], packageId: '1', date: eventDate(daysAhead), location: 'Malang', startTime: '08:00', agreed: true
      }
    });
    assert.equal(result.status, 201);
    return result.data;
  };
  const pay = async booking => {
    const result = await request(`/api/bookings/${booking.id}/payment`, {
      cookie, method: 'POST', body: { method: 'QRIS', outcome: 'success', expectedState: booking.state, paymentType: booking.state === 'DPPaid' ? 'FINAL' : 'DP', confirmedFinal: booking.state === 'DPPaid' }
    });
    assert.equal(result.status, 200);
    return result.data;
  };
  const cancel = (booking, auth = cookie) => request(`/api/bookings/${booking.id}/cancel`, { cookie: auth, method: 'POST', body: {} });

  const beforeDp = await create(2, 7);
  const beforeDpCancelled = await cancel(beforeDp);
  assert.equal(beforeDpCancelled.status, 200);
  assert.equal(beforeDpCancelled.data.refund, 0);
  assert.equal(beforeDpCancelled.data.cancellation_not_refunded, 0);

  const afterDp = await pay(await create(3, 7));
  const refreshedList = await request('/api/bookings', { cookie });
  assert.equal(refreshedList.data.find(booking => booking.id === afterDp.id)?.state, 'DPPaid');
  assert.equal(refreshedList.data.find(booking => booking.id === afterDp.id)?.paid, afterDp.paid);
  const afterDpEstimate = await request(`/api/bookings/${afterDp.id}/refund-estimate`, { cookie });
  const afterDpCancelled = await cancel(afterDp);
  assert.equal(afterDpCancelled.data.refund, afterDpEstimate.data.estimate.refundAmount);
  assert.equal(afterDpCancelled.data.cancellation_refund_tier, 'H7_OR_MORE');
  const cancelledBooking = await request(`/api/bookings/${afterDp.id}`, { cookie });
  assert.equal(cancelledBooking.data.state, 'Cancelled');
  assert.equal(cancelledBooking.data.cancellation_refund, afterDpEstimate.data.estimate.refundAmount);

  const afterFullDp = await pay(await create(4, 7));
  const full = await pay(afterFullDp);
  const fullyPaidCancelled = await cancel(full);
  assert.equal(fullyPaidCancelled.data.refund, Math.round(full.price * 0.7));

  const h3 = await pay(await create(5, 3));
  const h3Estimate = await request(`/api/bookings/${h3.id}/refund-estimate`, { cookie });
  const h3Cancelled = await cancel(h3);
  assert.equal(h3Cancelled.data.cancellation_refund_tier, 'H3_TO_H6');
  assert.equal(h3Cancelled.data.refund, h3Estimate.data.estimate.refundAmount);

  const h1 = await create(6, 1);
  const h1Cancelled = await cancel(h1);
  assert.equal(h1Cancelled.data.cancellation_refund_tier, 'H0_TO_H2');
  assert.equal(h1Cancelled.data.refund, 0);

  const repeat = await cancel(h1);
  assert.equal(repeat.status, 409);

  const stillActive = await create(6, 8);
  const stillActiveRead = await request(`/api/bookings/${stillActive.id}`, { cookie });
  assert.equal(stillActiveRead.data.state, 'Pending');

  const vendorLogin = await request('/api/auth/login', {
    method: 'POST', body: { email: 'vendor@lockin.demo', password: 'LockInDemo123!' }
  });
  const unauthorized = await cancel(stillActive, vendorLogin.cookie);
  assert.equal(unauthorized.status, 403);

  const flowBooking = await create(1, 12);
  const dpRequests = await Promise.all([1, 2].map(() => request(`/api/bookings/${flowBooking.id}/payment`, {
    cookie, method: 'POST', body: { method: 'QRIS', outcome: 'success', expectedState: flowBooking.state, paymentType: 'DP', confirmedFinal: false }
  })));
  assert.deepEqual(dpRequests.map(result => result.status).sort(), [200, 409]);
  const afterRefresh = await request('/api/bookings', { cookie });
  const refreshedDp = afterRefresh.data.find(booking => booking.id === flowBooking.id);
  assert.equal(refreshedDp.state, 'DPPaid');
  assert.equal(refreshedDp.paymentStatus, 'DP_PAID');
  assert.equal(refreshedDp.executionStatus, 'NOT_STARTED');
  const accidentalFinal = await request(`/api/bookings/${flowBooking.id}/payment`, {
    cookie, method: 'POST', body: { method: 'QRIS', outcome: 'success', expectedState: 'DPPaid', paymentType: 'FINAL' }
  });
  assert.equal(accidentalFinal.status, 400);
  const finalResult = await request(`/api/bookings/${flowBooking.id}/payment`, {
    cookie, method: 'POST', body: { method: 'QRIS', outcome: 'success', expectedState: 'DPPaid', paymentType: 'FINAL', confirmedFinal: true }
  });
  assert.equal(finalResult.status, 200);
  const afterFinalRefresh = await request(`/api/bookings/${flowBooking.id}`, { cookie });
  assert.equal(afterFinalRefresh.data.state, 'Paid');
  assert.equal(afterFinalRefresh.data.paymentStatus, 'PAID');
  assert.equal(afterFinalRefresh.data.executionStatus, 'NOT_STARTED');
  const repeatedFinal = await request(`/api/bookings/${flowBooking.id}/payment`, {
    cookie, method: 'POST', body: { method: 'QRIS', outcome: 'success', expectedState: 'Paid', paymentType: 'FINAL', confirmedFinal: true }
  });
  assert.equal(repeatedFinal.status, 409);
});
