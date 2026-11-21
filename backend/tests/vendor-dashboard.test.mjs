import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

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
  return new Date(Date.UTC(Number(parts.find(p => p.type === 'year').value), Number(parts.find(p => p.type === 'month').value) - 1, Number(parts.find(p => p.type === 'day').value) + daysAhead)).toISOString().slice(0, 10);
}

async function request(path, { cookie, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, {
    method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

test('vendor dashboard loads authenticated bookings from API with verified fund totals', async t => {
  await ready;
  t.after(() => server.kill());
  const html = await readFile('frontend/public/index.html', 'utf8');
  const dashboardStart = html.indexOf('dashboard:function(){');
  const dashboardEnd = html.indexOf('admin:function(){', dashboardStart);
  const dashboard = html.slice(dashboardStart, dashboardEnd);
  assert.match(html, /dashboard:'vendor'/);
  assert.match(dashboard, /S\.role!=='vendor'/);
  assert.doesNotMatch(dashboard, /Rani|Sarah|Rp131\.670/);

  const catalog = await request('/api/vendors');
  const customerLogin = await request('/api/auth/login', { method: 'POST', body: { email: 'user@lockin.demo', password: 'LockInDemo123!' } });
  const customerCookie = customerLogin.cookie;
  const create = (vendor, day) => request('/api/bookings', {
    cookie: customerCookie, method: 'POST', body: { vendorId: vendor.id, packageId: '1', date: eventDate(day), location: 'Malang', startTime: '08:00', agreed: true }
  });
  const lolitaVendor = catalog.data.find(v => v.name === 'Lolita Makeup');
  const magdaVendor = catalog.data.find(v => v.name === 'Magda MUA');
  const lolita = await create(lolitaVendor, 19);
  const magda = await create(magdaVendor, 20);
  assert.equal(lolita.status, 201);
  assert.equal(magda.status, 201);

  const vendorLogin = await request('/api/auth/login', { method: 'POST', body: { email: 'vendor@lockin.demo', password: 'LockInDemo123!' } });
  const vendorBookings = await request('/api/bookings', { cookie: vendorLogin.cookie });
  const lolitaRow = vendorBookings.data.find(b => b.id === lolita.data.id);
  const magdaRow = vendorBookings.data.find(b => b.id === magda.data.id);
  assert.ok(lolitaRow);
  assert.ok(magdaRow);
  assert.equal(lolitaRow.vendor_name, 'Lolita Makeup');
  assert.equal(magdaRow.vendor_name, 'Magda MUA');
  assert.equal(lolitaRow.customer_name, 'Pelanggan Demo');
  assert.equal(lolitaRow.package_name, 'Paket Hemat / Basic');
  assert.equal(lolitaRow.event_date, eventDate(19));
  assert.equal(lolitaRow.location, 'Malang');
  assert.equal(lolitaRow.price, 199000);
  assert.ok(lolitaRow.paymentBreakdownVerified);
  assert.deepEqual(lolitaRow.paymentBreakdown, { dpAmount: 0, finalAmount: 0 });
  assert.ok(magdaRow.paymentBreakdownVerified);
  const afterRefresh = await request('/api/bookings', { cookie: vendorLogin.cookie });
  assert.deepEqual(afterRefresh.data.find(b => b.id === lolita.data.id), lolitaRow);
  assert.deepEqual(afterRefresh.data.find(b => b.id === magda.data.id), magdaRow);

  assert.equal((await request(`/api/bookings/${lolita.data.id}`, { cookie: customerCookie })).status, 200);
  const customerBookings = await request('/api/bookings', { cookie: customerCookie });
  assert.ok(customerBookings.data.some(b => b.id === lolita.data.id));
  assert.equal((await request(`/api/bookings/${lolita.data.id}`)).status, 401);
});
