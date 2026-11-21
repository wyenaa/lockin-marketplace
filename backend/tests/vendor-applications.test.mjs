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
    whatsapp: '081234567890', category: 'MUA', instagram: '@vendor.test',
    portfolioUrl: 'https://example.id/portfolio', priceRange: 'Rp100.000–Rp500.000',
    description: 'Jasa rias untuk wisuda.'
  };
  const send = async data => {
    const response = await fetch(`${baseUrl}/api/vendor-applications`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data)
    });
    return { status: response.status, data: await response.json() };
  };
  const created = await send(payload);
  assert.equal(created.status, 201);
  assert.equal(created.data.application.status, 'pending_approval');
  assert.equal(created.data.application.name, payload.brandName);
  assert.equal(created.data.application.owner_name, payload.ownerName);
  assert.equal(created.data.application.portfolio_url, payload.portfolioUrl);
  assert.doesNotMatch(created.data.message, /password|kredensial|akan dikirim/i);

  assert.equal((await send({ ...payload, email: 'bukan-email' })).status, 400);
  assert.equal((await send({ ...payload, portfolioUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await send({ ...payload, instagram: 'bukan url' })).status, 400);
  const vendorsResponse = await fetch(`${baseUrl}/api/vendors`);
  const vendors = await vendorsResponse.json();
  assert.equal(vendors.some(vendor => vendor.name === payload.brandName), false);
});

test('vendor application form posts all fields and only shows success after server confirmation', async () => {
  const html = await readFile('frontend/public/index.html', 'utf8');
  const handler = html.match(/async function submitVendorApplication\(\)\s*\{/);
  const start = handler?.index ?? -1;
  const end = html.indexOf('function validHttpUrl', start);
  assert.ok(start >= 0 && end > start, 'Handler pendaftaran aktif harus ditemukan');
  const fn = html.slice(start, end);
  const fields = { vn: 'Jasa Test', vo: 'Pemilik', vk: 'MUA', ve: 'test@example.id', vw: '081234567890', vi: '@jasa.test', vp: 'https://example.id', vpr: 'Mulai 100rb', vd: 'Deskripsi jasa' };
  const message = { textContent: '', style: {} };
  const button = { disabled: false, textContent: '' };
  const form = { style: {} }, success = { style: {} }, successIdText = { textContent: '' }, successId = { style: {}, querySelector: () => successIdText };
  const context = {
    URL, vendorApplicationSending: false,
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
    whatsapp: fields.vw, instagram: fields.vi, portfolioUrl: fields.vp,
    priceRange: fields.vpr, description: fields.vd
  });
  assert.equal(form.style.display, 'none');
  assert.equal(success.style.display, 'block');
  assert.equal(successIdText.textContent, 'VAPP-TEST');

  context.apiRequest = async () => { throw new Error('Pengajuan belum tersimpan. Silakan coba lagi nanti.'); };
  form.style.display = 'block';
  success.style.display = 'none';
  await context.submitVendorApplication();
  assert.match(message.textContent, /belum tersimpan/i);
  assert.doesNotMatch(message.textContent, /berhasil tersimpan/i);
});
