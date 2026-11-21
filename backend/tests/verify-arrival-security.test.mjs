import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

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
let output = '';
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Server tidak siap: ${output}`)), 10000);
  server.stdout.on('data', chunk => {
    output += chunk;
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
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

test('TAHAP 3A: Keamanan backend endpoint verify-arrival dan proteksi OTP kedatangan vendor', async t => {
  await ready;
  t.after(() => server.kill());

  // 1. Authenticate users
  const custLogin = await request('/api/auth/login', {
    method: 'POST', body: { email: 'user@lockin.demo', password: 'LockInDemo123!' }
  });
  assert.equal(custLogin.status, 200);
  const custCookie = custLogin.cookie;

  const vendorLogin = await request('/api/auth/login', {
    method: 'POST', body: { email: 'vendor@lockin.demo', password: 'LockInDemo123!' }
  });
  assert.equal(vendorLogin.status, 200);
  const vendorCookie = vendorLogin.cookie;

  const vendor2Login = await request('/api/auth/login', {
    method: 'POST', body: { email: 'vendor2@lockin.demo', password: 'LockInDemo123!' }
  });
  assert.equal(vendor2Login.status, 200);
  const vendor2Cookie = vendor2Login.cookie;

  const catalog = await request('/api/vendors');
  assert.ok(catalog.data.length >= 4);

  // Helper to create booking with distinct vendor index
  const createBooking = async (vendorIdx, dayOffset) => {
    const v = catalog.data[vendorIdx];
    const res = await request('/api/bookings', {
      cookie: custCookie,
      method: 'POST',
      body: {
        vendorId: v.id,
        packageId: '1',
        date: eventDate(dayOffset),
        location: 'Malang',
        startTime: '08:00',
        agreed: true
      }
    });
    assert.equal(res.status, 201, `Create booking status expected 201, got ${res.status}: ${JSON.stringify(res.data)}`);
    return res.data;
  };

  // Helper to pay DP
  const payDP = async (b) => {
    const res = await request(`/api/bookings/${b.id}/payment`, {
      cookie: custCookie,
      method: 'POST',
      body: { method: 'QRIS', outcome: 'success', expectedState: b.state, paymentType: 'DP' }
    });
    assert.equal(res.status, 200);
    return res.data;
  };

  // Helper to pay Final
  const payFinal = async (b) => {
    const res = await request(`/api/bookings/${b.id}/payment`, {
      cookie: custCookie,
      method: 'POST',
      body: { method: 'QRIS', outcome: 'success', expectedState: b.state, paymentType: 'FINAL', confirmedFinal: true }
    });
    assert.equal(res.status, 200);
    return res.data;
  };

  // =========================================================================
  // Test 1: arrival_code tidak dikirim ke vendor pada GET /api/bookings & GET /api/bookings/:id
  // =========================================================================
  const booking1 = await createBooking(0, 0); // vendor 0, hari H
  assert.ok(booking1.arrival_code, 'Customer creator should receive arrival_code in response');
  assert.match(booking1.arrival_code, /^\d{6}$/);

  // Customer fetches list and detail
  const custList = await request('/api/bookings', { cookie: custCookie });
  const custItem = custList.data.find(b => b.id === booking1.id);
  assert.ok(custItem.arrival_code, 'Customer must see arrival_code in GET /api/bookings');

  const custDetail = await request(`/api/bookings/${booking1.id}`, { cookie: custCookie });
  assert.ok(custDetail.data.arrival_code, 'Customer must see arrival_code in GET /api/bookings/:id');

  // Vendor fetches list and detail
  const vendorList = await request('/api/bookings', { cookie: vendorCookie });
  const vendorItem = vendorList.data.find(b => b.id === booking1.id);
  assert.equal(vendorItem.arrival_code, undefined, 'Vendor MUST NOT receive arrival_code in GET /api/bookings');

  const vendorDetail = await request(`/api/bookings/${booking1.id}`, { cookie: vendorCookie });
  assert.equal(vendorDetail.data.arrival_code, undefined, 'Vendor MUST NOT receive arrival_code in GET /api/bookings/:id');

  // =========================================================================
  // Test 2: Customer tidak dapat menjalankan verify-arrival (403)
  // =========================================================================
  const custVerify = await request(`/api/bookings/${booking1.id}/verify-arrival`, {
    cookie: custCookie,
    method: 'POST',
    body: { otp: booking1.arrival_code }
  });
  assert.equal(custVerify.status, 403, 'Customer must not be allowed to verify arrival');

  // =========================================================================
  // Test 3: Vendor lain tidak dapat menjalankan verify-arrival (403)
  // =========================================================================
  const otherVendorVerify = await request(`/api/bookings/${booking1.id}/verify-arrival`, {
    cookie: vendor2Cookie,
    method: 'POST',
    body: { otp: booking1.arrival_code }
  });
  assert.equal(otherVendorVerify.status, 403, 'Non-owner vendor must be rejected with 403');

  // =========================================================================
  // Test 4: Booking belum Paid ditolak (409)
  // =========================================================================
  // Currently booking1 is 'Pending'
  const pendingVerify = await request(`/api/bookings/${booking1.id}/verify-arrival`, {
    cookie: vendorCookie,
    method: 'POST',
    body: { otp: booking1.arrival_code }
  });
  assert.equal(pendingVerify.status, 409, 'Pending booking cannot be verified for arrival');

  // Pay DP -> state becomes 'DPPaid'
  const dpBooking1 = await payDP(booking1);
  assert.equal(dpBooking1.state, 'DPPaid');
  const dpVerify = await request(`/api/bookings/${booking1.id}/verify-arrival`, {
    cookie: vendorCookie,
    method: 'POST',
    body: { otp: booking1.arrival_code }
  });
  assert.equal(dpVerify.status, 409, 'DPPaid (belum Paid lunas) booking cannot be verified for arrival');

  // =========================================================================
  // Test 5: Booking sebelum hari H ditolak (400)
  // =========================================================================
  const futureBooking = await createBooking(1, 2); // vendor 1, H-2 (lusa)
  const futurePaid = await payFinal(await payDP(futureBooking));
  assert.equal(futurePaid.state, 'Paid');

  const futureVerify = await request(`/api/bookings/${futureBooking.id}/verify-arrival`, {
    cookie: vendorCookie,
    method: 'POST',
    body: { otp: futureBooking.arrival_code }
  });
  assert.equal(futureVerify.status, 400, 'Arrival verification before event date must be rejected with 400');
  assert.match(futureVerify.data.error, /hari pelaksanaan acara/i);

  // =========================================================================
  // Test 6: Booking dibatalkan ditolak (409)
  // =========================================================================
  const cancelBooking = await createBooking(2, 0); // vendor 2, hari H
  await request(`/api/bookings/${cancelBooking.id}/cancel`, { cookie: custCookie, method: 'POST', body: {} });
  const cancelVerify = await request(`/api/bookings/${cancelBooking.id}/verify-arrival`, {
    cookie: vendorCookie,
    method: 'POST',
    body: { otp: cancelBooking.arrival_code }
  });
  assert.equal(cancelVerify.status, 409, 'Cancelled booking cannot be verified for arrival');

  // =========================================================================
  // Test 7: Format OTP tidak 6 digit ditolak (400)
  // =========================================================================
  // Pay booking1 to 'Paid' (it is on day 0 / today)
  const paidBooking1 = await payFinal(dpBooking1);
  assert.equal(paidBooking1.state, 'Paid');

  const invalidFormat1 = await request(`/api/bookings/${booking1.id}/verify-arrival`, {
    cookie: vendorCookie,
    method: 'POST',
    body: { otp: '123' }
  });
  assert.equal(invalidFormat1.status, 400);

  const invalidFormat2 = await request(`/api/bookings/${booking1.id}/verify-arrival`, {
    cookie: vendorCookie,
    method: 'POST',
    body: { otp: 'abcdef' }
  });
  assert.equal(invalidFormat2.status, 400);

  // =========================================================================
  // Test 8: OTP booking lain ditolak (400)
  // =========================================================================
  const booking3 = await createBooking(3, 0); // vendor 3, hari H
  const paidBooking3 = await payFinal(await payDP(booking3));
  assert.equal(paidBooking3.state, 'Paid');

  // Try to verify booking1 using booking3's arrival_code
  const wrongCodeCross = await request(`/api/bookings/${booking1.id}/verify-arrival`, {
    cookie: vendorCookie,
    method: 'POST',
    body: { otp: booking3.arrival_code }
  });
  assert.equal(wrongCodeCross.status, 400);
  assert.match(wrongCodeCross.data.error, /tidak cocok/i);

  // =========================================================================
  // Test 9: Rate Limiting / Brute force protection (5 wrong attempts -> 429 lockout)
  // =========================================================================
  // We already did 1 wrong attempt on booking1. Let's do 3 more wrong attempts (2, 3, 4).
  for (let i = 2; i <= 4; i++) {
    const wrongRes = await request(`/api/bookings/${booking1.id}/verify-arrival`, {
      cookie: vendorCookie,
      method: 'POST',
      body: { otp: '000000' }
    });
    assert.equal(wrongRes.status, 400);
  }
  // 5th wrong attempt -> triggers lockout
  const fifthWrong = await request(`/api/bookings/${booking1.id}/verify-arrival`, {
    cookie: vendorCookie,
    method: 'POST',
    body: { otp: '000000' }
  });
  assert.equal(fifthWrong.status, 429, '5th wrong attempt must trigger 429 rate limit');

  // 6th attempt even with correct OTP should be blocked by rate limit
  const blockedAttempt = await request(`/api/bookings/${booking1.id}/verify-arrival`, {
    cookie: vendorCookie,
    method: 'POST',
    body: { otp: booking1.arrival_code }
  });
  assert.equal(blockedAttempt.status, 429, 'Attempt while locked out must be blocked with 429');

  // =========================================================================
  // Test 10: Verifikasi OTP sah pada hari H & booking Paid berhasil
  // =========================================================================
  // Use paidBooking3 (fresh, not rate-limited)
  const validVerify = await request(`/api/bookings/${booking3.id}/verify-arrival`, {
    cookie: vendorCookie,
    method: 'POST',
    body: { otp: booking3.arrival_code }
  });
  assert.equal(validVerify.status, 200, 'Valid OTP on event day must succeed with 200');
  assert.equal(validVerify.data.ok, true);
  assert.equal(validVerify.data.booking.vendor_arrived, true);
  assert.equal(validVerify.data.booking.execution_state, 'IN_PROGRESS');
  assert.equal(validVerify.data.booking.arrival_code, undefined, 'Response must not leak arrival_code to vendor');

  // =========================================================================
  // Test 11: Verifikasi ganda ditolak (409)
  // =========================================================================
  const duplicateVerify = await request(`/api/bookings/${booking3.id}/verify-arrival`, {
    cookie: vendorCookie,
    method: 'POST',
    body: { otp: booking3.arrival_code }
  });
  assert.equal(duplicateVerify.status, 409, 'Duplicate verification must be rejected with 409');
  assert.match(duplicateVerify.data.error, /sudah pernah diverifikasi/i);

  // =========================================================================
  // Test 12: Status berhasil tersimpan persisten setelah refresh
  // =========================================================================
  const refreshedDetail = await request(`/api/bookings/${booking3.id}`, { cookie: vendorCookie });
  assert.equal(refreshedDetail.status, 200);
  assert.equal(refreshedDetail.data.vendor_arrived, true);
  assert.equal(refreshedDetail.data.execution_state, 'IN_PROGRESS');
  assert.equal(refreshedDetail.data.executionStatus, 'IN_PROGRESS');
  assert.equal(refreshedDetail.data.arrival_code, undefined);

  const refreshedCustDetail = await request(`/api/bookings/${booking3.id}`, { cookie: custCookie });
  assert.equal(refreshedCustDetail.status, 200);
  assert.equal(refreshedCustDetail.data.vendor_arrived, true);
  assert.equal(refreshedCustDetail.data.executionStatus, 'IN_PROGRESS');
  assert.equal(refreshedCustDetail.data.arrival_code, booking3.arrival_code);
});
