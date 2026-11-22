import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const server = spawn(process.execPath, ['backend/src/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: '0', HOST: '127.0.0.1', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', MIDTRANS_SERVER_KEY: '', CONTRACT_ADDRESS: '', PRIVATE_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let baseUrl;
let serverOutput = '';
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Server tidak siap: ${serverOutput}`)), 10000);
  server.stdout.on('data', chunk => {
    serverOutput += chunk;
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(serverOutput);
    if (match) { clearTimeout(timer); baseUrl = `http://127.0.0.1:${match[1]}`; resolve(); }
  });
  server.once('error', reject);
});

async function request(path, { cookie, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

function eventDate(daysAhead) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return new Date(Date.UTC(Number(parts.find(p => p.type === 'year').value), Number(parts.find(p => p.type === 'month').value) - 1, Number(parts.find(p => p.type === 'day').value) + daysAhead)).toISOString().slice(0, 10);
}

test('vendor dispute response reads persisted source, enforces booking ownership, and is one-time', async t => {
  await ready;
  t.after(() => server.kill());
  const html = await readFile('frontend/public/index.html', 'utf8');
  const customer = await request('/api/auth/login', { method: 'POST', body: { email: 'user@lockin.demo', password: 'LockInDemo123!' } });
  const vendor = await request('/api/auth/login', { method: 'POST', body: { email: 'vendor@lockin.demo', password: 'LockInDemo123!' } });
  const otherVendor = await request('/api/auth/login', { method: 'POST', body: { email: 'vendor2@lockin.demo', password: 'LockInDemo123!' } });
  const catalog = await request('/api/vendors');
  const booking = await request('/api/bookings', {
    cookie: customer.cookie, method: 'POST',
    body: { vendorId: catalog.data[0].id, packageId: '1', date: eventDate(20), location: 'Malang', startTime: '08:00', agreed: true }
  });
  assert.equal(booking.status, 201);
  assert.equal((await request(`/api/bookings/${booking.data.id}/payment`, { cookie: customer.cookie, method: 'POST', body: { method: 'QRIS', outcome: 'success', expectedState: booking.data.state, paymentType: 'DP' } })).status, 200);
  const dispute = await request(`/api/bookings/${booking.data.id}/dispute`, { cookie: customer.cookie, method: 'POST', body: { reason: 'Keluhan layanan dan kronologi', evidence: 'Bukti tertulis pelanggan' } });
  assert.equal(dispute.status, 201);

  const vendorDetail = await request(`/api/bookings/${booking.data.id}`, { cookie: vendor.cookie });
  assert.equal(vendorDetail.status, 200);
  assert.equal(vendorDetail.data.state, 'Disputed');
  assert.equal(vendorDetail.data.dispute.reason, 'Keluhan layanan dan kronologi');
  assert.equal(vendorDetail.data.dispute.evidence, 'Bukti tertulis pelanggan');
  assert.equal((await request(`/api/bookings/${booking.data.id}`, { cookie: otherVendor.cookie })).status, 403);
  const disputeId = vendorDetail.data.dispute.id;
  const responsePath = `/api/disputes/${disputeId}/response`;
  assert.equal((await request(responsePath, { cookie: otherVendor.cookie, method: 'POST', body: { response: 'Jawaban vendor lain' } })).status, 403);
  assert.equal((await request(responsePath, { cookie: customer.cookie, method: 'POST', body: { response: 'Jawaban pelanggan' } })).status, 403);
  assert.equal((await request(responsePath, { cookie: vendor.cookie, method: 'POST', body: { response: 'Tanggapan vendor', evidenceUrl: 'javascript:alert(1)' } })).status, 400);

  const posted = await request(responsePath, { cookie: vendor.cookie, method: 'POST', body: { response: 'Tanggapan vendor sesuai bukti', evidenceUrl: 'https://example.test/vendor-proof' } });
  assert.equal(posted.status, 200);
  assert.equal(posted.data.dispute.response, 'Tanggapan vendor sesuai bukti');
  assert.equal(posted.data.dispute.vendor_evidence_url, 'https://example.test/vendor-proof');
  assert.equal(posted.data.reviewStatus, 'Menunggu Peninjauan Admin');
  assert.equal((await request(responsePath, { cookie: vendor.cookie, method: 'POST', body: { response: 'Tanggapan kedua yang berbeda' } })).status, 409);
  const refreshed = await request(`/api/bookings/${booking.data.id}`, { cookie: vendor.cookie });
  assert.equal(refreshed.data.state, 'Disputed');
  assert.equal(refreshed.data.dispute.response, 'Tanggapan vendor sesuai bukti');
  assert.equal(refreshed.data.dispute.vendor_evidence_url, 'https://example.test/vendor-proof');
  assert.match(html, /data-a="respond-dispute"/);
  assert.match(html, /renderVendorDisputeSection\(d\)/);
  assert.doesNotMatch(html, /window\.prompt\([^\n]*sengketa/i);
});

test('vendor dispute UI escapes evidence, renders review state, and modal fields', async () => {
  const html = await readFile('frontend/public/index.html', 'utf8');
  const helperStart = html.indexOf('function renderVendorDisputeSection');
  const modalEnd = html.indexOf('function disputeFormValidation', helperStart);
  const safeUrlStart = html.indexOf('function safeVendorApplicationUrl');
  const safeUrlEnd = html.indexOf('function vendorApplicationDate', safeUrlStart);
  const helpers = html.slice(helperStart, modalEnd) + html.slice(safeUrlStart, safeUrlEnd);
  const context = {
    S: {
      vendorDisputeBookingId: 'BK-1', vendorDisputeLoading: false,
      vendorDisputeForm: { response: '', evidenceUrl: '' }, vendorDisputeErrors: {},
      vendorDetail: { id: 'BK-1', vendor_name: 'Vendor <Satu>', state: 'Disputed', dispute: {
        id: 'DSP-1', reason: 'Keluhan pelanggan', evidence: '<script>bad()</script>', evidence_url: 'https://example.test/customer', response: 'Tanggapan tersimpan', vendor_evidence_url: 'https://example.test/vendor'
      } }
    },
    escapeUi: value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]),
    URL
  };
  runInNewContext(helpers, context);
  const section = context.renderVendorDisputeSection(context.S.vendorDetail);
  assert.match(section, /Menunggu Peninjauan Admin/);
  assert.match(section, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(section, /Tanggapan tersimpan/);
  assert.match(section, /Tautan bukti tambahan/);
  assert.doesNotMatch(section, /Tanggapi Sengketa/);

  const modalContext = {
    ...context,
    S: { ...context.S, vendorDisputeBookingId: 'BK-1', vendorDisputeForm: { response: 'Draft', evidenceUrl: '' }, vendorDisputeErrors: {} }
  };
  runInNewContext(helpers, modalContext);
  const modal = modalContext.renderVendorDisputeModal();
  assert.match(modal, /role="dialog" aria-modal="true"/);
  assert.match(modal, /Tanggapan Vendor/);
  assert.match(modal, /Tautan Bukti Tambahan/);
  assert.match(modal, /Draft/);
});
