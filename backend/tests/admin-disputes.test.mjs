import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const server = spawn(process.execPath, ['backend/src/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env, PORT: '0', HOST: '127.0.0.1', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '',
    MIDTRANS_SERVER_KEY: '', SEPOLIA_RPC_URL: '', SEPOLIA_WRITER_PRIVATE_KEY: ''
  }, stdio: ['ignore', 'pipe', 'pipe']
});
let baseUrl;
let output = '';
const ready = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Server tidak siap: ${output}`)), 10000);
  server.stdout.on('data', bytes => {
    output += bytes;
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match) { clearTimeout(timeout); baseUrl = `http://127.0.0.1:${match[1]}`; resolve(); }
  });
  server.once('error', reject);
});

async function request(path, { cookie, method = 'GET', body } = {}) {
  const res = await fetch(baseUrl + path, {
    method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
function eventDate() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return new Date(Date.UTC(Number(p.find(x => x.type === 'year').value), Number(p.find(x => x.type === 'month').value) - 1, Number(p.find(x => x.type === 'day').value) + 20)).toISOString().slice(0, 10);
}

test('admin can read and record a one-time decision; no money or booking status moves at 1C', async t => {
  t.after(() => server.kill());
  await ready;
  const login = async email => (await request('/api/auth/login', { method: 'POST', body: { email, password: 'LockInDemo123!' } })).cookie;
  const customer = await login('user@lockin.demo');
  const vendor = await login('vendor@lockin.demo');
  const otherVendor = await login('vendor2@lockin.demo');
  const admin = await login('admin@lockin.demo');
  const catalog = await request('/api/vendors');
  const booked = await request('/api/bookings', { cookie: customer, method: 'POST', body: {
    vendorId: catalog.data[0].id, packageId: '1', date: eventDate(), location: 'Malang', startTime: '08:00', agreed: true
  } });
  assert.equal(booked.status, 201);
  const id = booked.data.id;
  assert.equal((await request(`/api/bookings/${id}/payment`, { cookie: customer, method: 'POST', body: {
    method: 'QRIS', outcome: 'success', expectedState: booked.data.state, paymentType: 'DP'
  } })).status, 200);
  const filed = await request(`/api/bookings/${id}/dispute`, { cookie: customer, method: 'POST', body: {
    reason: 'Vendor tidak sesuai kesepakatan', evidence: 'Bukti tertulis dari pelanggan'
  } });
  assert.equal(filed.status, 201);
  const before = await request(`/api/bookings/${id}`, { cookie: admin });
  const disputeId = before.data.dispute.id;
  const path = `/api/disputes/${disputeId}/resolve`;
  const decision = { decision: 'partial', reason: 'Bukti pihak pelanggan dan vendor sudah ditimbang', percent: 35 };
  assert.equal((await request(path, { cookie: customer, method: 'POST', body: decision })).status, 403);
  assert.equal((await request(path, { cookie: otherVendor, method: 'POST', body: decision })).status, 403);
  assert.equal((await request(path, { cookie: admin, method: 'POST', body: decision })).status, 409,
    'admin must wait for a vendor response or expiry');
  assert.equal((await request(`/api/disputes/${disputeId}/response`, { cookie: vendor, method: 'POST', body: {
    response: 'Tanggapan vendor dan bukti pendukungnya'
  } })).status, 200);
  assert.equal((await request(path, { cookie: admin, method: 'POST', body: { ...decision, percent: 100 } })).status, 400);
  const saved = await request(path, { cookie: admin, method: 'POST', body: decision });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.pendingExecution, true);
  assert.equal(saved.data.dispute.decision, 'partial');
  assert.equal(saved.data.dispute.refund_percent, 35);
  assert.equal(saved.data.dispute.refund, undefined, 'no refund should be executed or populated by 1C');
  assert.equal((await request(path, { cookie: admin, method: 'POST', body: decision })).status, 409);
  const detail = await request(`/api/bookings/${id}`, { cookie: admin });
  assert.equal(detail.data.state, 'Disputed');
  assert.equal(detail.data.release.status, 'ON_HOLD');
  const list = await request('/api/disputes', { cookie: admin });
  assert.equal(list.status, 200);
  assert.equal(list.data.find(row => row.id === disputeId).refund_percent, 35);
});

test('admin dispute UI escapes untrusted text and shows evidence, not fake transfer', async () => {
  const html = await readFile('frontend/public/index.html', 'utf8');
  const start = html.indexOf('function renderAdminDisputeModal()');
  const end = html.indexOf('function nav(){', start);
  assert.ok(start > 0 && end > start);
  const context = {
    S: { role: 'admin', adminDisputeDetailId: 'DSP-1', adminDisputeDecision: { decision: 'release', percent: '50', reason: '' },
      adminDisputeDecisionError: '', adminDisputeDecisionLoading: false, adminDisputeConfirm: false,
      adminDisputeDetail: { id: 'BK-1', vendor_name: 'Vendor', event_date: '2026-11-22', paid: 100000,
        vendor_arrived: false, execution_state: 'NOT_STARTED', agreement: '{}', hash: '0x12',
        dispute: { id: 'DSP-1', reason: '<script>boom()</script>', evidence: 'teks bukti',
          response: 'Tanggapan vendor', decision: null } }
    },
    rp: value => `Rp${value}`,
    escapeUi: value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch])),
    safeVendorApplicationUrl: value => value?.startsWith('https://') ? value : ''
  };
  runInNewContext(html.slice(start, end), context);
  const rendered = context.renderAdminDisputeModal();
  assert.match(rendered, /Peninjauan Sengketa/);
  assert.match(rendered, /Bukti Tertulis Pelanggan/);
  assert.match(rendered, /&lt;script&gt;boom\(\)&lt;\/script&gt;/);
  assert.match(rendered, /Tinjau dan Konfirmasi/);
  assert.doesNotMatch(rendered, /<script>boom\(\)<\/script>/);
  assert.match(html, /data-a="view-admin-dispute"/);
  assert.match(html, /refreshAdminDisputes\(true\)/);
});
