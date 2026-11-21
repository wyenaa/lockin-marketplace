import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const server = spawn(process.execPath, ['backend/src/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: '0', HOST: '127.0.0.1', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', MIDTRANS_SERVER_KEY: '', CONTRACT_ADDRESS: '', PRIVATE_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let baseUrl;
let output = '';
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Server tidak siap: ${output}`)), 10000);
  server.stdout.on('data', chunk => {
    output += chunk;
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match) { clearTimeout(timer); baseUrl = `http://127.0.0.1:${match[1]}`; resolve(); }
  });
  server.once('error', reject);
});

function eventDate(daysAhead) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const today = new Date(Date.UTC(Number(parts.find(p => p.type === 'year').value), Number(parts.find(p => p.type === 'month').value) - 1, Number(parts.find(p => p.type === 'day').value) + daysAhead));
  return today.toISOString().slice(0, 10);
}

async function request(path, { cookie, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, {
    method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

test('catalog UUIDs and backend package prices persist on separate bookings', async t => {
  await ready;
  t.after(() => server.kill());
  const catalog = await request('/api/vendors');
  assert.equal(catalog.status, 200);
  assert.equal(catalog.data.length, 9);
  assert.equal(catalog.data.filter(v => v.name === 'Makeup Rinsil').length, 1);
  assert.ok(catalog.data.every(v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.id)));

  const login = await request('/api/auth/login', { method: 'POST', body: { email: 'user@lockin.demo', password: 'LockInDemo123!' } });
  assert.equal(login.status, 200);
  const cookie = login.cookie;
  const vendorA = catalog.data[0];
  const vendorB = catalog.data[1];
  const detailA = await request(`/api/vendors/${vendorA.id}`);
  assert.equal(detailA.status, 200);
  assert.equal(detailA.data.id, vendorA.id);
  assert.deepEqual(detailA.data.packages.map(pkg => pkg.price), [199000, 249000, 299000]);
  const makeBooking = (vendor, packageId, day) => request('/api/bookings', {
    cookie, method: 'POST', body: { vendorId: vendor.id, packageId, date: eventDate(day), location: 'Malang', startTime: '08:00', agreed: true }
  });

  const first = await makeBooking(vendorA, '3', 14);
  const second = await makeBooking(vendorB, '2', 15);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.data.vendor_id, vendorA.id);
  assert.equal(detailA.data.id, first.data.vendor_id);
  assert.equal(second.data.vendor_id, vendorB.id);
  assert.equal(first.data.price, 299000);
  assert.equal(first.data.package_id, '3');
  assert.equal(second.data.price, 313000);
  assert.equal(second.data.package_id, '2');

  const refreshed = await request('/api/bookings', { cookie });
  const savedA = refreshed.data.find(b => b.id === first.data.id);
  const savedB = refreshed.data.find(b => b.id === second.data.id);
  assert.equal(savedA.vendor_id, vendorA.id);
  assert.equal(savedA.price, 299000);
  assert.equal(savedA.package_name, first.data.package_name);
  assert.equal(savedB.vendor_id, vendorB.id);
  assert.equal(savedB.price, 313000);

  const payDp = booking => request(`/api/bookings/${booking.id}/payment`, {
    cookie, method: 'POST', body: { method: 'QRIS', outcome: 'success', expectedState: 'Pending', paymentType: 'DP', confirmedFinal: false }
  });
  const dpA = await payDp(first.data);
  const dpB = await payDp(second.data);
  assert.equal(dpA.data.state, 'DPPaid');
  assert.equal(dpB.data.state, 'DPPaid');
  const finalA = await request(`/api/bookings/${first.data.id}/payment`, {
    cookie, method: 'POST', body: { method: 'QRIS', outcome: 'success', expectedState: 'DPPaid', paymentType: 'FINAL', confirmedFinal: true }
  });
  const finalB = await request(`/api/bookings/${second.data.id}/payment`, {
    cookie, method: 'POST', body: { method: 'QRIS', outcome: 'success', expectedState: 'DPPaid', paymentType: 'FINAL', confirmedFinal: true }
  });
  assert.equal(finalA.data.paymentAmount, 209300);
  assert.equal(finalB.data.paymentAmount, 219100);
  const paidRefreshA = await request(`/api/bookings/${first.data.id}`, { cookie });
  const paidRefreshB = await request(`/api/bookings/${second.data.id}`, { cookie });
  assert.equal(paidRefreshA.data.vendor_id, vendorA.id);
  assert.equal(paidRefreshA.data.paid, 299000);
  assert.deepEqual(paidRefreshA.data.paymentBreakdown, { dpAmount: 89700, finalAmount: 209300 });
  assert.equal(paidRefreshB.data.vendor_id, vendorB.id);
  assert.equal(paidRefreshB.data.paid, 313000);
  assert.deepEqual(paidRefreshB.data.paymentBreakdown, { dpAmount: 93900, finalAmount: 219100 });

  const hairdo = catalog.data.find(v => v.name === 'Lolita Makeup (add-on hairdo)');
  const target = await makeBooking(hairdo, '1', 17);
  assert.equal(target.status, 201);
  assert.equal(target.data.price, 100000);
  assert.equal((await request(`/api/bookings/${target.data.id}`)).status, 401);
  const targetDp = await request(`/api/bookings/${target.data.id}/payment`, {
    cookie, method: 'POST', body: { method: 'QRIS', outcome: 'success', expectedState: 'Pending', paymentType: 'DP', confirmedFinal: false }
  });
  assert.equal(targetDp.data.paid, 30000);
  const afterDp = await request(`/api/bookings/${target.data.id}`, { cookie });
  assert.deepEqual(afterDp.data.paymentBreakdown, { dpAmount: 30000, finalAmount: 0 });
  assert.equal(afterDp.data.paid, 30000);
  const failedFinal = await request(`/api/bookings/${target.data.id}/payment`, {
    cookie, method: 'POST', body: { method: 'QRIS', outcome: 'failed', expectedState: 'DPPaid', paymentType: 'FINAL', confirmedFinal: true }
  });
  assert.equal(failedFinal.data.paymentAmount, 70000);
  const afterFailedFinal = await request(`/api/bookings/${target.data.id}`, { cookie });
  assert.deepEqual(afterFailedFinal.data.paymentBreakdown, { dpAmount: 30000, finalAmount: 0 });
  assert.equal(afterFailedFinal.data.paid, 30000);
  const targetFinal = await request(`/api/bookings/${target.data.id}/payment`, {
    cookie, method: 'POST', body: { method: 'QRIS', outcome: 'success', expectedState: 'DPPaid', paymentType: 'FINAL', confirmedFinal: true }
  });
  assert.equal(targetFinal.data.paymentAmount, 70000);
  const afterFinal = await request(`/api/bookings/${target.data.id}`, { cookie });
  assert.deepEqual(afterFinal.data.paymentBreakdown, { dpAmount: 30000, finalAmount: 70000 });
  assert.equal(afterFinal.data.paid, 100000);

  const invalidPackage = await makeBooking(vendorA, '99', 16);
  assert.equal(invalidPackage.status, 400);
});
