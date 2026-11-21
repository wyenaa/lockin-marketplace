import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Tahap 3B UI: Kontras Proteksi Escrow tidak bertabrakan di dark mode', async () => {
  const html = await readFile('frontend/public/index.html', 'utf8');
  
  // Periksa Proteksi Escrow di formulir order & detail vendor
  const escrowMatches = html.match(/Proteksi Escrow LockIn/g);
  assert.ok(escrowMatches && escrowMatches.length >= 2, 'Harus ada kotak Proteksi Escrow LockIn');

  // Pastikan tidak ada background #F8FAFC yang dipakai di kotak Proteksi Escrow
  assert.doesNotMatch(
    html,
    /background:#F8FAFC;[^;]*var\(--b\);[^;]*var\(--m\)[^;]*\+\'\s*🔒 <b>Proteksi Escrow/,
    'Kotak Proteksi Escrow tidak boleh menggunakan background hardcoded #F8FAFC yang minim kontras di dark mode'
  );

  // Pastikan style menggunakan rgba(29,78,216,.08) dan color:var(--t)
  assert.ok(
    html.includes('background:rgba(29,78,216,.08);border:1px solid var(--b);font-size:12px;color:var(--t)'),
    'Kotak Proteksi Escrow harus adaptif dengan warna teks var(--t) dan background rgba(29,78,216,.08)'
  );
});

test('Tahap 3B UI: Rendering status Verifikasi Kehadiran vendor', async () => {
  const html = await readFile('frontend/public/index.html', 'utf8');

  // Ekstrak fungsi dashboard dari index.html
  const jsMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(jsMatch, 'Script harus ditemukan di index.html');
  const jsCode = jsMatch[1];

  const dummyEl = { innerHTML: '', value: '', style: {}, classList: { toggle: () => {} } };
  // Buat mock DOM dan environment browser sederhana
  const mockContext = {
    console,
    Math,
    Date,
    String,
    Number,
    Boolean,
    Array,
    Object,
    JSON,
    RegExp,
    encodeURIComponent,
    addEventListener: () => {},
    scrollTo: () => {},
    document: {
      addEventListener: () => {},
      getElementById: () => dummyEl,
      querySelectorAll: () => []
    },
    history: { pushState: () => {}, replaceState: () => {} },
    location: { hash: '#dashboard' },
    fetch: async (url, options = {}) => {
      const path = typeof url === 'string' ? url : url.pathname || '';
      if (path === '/api/auth/me') {
        return { ok: true, json: async () => ({ user: { role: 'vendor', name: 'Vendor Demo' } }) };
      }
      if (path === '/api/vendors') {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }
  };
  mockContext.window = mockContext;

  // Jalankan skrip di VM sandbox untuk menguji fungsi UI
  const { createContext, runInContext } = await import('node:vm');
  const ctx = createContext(mockContext);
  runInContext(jsCode, ctx);

  // Setup akun vendor
  ctx.S.role = 'vendor';
  ctx.S.user = 'Vendor Demo';

  // KONDISI 1: Booking Paid tetapi SEBELUM hari H (event_date di masa depan)
  ctx.S.vendorDetail = {
    id: 'LK-TEST-FUTURE',
    state: 'Paid',
    price: 300000,
    paid: 300000,
    event_date: '2099-12-31',
    vendor_arrived: false,
    execution_state: 'NOT_STARTED',
    customer_name: 'Customer A',
    vendor_name: 'Vendor A'
  };
  ctx.S.activeVendorBid = 'LK-TEST-FUTURE';
  ctx.S.vendorBookings = [ctx.S.vendorDetail];

  let outHtml = ctx.pages.dashboard();
  assert.match(outHtml, /Verifikasi tersedia pada hari pelaksanaan/);
  assert.doesNotMatch(outHtml, /id="vendor-otp-input"/);
  assert.doesNotMatch(outHtml, /data-a="submit-vendor-arrival"/);

  // KONDISI 2: Booking BELUM lunas (state: DPPaid atau Pending)
  ctx.S.vendorDetail = {
    id: 'LK-TEST-UNPAID',
    state: 'DPPaid',
    price: 300000,
    paid: 90000,
    event_date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }),
    vendor_arrived: false,
    execution_state: 'NOT_STARTED',
    customer_name: 'Customer B',
    vendor_name: 'Vendor B'
  };
  ctx.S.activeVendorBid = 'LK-TEST-UNPAID';
  ctx.S.vendorBookings = [ctx.S.vendorDetail];

  outHtml = ctx.pages.dashboard();
  assert.match(outHtml, /Menunggu pelunasan/);
  assert.doesNotMatch(outHtml, /id="vendor-otp-input"/);
  assert.doesNotMatch(outHtml, /data-a="submit-vendor-arrival"/);

  // KONDISI 3: Booking SUDAH diverifikasi kehadirannya (vendor_arrived: true)
  ctx.S.vendorDetail = {
    id: 'LK-TEST-VERIFIED',
    state: 'Paid',
    price: 300000,
    paid: 300000,
    event_date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }),
    vendor_arrived: true,
    vendor_arrived_at: '2026-11-21T08:30:00Z',
    execution_state: 'IN_PROGRESS',
    customer_name: 'Customer C',
    vendor_name: 'Vendor C'
  };
  ctx.S.activeVendorBid = 'LK-TEST-VERIFIED';
  ctx.S.vendorBookings = [ctx.S.vendorDetail];

  outHtml = ctx.pages.dashboard();
  assert.match(outHtml, /Kehadiran Terverifikasi/);
  assert.doesNotMatch(outHtml, /id="vendor-otp-input"/);
  assert.doesNotMatch(outHtml, /data-a="submit-vendor-arrival"/);

  // KONDISI 4: Hari H, Paid, Belum diverifikasi -> Form OTP HARUS MUNCUL
  const todayJakarta = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
  ctx.S.vendorDetail = {
    id: 'LK-TEST-HARI-H',
    state: 'Paid',
    price: 300000,
    paid: 300000,
    event_date: todayJakarta,
    vendor_arrived: false,
    execution_state: 'NOT_STARTED',
    customer_name: 'Customer D',
    vendor_name: 'Vendor D'
  };
  ctx.S.activeVendorBid = 'LK-TEST-HARI-H';
  ctx.S.vendorBookings = [ctx.S.vendorDetail];

  outHtml = ctx.pages.dashboard();
  assert.match(outHtml, /id="vendor-otp-input"/);
  assert.match(outHtml, /data-a="submit-vendor-arrival"/);
  assert.match(outHtml, /Verifikasi Kehadiran/);

  // Pastikan arrival_code TIDAK pernah dibocorkan ke UI vendor
  assert.doesNotMatch(outHtml, /arrival_code/);
  assert.doesNotMatch(outHtml, /482910/);
});

