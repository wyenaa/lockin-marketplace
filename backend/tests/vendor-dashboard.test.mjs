import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

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

test('customer and vendor display backend release states consistently without inferring payout from Completed', async () => {
  const html = await readFile('frontend/public/index.html', 'utf8');
  const jsCode = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\ninitializeLockIn\(\);\s*$/, '');
  const dummyEl = { innerHTML: '', value: '', style: {}, classList: { toggle: () => {} } };
  const mockContext = {
    console, Math, Date, Intl, URL, String, Number, Boolean, Array, Object, JSON, RegExp,
    encodeURIComponent, addEventListener: () => {}, scrollTo: () => {},
    document: { addEventListener: () => {}, getElementById: () => dummyEl, querySelectorAll: () => [] },
    history: { pushState: () => {}, replaceState: () => {} },
    location: { hash: '#status' },
    fetch: async () => ({ ok: true, json: async () => ({}) })
  };
  mockContext.window = mockContext;
  const context = vm.createContext(mockContext);
  vm.runInContext(jsCode, context);

  const baseBooking = overrides => Object.assign({
    id: 'LI-RELEASE-UI', state: 'Paid', paymentStatus: 'PAID', executionStatus: 'IN_PROGRESS', execution_state: 'IN_PROGRESS',
    price: 100000, deposit: 0, paid: 100000, dpPaid: 30000, finalPaid: 70000, rest: 70000,
    date: 'Hari ini', event_date: new Date().toISOString().slice(0, 10), start_time: '08:00', location: 'Malang',
    vendor_name: 'Vendor Test', customer_name: 'Pelanggan Test', package_name: 'Paket Basic', vendor_arrived: true, arrived: true,
    paymentBreakdown: { dpAmount: 30000, finalAmount: 70000 }, paymentBreakdownVerified: true,
    release: { simulated: true, status: 'HELD', amount: 70000, releasedAt: null }
  }, overrides || {});
  const renderCustomer = booking => {
    context.S.role = 'customer';
    context.S.activeBid = booking.id;
    context.S.bookingsList = [booking];
    return context.pages.status();
  };
  const renderVendor = bookings => {
    context.S.role = 'vendor';
    context.S.vendorBookings = bookings;
    context.S.vendorDashboardLoading = false;
    context.S.vendorDashboardError = '';
    context.S.activeVendorBid = bookings[0]?.id || '';
    context.S.vendorDetail = bookings[0] || null;
    context.S.vendorDetailLoading = false;
    context.S.vendorDetailError = '';
    return context.pages.dashboard();
  };

  const held = baseBooking({});
  const heldCustomer = renderCustomer(held);
  const heldVendor = renderVendor([held]);
  assert.match(heldCustomer, /Status Dana \(Simulasi\)/);
  assert.match(heldCustomer, /Dana Ditahan \(Simulasi\)/);
  assert.match(heldCustomer, /Rp70\.000/);
  assert.match(heldVendor, /Dana Ditahan \(Simulasi\)/);
  assert.match(heldVendor, /Rp70\.000/);
  const depositBooking = baseBooking({ id: 'LI-DEPOSIT', price: 80000, deposit: 20000, paid: 100000, release: { simulated: true, status: 'RELEASED', amount: 80000, releasedAt: '2026-11-22T02:30:00.000Z' } });
  const depositCard = context.releaseStatusCard(depositBooking);
  assert.match(depositCard, /Dana jasa<\/span><b>Rp80\.000/);
  assert.match(depositCard, /Deposit vendor \(terpisah dari dana jasa\)<\/span><b>Rp20\.000/);

  const releasedAt = '2026-11-22T02:30:00.000Z';
  const released = baseBooking({ id: 'LI-RELEASED', state: 'Completed', executionStatus: 'COMPLETED', execution_state: 'COMPLETED', release: { simulated: true, status: 'RELEASED', amount: 100000, releasedAt } });
  const releasedCustomer = renderCustomer(released);
  const releasedVendor = renderVendor([released]);
  assert.match(releasedCustomer, /Dicairkan \(Simulasi\)/);
  assert.match(releasedCustomer, /Rp100\.000/);
  assert.match(releasedCustomer, /Waktu pencairan/);
  assert.match(releasedVendor, /Dicairkan \(Simulasi\)/);
  assert.match(releasedVendor, /Rp100\.000/);
  assert.match(releasedVendor, /2026/);

  const onHold = baseBooking({ id: 'LI-ON-HOLD', state: 'Disputed', release: { simulated: true, status: 'ON_HOLD', amount: 70000, releasedAt: null } });
  const onHoldCustomer = renderCustomer(onHold);
  const onHoldVendor = renderVendor([onHold]);
  assert.match(onHoldCustomer, /Dana Ditahan \(Simulasi\)/);
  assert.match(onHoldCustomer, /sengketa sedang berlangsung/);
  assert.match(onHoldVendor, /Dana Ditahan \(Simulasi\)/);
  assert.doesNotMatch(onHoldVendor, /Pencairan Ditahan/);

  const unpaid = baseBooking({ id: 'LI-UNPAID', state: 'Pending', paymentStatus: 'UNPAID', paid: 0, dpPaid: 0, finalPaid: 0, release: undefined });
  assert.match(renderCustomer(unpaid), /Belum ada dana tercatat/);
  const unpaidVendor = renderVendor([unpaid]);
  assert.match(unpaidVendor, /Belum ada dana tercatat/);

  const completedWithoutRelease = baseBooking({ id: 'LI-LEGACY-COMPLETED', state: 'Completed', executionStatus: 'COMPLETED', execution_state: 'COMPLETED', release: undefined });
  const legacyCustomer = renderCustomer(completedWithoutRelease);
  const legacyVendor = renderVendor([completedWithoutRelease]);
  assert.match(legacyCustomer, /Status dana belum dapat diverifikasi/);
  assert.match(legacyCustomer, /belum memberikan catatan release/);
  assert.doesNotMatch(legacyCustomer, /Dicairkan \(Simulasi\)/);
  assert.match(legacyVendor, /Belum dapat diverifikasi dari backend/);
  assert.doesNotMatch(legacyVendor, /Dicairkan \(Simulasi\)/);

  const completedHeld = baseBooking({ id: 'LI-COMPLETED-HELD', state: 'Completed', release: { simulated: true, status: 'ON_HOLD', amount: 80000, releasedAt: null } });
  const completedHeldCustomer = renderCustomer(completedHeld);
  assert.match(completedHeldCustomer, /Dana Ditahan \(Simulasi\)/);
  assert.match(completedHeldCustomer, /Layanan selesai, pencairan belum tercatat/);
  assert.match(renderVendor([completedHeld]), /Dana Ditahan \(Simulasi\)/);

  const incompleteRelease = baseBooking({ id: 'LI-INCOMPLETE-RELEASE', state: 'Completed', release: { simulated: true, status: 'RELEASED', releasedAt } });
  assert.match(renderCustomer(incompleteRelease), /Status dana belum dapat diverifikasi/);
  assert.doesNotMatch(renderCustomer(incompleteRelease), /Dicairkan \(Simulasi\)/);

  const heldAggregate = baseBooking({ id: 'LI-HELD-AGG', release: { simulated: true, status: 'HELD', amount: 70000, releasedAt: null } });
  const releasedAggregate = baseBooking({ id: 'LI-RELEASE-AGG', state: 'Completed', release: { simulated: true, status: 'RELEASED', amount: 100000, releasedAt } });
  const onHoldAggregate = baseBooking({ id: 'LI-ON-HOLD-AGG', state: 'Disputed', release: { simulated: true, status: 'ON_HOLD', amount: 30000, releasedAt: null } });
  const aggregateHtml = renderVendor([heldAggregate, releasedAggregate, onHoldAggregate]);
  assert.match(aggregateHtml, /Dana Ditahan \(Simulasi\)<\/span><b>Rp100\.000/);
  assert.doesNotMatch(aggregateHtml, /Pencairan Ditahan/);
  assert.match(aggregateHtml, /Dicairkan \(Simulasi\)<\/span><b>Rp100\.000/);
  assert.doesNotMatch(aggregateHtml, /Dana Ditahan \(Simulasi\)<\/span><b>Rp170\.000/);
});
