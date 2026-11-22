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
let startupOutput = '';
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Server tidak siap: ${startupOutput}`)), 10000);
  server.stdout.on('data', chunk => {
    startupOutput += chunk;
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(startupOutput);
    if (match) { clearTimeout(timer); baseUrl = `http://127.0.0.1:${match[1]}`; resolve(); }
  });
  server.once('error', reject);
});

test('POST vendor applications validates contract and stores only pending applications', async t => {
  await ready;
  t.after(() => server.kill());
  const payload = {
    brandName: 'Vendor Jasa Test', ownerName: 'Pemilik Test', email: 'pemilik@example.id',
    whatsapp: '081234567890', category: 'MUA', city: 'Malang', basePrice: 250000, instagram: '@vendor.test',
    portfolioUrl: 'https://example.id/portfolio',
    description: 'Jasa rias untuk wisuda.'
  };
  const send = async data => {
    const response = await fetch(`${baseUrl}/api/vendor-applications`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data)
    });
    return { status: response.status, data: await response.json() };
  };
  const call = async (path, { method = 'GET', cookie, body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const created = await send(payload);
  assert.equal(created.status, 201);
  assert.equal(created.data.application.status, 'pending_approval');
  assert.equal(created.data.application.name, payload.brandName);
  assert.equal(created.data.application.owner_name, payload.ownerName);
  assert.equal(created.data.application.city, 'Malang');
  assert.equal(created.data.application.base_price, 250000);
  assert.equal(created.data.application.price_range, 'Mulai Rp250.000');
  assert.equal(created.data.application.portfolio_url, payload.portfolioUrl);
  assert.doesNotMatch(created.data.message, /password|kredensial|akan dikirim/i);

  assert.equal((await send({ ...payload, email: 'bukan-email' })).status, 400);
  assert.equal((await send({ ...payload, city: 'Kota Fiktif' })).status, 400);
  assert.equal((await send({ ...payload, basePrice: '' })).status, 400);
  assert.equal((await send({ ...payload, basePrice: 0 })).status, 400);
  assert.equal((await send({ ...payload, basePrice: -1 })).status, 400);
  assert.equal((await send({ ...payload, basePrice: 'bukan angka' })).status, 400);
  assert.equal((await send({ ...payload, basePrice: 250000.555 })).status, 400);
  const fractional = await send({ ...payload, basePrice: 250000.5 });
  assert.equal(fractional.status, 201);
  assert.equal(fractional.data.application.base_price, 250000.5);
  assert.equal(fractional.data.application.price_range, 'Mulai Rp250.000,50');
  assert.equal((await send({ ...payload, portfolioUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await send({ ...payload, instagram: 'bukan url' })).status, 400);
  const vendorsResponse = await fetch(`${baseUrl}/api/vendors`);
  const vendors = await vendorsResponse.json();
  assert.equal(vendors.some(vendor => vendor.name === payload.brandName), false);

  const login = async email => call('/api/auth/login', { method: 'POST', body: { email, password: 'LockInDemo123!' } });
  const customer = await login('user@lockin.demo');
  const operator = await login('vendor@lockin.demo');
  const admin = await login('admin@lockin.demo');
  const decisionPath = application => `/api/admin/vendor-applications/${application.id}/status`;
  assert.equal((await call(decisionPath(created.data.application), { method: 'PATCH', body: { status: 'approved' } })).status, 401);
  assert.equal((await call(decisionPath(created.data.application), { method: 'PATCH', cookie: customer.cookie, body: { status: 'approved' } })).status, 403);
  assert.equal((await call(decisionPath(created.data.application), { method: 'PATCH', cookie: operator.cookie, body: { status: 'approved' } })).status, 403);
  assert.equal((await call('/api/admin/vendor-applications/not-an-id/status', { method: 'PATCH', cookie: admin.cookie, body: { status: 'approved' } })).status, 400);

  const approved = await call(decisionPath(created.data.application), { method: 'PATCH', cookie: admin.cookie, body: { status: 'approved' } });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.application.status, 'approved');
  assert.equal(approved.data.vendor.price, 250000);
  assert.equal(approved.data.vendor.price_max, 375000);
  assert.equal(approved.data.vendor.category, 'MUA');
  assert.equal(approved.data.vendor.owner_id, operator.data.user.id);
  assert.equal((await call(decisionPath(created.data.application), { method: 'PATCH', cookie: admin.cookie, body: { status: 'approved' } })).status, 409);
  const newCatalog = await call('/api/vendors');
  const published = newCatalog.data.find(vendor => vendor.id === approved.data.vendor.id);
  assert.ok(published);
  assert.deepEqual(published.packages.map(pkg => pkg.price), [250000, 313000, 375000]);
  const detail = await call(`/api/vendors/${published.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.packages.length, 3);
  const booking = await call('/api/bookings', { method: 'POST', cookie: customer.cookie, body: {
    vendorId: published.id, packageId: '3', date: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10),
    location: 'Malang', startTime: '08:00', agreed: true
  } });
  assert.equal(booking.status, 201);
  assert.equal(booking.data.vendor_id, published.id);
  assert.equal(booking.data.package_id, '3');
  const operatorBookings = await call('/api/bookings', { cookie: operator.cookie });
  assert.ok(operatorBookings.data.some(item => item.id === booking.data.id));

  const singlePackageApp = await send({ ...payload, brandName: 'Vendor Sign Test', category: 'Acrylic Standing Sign', city: 'Bogor', basePrice: 75000 });
  assert.equal(singlePackageApp.status, 201);
  const singleApproved = await call(decisionPath(singlePackageApp.data.application), { method: 'PATCH', cookie: admin.cookie, body: { status: 'approved' } });
  assert.equal(singleApproved.status, 200);
  assert.equal(singleApproved.data.vendor.category, 'Standing Sign');
  assert.equal(singleApproved.data.vendor.price_max, 75000);
  const singleDetail = await call(`/api/vendors/${singleApproved.data.vendor.id}`);
  assert.equal(singleDetail.data.packages.length, 1);

  const rejectedApp = await send({ ...payload, brandName: 'Vendor Ditolak', basePrice: 180000 });
  assert.equal(rejectedApp.status, 201);
  const rejected = await call(decisionPath(rejectedApp.data.application), { method: 'PATCH', cookie: admin.cookie, body: { status: 'rejected' } });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.data.application.status, 'rejected');
  assert.equal(rejected.data.vendor, null);
  assert.equal((await call('/api/vendors')).data.some(vendor => vendor.name === 'Vendor Ditolak'), false);
  assert.equal((await call(decisionPath(rejectedApp.data.application), { method: 'PATCH', cookie: admin.cookie, body: { status: 'approved' } })).status, 409);

  const gccApp = await send({ ...payload, brandName: 'Vendor GCC Test', category: 'Graduation Content Creator', city: 'Surabaya', basePrice: 100000 });
  const gccApproved = await call(decisionPath(gccApp.data.application), { method: 'PATCH', cookie: admin.cookie, body: { status: 'approved' } });
  assert.equal(gccApproved.status, 200);
  assert.equal(gccApproved.data.vendor.category, 'GCC');
  assert.deepEqual((await call('/api/vendors?city=Surabaya')).data.map(vendor => vendor.id), [gccApproved.data.vendor.id]);

  const incomplete = await send({ ...payload, brandName: 'Kategori Tidak Didukung', category: 'Kategori Baru', basePrice: 99000 });
  assert.equal(incomplete.status, 201);
  const invalidApproval = await call(decisionPath(incomplete.data.application), { method: 'PATCH', cookie: admin.cookie, body: { status: 'approved' } });
  assert.equal(invalidApproval.status, 400);
  assert.equal((await call('/api/admin/vendor-applications', { cookie: admin.cookie })).data.find(app => app.id === incomplete.data.application.id).status, 'pending_approval');

  const fractionalApprovalApp = await send({ ...payload, brandName: 'Harga Pecahan', basePrice: 250000.5 });
  const fractionalApproval = await call(decisionPath(fractionalApprovalApp.data.application), { method: 'PATCH', cookie: admin.cookie, body: { status: 'approved' } });
  assert.equal(fractionalApproval.status, 400);
  assert.equal((await call('/api/admin/vendor-applications', { cookie: admin.cookie })).data.find(app => app.id === fractionalApprovalApp.data.application.id).status, 'pending_approval');
  assert.equal((await call('/api/vendors')).data.some(vendor => vendor.name === 'Harga Pecahan'), false);

  const concurrentApp = await send({ ...payload, brandName: 'Vendor Race Test', basePrice: 100000 });
  const concurrentResults = await Promise.all([
    call(decisionPath(concurrentApp.data.application), { method: 'PATCH', cookie: admin.cookie, body: { status: 'approved' } }),
    call(decisionPath(concurrentApp.data.application), { method: 'PATCH', cookie: admin.cookie, body: { status: 'approved' } })
  ]);
  assert.deepEqual(concurrentResults.map(result => result.status).sort(), [200, 409]);
  assert.equal((await call('/api/vendors')).data.filter(vendor => vendor.name === 'Vendor Race Test').length, 1);
});

test('vendor application form posts all fields and only shows success after server confirmation', async () => {
  const html = await readFile('frontend/public/index.html', 'utf8');
  assert.match(html, /<label for="vcity">Kota Layanan Utama<\/label><select id="vcity" required/);
  assert.match(html, /CITIES\.map\(function\(city\)/);
  assert.match(html, /Harga Dasar Layanan \(Rp\)/);
  assert.match(html, /type="number" id="vbp"[^>]+step="0\.01"/);
  assert.match(html, /function updateVendorBasePricePreview\(\)/);
  const start = html.indexOf('function parseVendorBasePrice(value){');
  const end = html.indexOf('function validHttpUrl', start);
  assert.ok(start >= 0 && end > start, 'Handler pendaftaran aktif harus ditemukan');
  const fn = html.slice(start, end);
  const fields = { vn: 'Jasa Test', vo: 'Pemilik', vk: 'MUA', vcity: 'Malang', ve: 'test@example.id', vw: '081234567890', vi: '@jasa.test', vp: 'https://example.id', vbp: '250000.50', vd: 'Deskripsi jasa' };
  const message = { textContent: '', style: {} };
  const button = { disabled: false, textContent: '' };
  const form = { style: {} }, success = { style: {} }, successIdText = { textContent: '' }, successId = { style: {}, querySelector: () => successIdText };
  const context = {
    URL, vendorApplicationSending: false, vendorApplicationBasePrice: amount => 'Rp'+amount.toLocaleString('id-ID',{minimumFractionDigits:Number.isInteger(amount)?0:2,maximumFractionDigits:2}),
    document: { getElementById: id => id === 'vreg-message' ? message : id === 'vreg-submit' ? button : id === 'vreg-form' ? form : id === 'vreg-success' ? success : id === 'vreg-success-id' ? successId : { value: fields[id] ?? '' } },
    apiRequest: async (path, method, data) => { context.request = { path, method, data }; return { ok: true, application: { id: 'VAPP-TEST', status: 'pending_approval' } }; },
    toast: () => {}
  };
  vm.runInNewContext(`${fn}\n${html.slice(end, html.indexOf('// Bank-Style', end))}`, context);
  await context.submitVendorApplication();
  assert.equal(context.request.path, '/api/vendor-applications');
  assert.equal(context.request.method, 'POST');
  assert.deepEqual({ ...context.request.data }, {
    brandName: fields.vn, ownerName: fields.vo, category: fields.vk, email: fields.ve,
    whatsapp: fields.vw, city: fields.vcity, basePrice: 250000.5,
    instagram: fields.vi, portfolioUrl: fields.vp, description: fields.vd
  });
  assert.equal(form.style.display, 'none');
  assert.equal(success.style.display, 'block');
  assert.equal(successIdText.textContent, 'VAPP-TEST');

  let sentInvalidPrice = false;
  context.apiRequest = async () => { sentInvalidPrice = true; return {}; };
  fields.vbp = '0';
  await context.submitVendorApplication();
  assert.equal(sentInvalidPrice, false);
  assert.match(message.textContent, /lebih dari Rp0/i);

  context.apiRequest = async () => { throw new Error('Pengajuan belum tersimpan. Silakan coba lagi nanti.'); };
  fields.vbp = '250000';
  form.style.display = 'block';
  success.style.display = 'none';
  await context.submitVendorApplication();
  assert.match(message.textContent, /belum tersimpan/i);
  assert.doesNotMatch(message.textContent, /berhasil tersimpan/i);
});

test('vendor application migration and approval RPC preserve legacy data and enforce atomic unique publishing', async () => {
  const migration = await readFile('database/migrations/20261122_vendor_application_city_base_price.sql', 'utf8');
  const initialMigration = await readFile('database/migrations/20261121_vendor_applications.sql', 'utf8');
  const approvalMigration = await readFile('database/migrations/20261122_admin_vendor_application_approval.sql', 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS city TEXT;/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS base_price NUMERIC\(12,2\);/);
  assert.match(migration, /ALTER COLUMN base_price TYPE NUMERIC\(12,2\)/);
  assert.match(initialMigration, /price_range TEXT NOT NULL/);
  assert.match(initialMigration, /price_range TEXT NOT NULL DEFAULT 'Belum dicantumkan'/);
  assert.doesNotMatch(migration, /UPDATE public\.vendor_applications|SET\s+(city|base_price)|DEFAULT\s+/i);
  assert.match(approvalMigration, /FOR UPDATE/);
  assert.match(approvalMigration, /CREATE UNIQUE INDEX IF NOT EXISTS vendors_source_application_id_uidx/);
  assert.match(approvalMigration, /SECURITY DEFINER/);
  assert.match(approvalMigration, /REVOKE ALL ON FUNCTION .* FROM anon, authenticated/);
  assert.match(approvalMigration, /GRANT EXECUTE ON FUNCTION .* TO service_role/);
  assert.match(approvalMigration, /UPDATE public\.vendor_applications[\s\S]*SET status = 'approved'/);
});