test('Tahap 3B UI: Validasi OTP 6 digit dan pencegahan race condition', async () => {
  const html = await readFile('frontend/public/index.html', 'utf8');
  const jsCode = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  const apiCalls = [];
  const dummyEl = { innerHTML: '', value: '', style: {}, classList: { toggle: () => {} } };
  let currentCtx;
  const mockContext = {
    console,
    Math,
    Date,
    String,
    Number,
    Boolean,
    Array,
    Object,
    JSON,
    RegExp,
    encodeURIComponent,
    addEventListener: () => {},
    scrollTo: () => {},
    toast: () => {},
    document: {
      addEventListener: () => {},
      getElementById: (id) => {
        if (id === 'vendor-otp-input') return { value: currentCtx ? currentCtx.S.vendorOtpInput : '' };
        return dummyEl;
      },
      querySelectorAll: () => []
    },
    history: { pushState: () => {}, replaceState: () => {} },
    location: { hash: '#dashboard' },
    fetch: async (url, options = {}) => {
      const path = typeof url === 'string' ? url : url.pathname || '';
      if (path === '/api/auth/me') return { ok: true, json: async () => ({ user: { role: 'vendor', name: 'Vendor Demo' } }) };
      if (path === '/api/vendors') return { ok: true, json: async () => ({ data: [] }) };
      
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : undefined;
      apiCalls.push({ path, method, body });

      if (path.includes('/verify-arrival')) {
        return { ok: true, json: async () => ({ ok: true, message: 'Vendor terverifikasi telah tiba dan check-in di lokasi acara.' }) };
      }
      if (path.startsWith('/api/bookings/')) {
        return {
          ok: true,
          json: async () => ({
            id: currentCtx.S.activeVendorBid,
            state: 'Paid',
            vendor_arrived: true,
            execution_state: 'IN_PROGRESS'
          })
        };
      }
      return { ok: true, json: async () => ({}) };
    }
  };
  mockContext.window = mockContext;

  const { createContext, runInContext } = await import('node:vm');
  const ctx = createContext(mockContext);
  currentCtx = ctx;
  runInContext(jsCode, ctx);

  ctx.S.role = 'vendor';
  ctx.S.user = 'Vendor Demo';
  ctx.S.activeVendorBid = 'LK-101';
  ctx.S.vendorBookings = [{ id: 'LK-101', state: 'Paid' }];

  // 1. Validasi digit: kurang dari 6 digit
  ctx.S.vendorOtpInput = '12345';
  await ctx.submitVendorArrival('LK-101');
  assert.equal(ctx.S.vendorVerifyError, 'Kode OTP kedatangan harus berupa 6 digit angka.');
  assert.equal(apiCalls.length, 0, 'API verify-arrival tidak boleh dipanggil jika OTP tidak valid');

  // 2. Validasi digit: huruf
  ctx.S.vendorOtpInput = '12345a';
  await ctx.submitVendorArrival('LK-101');
  assert.equal(ctx.S.vendorVerifyError, 'Kode OTP kedatangan harus berupa 6 digit angka.');
  assert.equal(apiCalls.length, 0);

  // 3. OTP 6 digit valid -> panggil API dan perbarui status
  ctx.S.vendorOtpInput = '654321';
  await ctx.submitVendorArrival('LK-101');
  assert.equal(apiCalls.length, 2, 'Harus memanggil verify-arrival dan get detail');
  assert.equal(apiCalls[0].path, '/api/bookings/LK-101/verify-arrival');
  assert.equal(apiCalls[0].method, 'POST');
  assert.deepEqual(apiCalls[0].body, { otp: '654321' });
  assert.equal(ctx.S.vendorVerifySuccess, 'Vendor terverifikasi telah tiba dan check-in di lokasi acara.');
  assert.equal(ctx.S.vendorDetail.vendor_arrived, true);
  assert.equal(ctx.S.vendorBookings[0].vendor_arrived, true);

  // 4. Pencegahan race condition saat berpindah card
  ctx.S.activeVendorBid = 'LK-202';
  ctx.S.vendorDetail = { id: 'LK-202', vendor_name: 'Vendor Baru' };
  
  // Simulasi pemanggilan verify-arrival untuk booking lama 'LK-101'
  await ctx.submitVendorArrival('LK-101');
  // State LK-202 tidak boleh tertimpa
  assert.equal(ctx.S.vendorDetail.id, 'LK-202');
  assert.equal(ctx.S.vendorDetail.vendor_name, 'Vendor Baru');
});
