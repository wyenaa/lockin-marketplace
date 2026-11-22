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
  return new Date(Date.UTC(Number(parts.find(part => part.type === 'year').value), Number(parts.find(part => part.type === 'month').value) - 1, Number(parts.find(part => part.type === 'day').value) + daysAhead)).toISOString().slice(0, 10);
}

async function request(path, { cookie, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

test('admin summary enforces roles and counts total, active, and open disputes from booking states', async () => {
  await ready;
  assert.equal((await request('/api/admin/summary')).status, 401);
  const login = async email => request('/api/auth/login', { method: 'POST', body: { email, password: 'LockInDemo123!' } });
  const customer = await login('user@lockin.demo');
  const vendor = await login('vendor@lockin.demo');
  const admin = await login('admin@lockin.demo');
  assert.equal((await request('/api/admin/summary', { cookie: customer.cookie })).status, 403);
  assert.equal((await request('/api/admin/summary', { cookie: vendor.cookie })).status, 403);

  const catalog = await request('/api/vendors');
  const vendorId = catalog.data[0].id;
  const create = (days, packageId = '1') => request('/api/bookings', {
    cookie: customer.cookie, method: 'POST',
    body: { vendorId, packageId, date: eventDate(days), location: 'Malang', startTime: '08:00', agreed: true }
  });
  const disputedBooking = await create(20);
  assert.equal(disputedBooking.status, 201);
  const paid = await request(`/api/bookings/${disputedBooking.data.id}/payment`, {
    cookie: customer.cookie, method: 'POST',
    body: { method: 'QRIS', outcome: 'success', expectedState: 'Pending', paymentType: 'DP' }
  });
  assert.equal(paid.status, 200);
  const dispute = await request(`/api/bookings/${disputedBooking.data.id}/dispute`, {
    cookie: customer.cookie, method: 'POST', body: { reason: 'Bukti layanan kurang', evidence: 'Bukti uji sengketa' }
  });
  assert.equal(dispute.status, 201);

  const cancelledBooking = await create(25);
  assert.equal(cancelledBooking.status, 201);
  const cancelled = await request(`/api/bookings/${cancelledBooking.data.id}/cancel`, { cookie: customer.cookie, method: 'POST', body: {} });
  assert.equal(cancelled.status, 200);

  const allBookings = await request('/api/bookings', { cookie: admin.cookie });
  const summary = await request('/api/admin/summary', { cookie: admin.cookie });
  assert.equal(summary.status, 200);
  const activeStates = ['Pending', 'WaitingVendorApproval', 'DPPaid', 'Paid', 'Disputed'];
  assert.deepEqual(summary.data.activeBookingStates, activeStates);
  assert.equal(summary.data.totalBookings, allBookings.data.length);
  assert.equal(summary.data.activeBookings, allBookings.data.filter(booking => activeStates.includes(booking.state)).length);
  assert.equal(summary.data.openDisputes, allBookings.data.filter(booking => booking.state === 'Disputed').length);
  assert.equal(summary.data.totalBookings, 3);
  assert.equal(summary.data.activeBookings, 2);
  assert.equal(summary.data.openDisputes, 1);
  assert.deepEqual(summary.data.smartContractFunds, { available: false, label: 'Belum tersedia' });
});

test('vendor application list is admin-only and ordered newest-first', async () => {
  await ready;
  assert.equal((await request('/api/admin/vendor-applications')).status, 401);
  const login = async email => request('/api/auth/login', { method: 'POST', body: { email, password: 'LockInDemo123!' } });
  const customer = await login('user@lockin.demo');
  const vendor = await login('vendor@lockin.demo');
  const admin = await login('admin@lockin.demo');
  assert.equal((await request('/api/admin/vendor-applications', { cookie: customer.cookie })).status, 403);
  assert.equal((await request('/api/admin/vendor-applications', { cookie: vendor.cookie })).status, 403);

  const payload = name => ({ brandName: name, ownerName: 'Pemilik Uji', email: 'uji@example.id', whatsapp: '081234567890', category: 'MUA', city: 'Surabaya', basePrice: 150000, instagram: '@usaha.uji', portfolioUrl: 'https://example.id/portfolio', description: 'Deskripsi lengkap uji.' });
  const older = await request('/api/vendor-applications', { method: 'POST', body: payload('Usaha Lama') });
  await new Promise(resolve => setTimeout(resolve, 10));
  const newer = await request('/api/vendor-applications', { method: 'POST', body: payload('Usaha Baru') });
  assert.equal(older.status, 201);
  assert.equal(newer.status, 201);

  const listed = await request('/api/admin/vendor-applications', { cookie: admin.cookie });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.map(application => application.id), [newer.data.application.id, older.data.application.id]);
  assert.equal(listed.data[0].status, 'pending_approval');
  assert.equal(listed.data[0].city, 'Surabaya');
  assert.equal(listed.data[0].base_price, 150000);
  assert.equal(listed.data[0].portfolio_url, 'https://example.id/portfolio');
  assert.equal(listed.data[0].description, 'Deskripsi lengkap uji.');
});

test('admin panel renders API indicators with loading and error states and no hardcoded values', async () => {
  const html = await readFile('frontend/public/index.html', 'utf8');
  const start = html.indexOf('admin:function(){');
  const end = html.indexOf('\n};', start);
  assert.ok(start >= 0 && end > start, 'Renderer admin harus ditemukan');
  const renderer = html.slice(start, end);
  assert.doesNotMatch(renderer, /2 Transaksi|Rp131\.670|0 \(Aman\)/);
  assert.match(renderer, /Total Booking/);
  assert.match(renderer, /Booking Aktif/);
  assert.match(renderer, /Disputed/);
  assert.match(renderer, /Belum tersedia/);
  assert.match(renderer, /Memuat ringkasan admin/);
  assert.match(renderer, /Ringkasan gagal dimuat/);
  assert.match(renderer, /Pengajuan Vendor Jasa/);
  assert.match(renderer, /Memuat pengajuan vendor jasa/);
  assert.match(renderer, /Belum ada pengajuan vendor jasa/);
  assert.match(renderer, /Pengajuan gagal dimuat/);
  assert.match(renderer, /admin-application-status-filter/);
  assert.match(renderer, /refresh-admin-applications/);
  assert.match(renderer, /Dashboard Admin/);
  assert.match(renderer, /Pantau operasional marketplace LockIn/);
  assert.equal((renderer.match(/admin-kpi-card/g) || []).length, 4);
  assert.match(renderer, /admin-kpi-grid/);
  assert.equal((renderer.match(/<svg /g) || []).length, 4);
  assert.match(html, /\.admin-kpi-grid\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(html, /@media\(max-width:900px\)\{\.admin-kpi-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/);
  assert.match(html, /@media\(max-width:560px\)\{\.admin-kpi-grid\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(renderer, /summary\.totalBookings/);
  assert.match(renderer, /summary\.activeBookings/);
  assert.match(renderer, /summary\.openDisputes/);
  assert.doesNotMatch(renderer, /Setujui|Tolak/);
  assert.match(html, /apiRequest\('\/api\/admin\/summary'\)/);
  assert.match(html, /S\.role!=='admin'\)return/);
});

test('vendor application UI escapes text and only creates links for valid HTTP(S) URLs', async () => {
  const html = await readFile('frontend/public/index.html', 'utf8');
  const helperStart = html.indexOf('function escapeUi(v)');
  const helperEnd = html.indexOf('function nav()', helperStart);
  const rendererStart = html.indexOf('admin:function(){');
  const rendererEnd = html.indexOf('\n};', rendererStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart && rendererEnd > rendererStart);
  const hostileApplication = {
    id: 'VAPP-TEST', name: '<img src=x onerror=alert(1)>', owner_name: '<script>alert(1)</script>',
    email: 'x"><svg onload=alert(1)>', whatsapp: '<b>123</b>', category: '<i>MUA</i>', city: '<script>alert(2)</script>', base_price: 250000.5,
    instagram: 'javascript:alert(1)', portfolio_url: 'https://example.id/?q="<script>',
    price_range: '<strong>murah</strong>', description: '<img src=x onerror=alert(1)>',
    created_at: '2026-11-20T10:00:00.000Z', status: 'pending_approval'
  };
  const context = {
    URL, Date, Intl,
    S: { adminSummary: { totalBookings: 1, activeBookings: 1, openDisputes: 0, smartContractFunds: { label: 'Belum tersedia' } }, adminApplications: [hostileApplication], adminApplicationsFilter: 'all', adminApplicationDetail: 'VAPP-TEST' },
    rp: amount => 'Rp'+Math.round(amount).toLocaleString('id-ID')
  };
  const executable = html.slice(helperStart, helperEnd)+'\nvar pages={'+html.slice(rendererStart, rendererEnd)+'\n}; pages.admin();';
  const { runInNewContext } = await import('node:vm');
  const cardHtml = runInNewContext(executable, context);
  const modalHtml = runInNewContext(html.slice(helperStart, helperEnd)+'\n'+html.slice(html.indexOf('function renderAdminApplicationModal', helperEnd), html.indexOf('function nav()', helperEnd))+'\nrenderAdminApplicationModal("VAPP-TEST");', context);
  assert.doesNotMatch(cardHtml, /<img src=x|<script>alert|<i>MUA/);
  assert.match(cardHtml, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(modalHtml, /href="javascript:/);
  assert.match(modalHtml, /href="https:\/\/example\.id\//);
  assert.match(modalHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(modalHtml, /Kota Layanan Utama/);
  assert.match(modalHtml, /Harga Dasar Layanan/);
  assert.match(modalHtml, /Rp250\.000,50/);
  assert.match(modalHtml, /Tolak Pengajuan/);
  assert.match(modalHtml, /Setujui Pengajuan/);
  context.S.adminApplicationConfirmStatus='approved';
  const approveConfirmation = runInNewContext(html.slice(helperStart, helperEnd)+'\n'+html.slice(html.indexOf('function renderAdminApplicationModal', helperEnd), html.indexOf('function nav()', helperEnd))+'\nrenderAdminApplicationModal("VAPP-TEST");', context);
  assert.match(approveConfirmation, /Setujui pengajuan ini\? Usaha akan langsung dipublikasikan ke katalog LockIn\./);
  assert.match(approveConfirmation, /Ya, Setujui/);
  context.S.adminApplicationConfirmStatus='rejected';
  const rejectConfirmation = runInNewContext(html.slice(helperStart, helperEnd)+'\n'+html.slice(html.indexOf('function renderAdminApplicationModal', helperEnd), html.indexOf('function nav()', helperEnd))+'\nrenderAdminApplicationModal("VAPP-TEST");', context);
  assert.match(rejectConfirmation, /Tolak pengajuan ini\? Usaha tidak akan ditampilkan di katalog\./);
  assert.match(rejectConfirmation, /Ya, Tolak/);
  context.S.adminApplicationConfirmStatus='';
  context.S.adminApplications[0].status='approved';
  const processedModal = runInNewContext(html.slice(helperStart, helperEnd)+'\n'+html.slice(html.indexOf('function renderAdminApplicationModal', helperEnd), html.indexOf('function nav()', helperEnd))+'\nrenderAdminApplicationModal("VAPP-TEST");', context);
  assert.doesNotMatch(processedModal, /Tolak Pengajuan|Setujui Pengajuan|Ya, Setujui|Ya, Tolak/);
  context.S.adminApplications[0].city=null;
  context.S.adminApplications[0].base_price=null;
  const legacyModal = runInNewContext(html.slice(helperStart, helperEnd)+'\n'+html.slice(html.indexOf('function renderAdminApplicationModal', helperEnd), html.indexOf('function nav()', helperEnd))+'\nrenderAdminApplicationModal("VAPP-TEST");', context);
  assert.match(legacyModal, /Belum diisi/);
});

test.after(() => server.kill());
