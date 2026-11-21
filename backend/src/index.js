// LockIn — Backend Entry Point
// Node.js HTTP server + REST API + static file server
import 'dotenv/config';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { supabase, isSupabaseConfigured } from './db/supabase.js';
import { DEMO_VENDORS } from './db/seed.js';
import { createSnapPayment, verifySignature, interpretNotification, fetchMidtransStatus, isMidtransConfigured } from './services/midtrans.js';
import { syncBlockchainJobs, isBlockchainConfigured } from './services/blockchain.js';
import { handleMidtransWebhook, recordNotification } from './webhooks/midtrans.js';
import {
  POLICY,
  calculateRefund,
  getDaysBeforeEvent,
  isLateBooking,
  getPaymentSchedule,
  detectOffPlatformViolation
} from './config/policy.config.js';

const root = dirname(fileURLToPath(import.meta.url));
// Frontend static files served dari folder frontend/public
const publicRoot = resolve(root, '../../frontend/public');

// ─── Local In-Memory Store (Fallback saat Supabase tables belum di-run) ──────
const demoAccounts = {
  // Pelanggan / Customer (Rani)
  'pelanggan@lockin.id': { id: 'd32824cc-da8b-4ed5-b8aa-af8a62daac53', name: 'Rani (Wisudawan UB)', email: 'pelanggan@lockin.id', role: 'customer' },
  'user@lockin.demo':    { id: 'd32824cc-da8b-4ed5-b8aa-af8a62daac53', name: 'Rani (Wisudawan UB)', email: 'user@lockin.demo', role: 'customer' },
  'rani@lockin.id':      { id: 'd32824cc-da8b-4ed5-b8aa-af8a62daac53', name: 'Rani (Wisudawan UB)', email: 'rani@lockin.id', role: 'customer' },

  // Vendor (Glow Studio PA)
  'vendor@lockin.id':    { id: 'd9d01426-73a7-43e6-86fe-d296b200d0b1', name: 'Glow Studio PA', email: 'vendor@lockin.id', role: 'vendor' },
  'vendor@lockin.demo':  { id: 'd9d01426-73a7-43e6-86fe-d296b200d0b1', name: 'Glow Studio PA', email: 'vendor@lockin.demo', role: 'vendor' },

  // Admin LockIn
  'admin@lockin.id':     { id: 'a3769509-249b-4cb9-8aff-12d1dd5b65d9', name: 'Admin LockIn', email: 'admin@lockin.id', role: 'admin' },
  'admin@lockin.demo':   { id: 'a3769509-249b-4cb9-8aff-12d1dd5b65d9', name: 'Admin LockIn', email: 'admin@lockin.demo', role: 'admin' }
};
const localSessions = new Map();
const localBookings = new Map();
const localPayments = new Map();
const localDisputes = new Map();
const localEvidence = new Map();
const localReports  = [];
const localAudit    = [];

// Pemetaan UUID Vendor Supabase resmi
const VENDOR_UUIDS = [
  'e0000000-0000-4000-8000-000000000001', // 1: Lolita Makeup
  'b8d6fb1a-2121-4701-bc90-83eaa7970c60', // 2: Makeup Rinsil
  'e0000000-0000-4000-8000-000000000003', // 3: Magda MUA
  'e0000000-0000-4000-8000-000000000004', // 4: Hijab Do Malang
  'e0000000-0000-4000-8000-000000000005', // 5: Lolita Makeup (add-on hairdo)
  'e0000000-0000-4000-8000-000000000006', // 6: Dokumentasi Wisuda
  'e0000000-0000-4000-8000-000000000007', // 7: Moment Graduation
  'e0000000-0000-4000-8000-000000000008', // 8: Glow Studio PA
  'e0000000-0000-4000-8000-000000000009'  // 9: Arbeya Flo
];

async function syncBookingToSupabase(b) {
  if (!supabase) return;
  try {
    const isUuid = (val) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(val));
    const vendor_id = isUuid(b.vendor_id)
      ? b.vendor_id
      : (VENDOR_UUIDS[(Number(b.vendor_id) - 1) % VENDOR_UUIDS.length] || VENDOR_UUIDS[0]);

    const payload = {
      id: b.id,
      user_id: isUuid(b.user_id) ? b.user_id : 'd32824cc-da8b-4ed5-b8aa-af8a62daac53',
      vendor_id,
      event_date: b.event_date || '2026-12-05',
      location: b.location || 'Malang',
      start_time: b.start_time || '08:00',
      price: b.price || 150000,
      deposit: b.deposit || 0,
      paid: b.paid || 0,
      state: b.state || 'Pending',
      late_booking: Boolean(b.late_booking),
      arrival_code: b.arrival_code || '482910',
      vendor_arrived: Boolean(b.vendor_arrived),
      agreement: typeof b.agreement === 'object' ? JSON.stringify(b.agreement) : (b.agreement || ''),
      hash: b.hash || '',
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase.from('bookings').upsert(payload, { onConflict: 'id' });
    if (error) console.error('[Supabase Upsert Booking Error]', error.message);
  } catch (err) {
    console.error('[Supabase Upsert Exception]', err.message);
  }
}
const localReviews  = [
  { id: 'rev-1', vendor_name: 'Hijab Do Malang', client_name: 'Rani K.', rating: 5, comment: 'Puas banget! Datang tepat waktu, hijab stylist rapi dan tahan seharian pas wisuda.', date: '15 Nov 2026' },
  { id: 'rev-2', vendor_name: 'Glow Studio PA', client_name: 'Dinda P.', rating: 5, comment: 'PA-nya super helpful, nemenin dari pagi sampai foto toga beres.', date: '12 Nov 2026' },
  { id: 'rev-3', vendor_name: 'Lolita Makeup', client_name: 'Sarah M.', rating: 5, comment: 'Makeup flawless dan gak cakey sama sekali. Recommended wisudawan UB!', date: '10 Nov 2026' }
];
const localVendorApplications = [];

// Seed default booking untuk demo pengujian LK-2611
const defaultDemoAgreement = JSON.stringify({
  vendorId: 1,
  vendorName: 'Glow Studio PA',
  category: 'PA',
  date: '2026-11-28',
  location: 'Malang',
  startTime: '08:00',
  price: 450000,
  deposit: 0,
  isLateBooking: false,
  paymentSchedule: {
    upfrontPercent: 30,
    upfrontAmount: 135000,
    finalPercent: 70,
    finalAmount: 315000,
    invoiceDaysBefore: 3,
    dueDaysBefore: 1
  },
  refundPolicy: {
    tiers: POLICY.REFUND_TIERS.map(t => ({ label: t.label, description: t.description })),
    vendorCancellation: 'Vendor membatalkan sepihak: 100% dana kembali ke pelanggan + sanksi suspend vendor.',
    forceMajeure: 'Force majeure diverifikasi admin: 100% refund atau opsi reschedule.'
  },
  disputePolicy: {
    windowHours: POLICY.DISPUTE_FILE_WINDOW_HOURS,
    vendorResponseHours: POLICY.VENDOR_RESPONSE_WINDOW_HOURS,
    evidenceRequired: true,
    autoReleaseHours: POLICY.AUTO_RELEASE_HOURS_AFTER_EVENT,
    description: 'Keluhan diajukan dalam 48 jam pasca acara dengan bukti wajib. Pencairan ditahan selama sengketa berlangsung.'
  },
  antiOffPlatformPolicy: {
    penaltyPercent: POLICY.OFF_PLATFORM_PENALTY_PERCENT,
    description: 'Dilarang transaksi atau pelunasan di luar platform LockIn. Pelanggaran dikenakan sanksi denda 30% dari dana tertahan dan pembatalan hak mediasi.'
  },
  scope: 'Pendampingan wisuda profesional, standby 30 menit sebelum sesi dimulai, penanganan toga dan touchup kilat.'
}, null, 2);

const defaultDemoBooking = {
  id: 'LK-2611',
  user_id: 'd32824cc-da8b-4ed5-b8aa-af8a62daac53',
  vendor_id: 1,
  vendor_name: 'Glow Studio PA',
  category: 'PA',
  owner_id: 'd9d01426-73a7-43e6-86fe-d296b200d0b1',
  event_date: '2026-11-28',
  location: 'Malang',
  start_time: '08:00',
  price: 450000,
  deposit: 0,
  paid: 135000,
  late_booking: false,
  state: 'DPPaid',
  arrival_code: '482910',
  vendor_arrived: false,
  agreement: defaultDemoAgreement,
  hash: '0x7a3f89b1cd56e43a902bf817c91e',
  tx_hash: '0x91b2c45e8a719bf320146039580efda3097cb04ad',
  created_at: new Date(Date.now() - 86400000).toISOString()
};
localBookings.set('LK-2611', defaultDemoBooking);
syncBookingToSupabase(defaultDemoBooking);

// Auto-release worker check: Jika 48 jam pasca acara tanpa keluhan, dana otomatis cair ke vendor
function checkAutoRelease() {
  const curTime = Date.now();
  for (const b of localBookings.values()) {
    if (b.state === 'Paid' && b.event_date) {
      const eventEnd = new Date(b.event_date).getTime() + (24 * 3600 * 1000);
      const autoReleaseTime = eventEnd + (POLICY.AUTO_RELEASE_HOURS_AFTER_EVENT * 3600 * 1000);
      const dispute = localDisputes.get(b.id);
      if (curTime >= autoReleaseTime && !dispute) {
        b.state = 'Completed';
        b.updated_at = now();
        localAudit.push({ booking_id: b.id, state: 'Completed:AutoReleased', created_at: now() });
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const now  = () => new Date().toISOString();
const localToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
const digest = text => '0x' + createHash('sha256').update(text).digest('hex');
const send = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
};

// ─── Session helper (Supabase Auth + fallback demo sessions) ─────────────────
async function userOf(req) {
  const token = /lockin_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
  if (!token) return null;

  // Cek local session dulu
  const local = localSessions.get(token);
  if (local && local.expires > Date.now()) return local.user;

  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from('sessions')
      .select('*, users(id, name, email, role)')
      .eq('token', token)
      .gt('expires', Date.now())
      .single();
    return data?.users || null;
  } catch {
    return null;
  }
}

async function body(req) {
  let chunks = '', size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 100000) fail(413, 'Data terlalu besar.');
    chunks += c;
  }
  try { return JSON.parse(chunks || '{}'); } catch { fail(400, 'JSON tidak valid.'); }
}

function validateText(value, label, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, `${label} tidak valid.`);
  return value.trim();
}

// ─── Expire pending bookings ─────────────────────────────────────────────────
async function expireBookings() {
  if (supabase) {
    try {
      await supabase.from('bookings').update({ state: 'Expired', updated_at: now() })
        .eq('state', 'Pending').lt('expires', Date.now());
    } catch {}
  }
  for (const b of localBookings.values()) {
    if (b.state === 'Pending' && b.expires < Date.now()) b.state = 'Expired';
  }
}

// ─── Booking helper (dengan role check) ──────────────────────────────────────
async function getBooking(id, user) {
  let b = null;
  if (supabase) {
    try {
      const { data } = await supabase
        .from('bookings')
        .select('*, vendors(name, category, owner_id)')
        .eq('id', id)
        .single();
      if (data) {
        b = { ...data, vendor_name: data.vendors?.name, category: data.vendors?.category, owner_id: data.vendors?.owner_id };
      }
    } catch {}
  }
  if (!b) b = localBookings.get(id);
  if (!b) fail(404, 'Booking tidak ditemukan.');
  if (user.role !== 'admin' && b.user_id !== user.id &&
     !(user.role === 'vendor' && b.owner_id === user.id))
    fail(403, 'Anda tidak memiliki akses ke booking ini.');
  return b;
}

// ─── API Router ───────────────────────────────────────────────────────────────
async function api(req, res, url) {
  await expireBookings();
  const path = url.pathname, method = req.method;
  const user = await userOf(req);

  // CSRF: tolak request dari origin lain
  if (method !== 'GET' && req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}` &&
      req.headers.origin !== `https://${req.headers.host}`) {
    fail(403, 'Origin tidak diizinkan.');
  }

  // ── Health ──
  if (path === '/api/health')
    return send(res, 200, { ok: true, mode: 'sandbox', database: isSupabaseConfigured() ? 'Supabase' : 'Lokal Demo', blockchain: isBlockchainConfigured(), midtrans: isMidtransConfigured() });

  // ── Auth ──
  if (path === '/api/auth/me')
    return send(res, 200, { user: user || null });

  if (path === '/api/auth/logout' && method === 'POST') {
    const token = /lockin_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
    if (token) {
      localSessions.delete(token);
      if (supabase) {
        try { await supabase.from('sessions').delete().eq('token', token); } catch {}
      }
    }
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'lockin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }

  if (['/api/auth/login', '/api/auth/register'].includes(path) && method === 'POST') {
    const d = await body(req);
    const email = validateText(d.email, 'Email', 160).toLowerCase();
    const password = validateText(d.password, 'Password', 128);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Format email tidak valid.');

    // 1. Cek Akun Demo bawaan langsung (Kredensial resmi demo presentasi)
    const validPasswords = ['password123', 'demo123', 'LockInDemo123!', 'pelanggan123', 'vendor123', 'admin123'];
    if (demoAccounts[email] && validPasswords.includes(password)) {
      const token = randomBytes(32).toString('hex');
      localSessions.set(token, { user: demoAccounts[email], expires: Date.now() + 86400000 });
      return send(res, 200, { user: demoAccounts[email] }, { 'Set-Cookie': `lockin_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400` });
    }

    if (path.endsWith('register')) {
      if (password.length < 10) fail(400, 'Password minimal 10 karakter.');
      if (supabase) {
        const { error } = await supabase.auth.signUp({ email, password, options: { data: { name: validateText(d.name, 'Nama', 80), role: 'customer' } } });
        if (error) fail(error.status || 400, error.message);
      }
      const newAcc = { id: randomBytes(16).toString('hex'), name: validateText(d.name, 'Nama', 80), email, role: 'customer' };
      demoAccounts[email] = newAcc;
      const token = randomBytes(32).toString('hex');
      localSessions.set(token, { user: newAcc, expires: Date.now() + 86400000 });
      return send(res, 200, { user: newAcc }, { 'Set-Cookie': `lockin_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400` });
    }

    // 2. Cek lewat Supabase Auth jika ada
    if (supabase) {
      const { data: authData, error } = await supabase.auth.signInWithPassword({ email, password });
      if (!error && authData?.user) {
        const token = randomBytes(32).toString('hex');
        try {
          await supabase.from('sessions').insert({ token, user_id: authData.user.id, expires: Date.now() + 86400000 });
        } catch {}
        const profile = { id: authData.user.id, name: authData.user.user_metadata?.name || email.split('@')[0], email, role: authData.user.user_metadata?.role || 'customer' };
        localSessions.set(token, { user: profile, expires: Date.now() + 86400000 });
        return send(res, 200, { user: profile }, { 'Set-Cookie': `lockin_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400` });
      }
    }

    fail(401, 'Email atau password salah.');
  }

  // ── Central Business Policy (public) ──
  if (path === '/api/policy' && method === 'GET') {
    return send(res, 200, POLICY);
  }

  // ── Public On-Chain & Agreement Verification ──
  const verifyMatch = /^\/api\/verify\/([^/]+)$/.exec(path);
  if (verifyMatch && method === 'GET') {
    const id = verifyMatch[1];
    let b = localBookings.get(id);
    if (!b && supabase) {
      try {
        const { data } = await supabase.from('bookings').select('*, vendors(name, category)').eq('id', id).single();
        if (data) b = { ...data, vendor_name: data.vendors?.name, category: data.vendors?.category };
      } catch {}
    }
    if (!b && id.toUpperCase() === 'LK-2611') {
      b = defaultDemoBooking;
    }
    if (!b) fail(404, 'Kode booking tidak ditemukan dalam pencatatan on-chain.');

    let agreementObj = b.agreement;
    if (typeof agreementObj === 'string') {
      try { agreementObj = JSON.parse(agreementObj); } catch {}
    }

    return send(res, 200, {
      id: b.id,
      vendor_name: b.vendor_name || 'Glow Studio PA',
      category: b.category || 'PA',
      event_date: b.event_date || '2026-11-28',
      state: b.state,
      price: b.price || 450000,
      paid: b.paid || 135000,
      completion_evidence: b.completion_evidence || null,
      hash: b.hash || '0x7a3f89b1cd56e43a902bf817c91e',
      agreement: agreementObj,
      contract_address: process.env.CONTRACT_ADDRESS || '0x4fbc0A8741369796Fe9a7A2Dcf8D6Aee4744473E',
      network: 'Ethereum Sepolia Testnet',
      tx_hash: b.tx_hash || '0x91b2c45e8a719bf320146039580efda3097cb04ad'
    });
  }

  // ── Vendors (public) ──
  if (path === '/api/vendors' && method === 'GET') {
    let result = [];
    if (supabase) {
      try {
        let q = supabase.from('vendors').select('id,name,category,price,deposit,rating,completed,verified,color,description');
        const category = url.searchParams.get('category');
        if (category && category !== 'Semua') q = q.eq('category', category);
        const { data: rows, error } = await q;
        if (!error && rows?.length) result = rows;
      } catch {}
    }

    // Fallback otomatis ke vendor demo lokal jika tabel Supabase belum diisi
    if (!result.length) {
      result = [...DEMO_VENDORS];
      const category = url.searchParams.get('category');
      if (category && category !== 'Semua') result = result.filter(v => v.category === category);
    }

    const city = url.searchParams.get('city');
    if (city && !'malang'.includes(city.toLowerCase())) return send(res, 200, []);
    const date = url.searchParams.get('date');
    if (date) {
      const bookedIds = new Set();
      if (supabase) {
        try {
          const { data: booked } = await supabase.from('bookings').select('vendor_id').eq('event_date', date).not('state', 'in', '("Expired","Cancelled","Refunded")');
          (booked || []).forEach(b => bookedIds.add(b.vendor_id));
        } catch {}
      }
      for (const b of localBookings.values()) {
        if (b.event_date === date && !['Expired', 'Cancelled', 'Refunded'].includes(b.state)) {
          bookedIds.add(b.vendor_id);
        }
      }
      result = result.filter(v => !bookedIds.has(v.id));
    }
    if (url.searchParams.get('sort') === 'price') result.sort((a, b) => a.price - b.price);
    if (url.searchParams.get('sort') === 'rating') result.sort((a, b) => b.rating - a.rating);
    return send(res, 200, result);
  }

  if (/^\/api\/vendors\/[^/]+$/.test(path) && method === 'GET') {
    const id = path.split('/').pop();
    let v = null;
    if (supabase) {
      try {
        const { data } = await supabase.from('vendors').select('*').eq('id', id).single();
        if (data) v = data;
      } catch {}
    }
    if (!v) {
      v = DEMO_VENDORS.find(item => String(item.id) === String(id));
    }
    if (!v) fail(404, 'Vendor tidak ditemukan.');
    const reserved = [];
    for (const b of localBookings.values()) {
      if (String(b.vendor_id) === String(v.id) && !['Expired', 'Cancelled', 'Refunded'].includes(b.state)) {
        reserved.push(b.event_date);
      }
    }
    return send(res, 200, { ...v, reserved });
  }

  // ── Leads (public) ──
  if (path === '/api/leads' && method === 'POST') {
    const d = await body(req);
    const contact = validateText(d.contact, 'Email atau WhatsApp', 160);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) && !/^\+?[\d\s-]{9,18}$/.test(contact))
      fail(400, 'Masukkan email atau nomor WhatsApp yang valid.');
    if (supabase) {
      try { await supabase.from('leads').upsert({ contact, created_at: now() }, { onConflict: 'contact', ignoreDuplicates: true }); } catch {}
    }
    return send(res, 201, { message: 'Terima kasih! Pendaftaran minat vendor tersimpan.' });
  }

  // ── Pendaftaran Vendor 2 Tahap (public) ──
  if (path === '/api/vendor-applications' && method === 'POST') {
    const d = await body(req);
    const appData = {
      id: 'VAPP-' + randomBytes(4).toString('hex').toUpperCase(),
      name: validateText(d.brandName || d.name, 'Nama Usaha', 120),
      owner_name: validateText(d.ownerName || d.name, 'Nama Pemilik', 80),
      email: validateText(d.email, 'Email', 160).toLowerCase(),
      whatsapp: validateText(d.whatsapp, 'WhatsApp', 40),
      category: validateText(d.category, 'Kategori Jasa', 60),
      instagram: d.instagram ? String(d.instagram).trim() : '',
      portfolio_url: d.portfolioUrl ? String(d.portfolioUrl).trim() : '',
      description: d.description ? String(d.description).trim() : '',
      price_range: d.priceRange || 'Mulai 250rb',
      status: 'pending_approval',
      created_at: now()
    };
    localVendorApplications.push(appData);
    return send(res, 201, {
      ok: true,
      message: 'Pendaftaran vendor berhasil dikirim! Tim kurasi admin LockIn akan memverifikasi dalam 1x24 jam. Kredensial dan password akan dikirimkan ke email terdaftar setelah disetujui.',
      application: appData
    });
  }

  // ── Reviews & Ratings (public GET, user POST) ──
  if (path === '/api/reviews' && method === 'GET') {
    return send(res, 200, localReviews);
  }
  if (path === '/api/reviews' && method === 'POST') {
    const d = await body(req);
    const rev = {
      id: 'rev-' + randomBytes(4).toString('hex'),
      vendor_name: validateText(d.vendor_name || 'Vendor Wisuda', 'Nama Vendor', 100),
      client_name: (user && user.name) ? user.name : validateText(d.client_name || 'Pelanggan LockIn', 'Nama Klien', 80),
      rating: Math.min(5, Math.max(1, Number(d.rating) || 5)),
      comment: validateText(d.comment || 'Layanan memuaskan dan tepat waktu!', 'Ulasan', 1000),
      date: new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })
    };
    localReviews.unshift(rev);
    return send(res, 201, { ok: true, review: rev });
  }

  // ── Auth required beyond this point ──
  if (!user) fail(401, 'Silakan masuk terlebih dahulu.');

  // ── Bookings list ──
  if (path === '/api/bookings' && method === 'GET') {
    checkAutoRelease();
    let rows = [];
    if (supabase) {
      try {
        const { data } = await supabase.from('bookings').select('*, vendors(name, category, owner_id)').order('created_at', { ascending: false });
        if (data?.length) rows = data;
      } catch {}
    }
    if (!rows.length) {
      rows = Array.from(localBookings.values());
    }
    const filtered = rows.filter(b =>
      user.role === 'admin' || b.user_id === user.id ||
      (user.role === 'vendor' && (b.owner_id === user.id || b.vendors?.owner_id === user.id))
    ).map(b => ({ ...b, vendor_name: b.vendor_name || b.vendors?.name, category: b.category || b.vendors?.category }));
    return send(res, 200, filtered);
  }

  // ── Create booking ──
  if (path === '/api/bookings' && method === 'POST') {
    if (user.role !== 'customer') fail(403, 'Gunakan akun pelanggan untuk membuat booking.');
    const d = await body(req);
    let v = null;
    if (supabase) {
      try {
        const { data } = await supabase.from('vendors').select('*').eq('id', d.vendorId).single();
        if (data) v = data;
      } catch {}
    }
    if (!v) v = DEMO_VENDORS.find(item => String(item.id) === String(d.vendorId));
    if (!v) fail(404, 'Vendor tidak ditemukan.');
    if (!d.agreed) fail(400, 'Setujui perjanjian terlebih dahulu.');
    const date = validateText(d.date, 'Tanggal', 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < localToday()) fail(400, 'Pilih tanggal acara yang valid dan belum lewat.');
    const location = validateText(d.location, 'Lokasi', 200);
    const start = validateText(d.startTime, 'Jam mulai', 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) fail(400, 'Jam mulai tidak valid.');

    // Cek indikasi ajakan transaksi luar platform
    const violationCheck = detectOffPlatformViolation(location + ' ' + (d.notes || ''));

    // Cek konflik jadwal
    for (const b of localBookings.values()) {
      if (String(b.vendor_id) === String(v.id) && b.event_date === date && !['Expired', 'Cancelled', 'Refunded'].includes(b.state)) {
        if (b.user_id === user.id && ['Pending', 'WaitingVendorApproval'].includes(b.state)) {
          return send(res, 200, await getBooking(b.id, user));
        }
        fail(409, 'Vendor sudah dipesan pada tanggal ini. Pilih tanggal lain.');
      }
    }

    const late = isLateBooking(date);
    const schedule = getPaymentSchedule(date);
    const upfrontAmount = late
      ? Math.round(v.price * (schedule.upfrontPercent / 100))
      : (v.deposit ? v.price + v.deposit : Math.round(v.price * (schedule.upfrontPercent / 100)));
    const finalAmount = Math.max(0, v.price - upfrontAmount);

    const agreement = JSON.stringify({
      vendorId: v.id,
      vendorName: v.name,
      category: v.category,
      date,
      location,
      startTime: start,
      price: v.price,
      deposit: v.deposit,
      isLateBooking: late,
      paymentSchedule: {
        upfrontPercent: schedule.upfrontPercent,
        upfrontAmount,
        finalPercent: schedule.finalPercent,
        finalAmount,
        invoiceDaysBefore: schedule.invoiceDaysBefore,
        dueDaysBefore: schedule.dueDaysBefore
      },
      refundPolicy: {
        tiers: POLICY.REFUND_TIERS.map(t => ({ label: t.label, description: t.description })),
        vendorCancellation: 'Vendor membatalkan sepihak: 100% dana kembali ke pelanggan + penalti vendor.',
        forceMajeure: 'Force majeure diverifikasi admin: 100% refund atau reschedule.'
      },
      disputePolicy: {
        windowHours: POLICY.DISPUTE_FILE_WINDOW_HOURS,
        vendorResponseHours: POLICY.VENDOR_RESPONSE_WINDOW_HOURS,
        evidenceRequired: true,
        autoReleaseHours: POLICY.AUTO_RELEASE_HOURS_AFTER_EVENT,
        description: 'Keluhan dapat diajukan dalam 48 jam pasca acara dengan bukti wajib. Pencairan ditahan selama proses mediasi.'
      },
      antiOffPlatformPolicy: {
        penaltyPercent: POLICY.OFF_PLATFORM_PENALTY_PERCENT,
        description: 'Dilarang transaksi di luar platform. Pelanggaran dikenakan sanksi denda 30% dan kehilangan jaminan refund serta hak mediasi.'
      },
      scope: v.description,
      ...(v.category === 'GCC' ? { revisions: 1, files: 30 } : {})
    });
    const hash = digest(agreement);

    const id = 'LI-' + randomBytes(5).toString('hex').toUpperCase();
    const bookingData = {
      id,
      user_id: user.id,
      vendor_id: v.id,
      vendor_name: v.name,
      category: v.category,
      owner_id: v.owner_id || 'd9d01426-73a7-43e6-86fe-d296b200d0b1',
      event_date: date,
      location,
      start_time: start,
      price: v.price,
      deposit: v.deposit,
      paid: 0,
      late_booking: late,
      vendor_accepted_at: late ? null : now(),
      state: late ? 'WaitingVendorApproval' : 'Pending',
      arrival_code: String(Math.floor(100000 + Math.random() * 900000)),
      vendor_arrived: false,
      agreement,
      hash,
      created_at: now(),
      expires: Date.now() + (late ? POLICY.VENDOR_ACCEPT_WINDOW_HOURS * 3600 * 1000 : 86400000),
      off_platform_warning: violationCheck.warning || null
    };
    localBookings.set(id, bookingData);
    localAudit.push({ booking_id: id, state: 'AgreementLocked', created_at: now() });
    await syncBookingToSupabase(bookingData);
    if (supabase) {
      try { await supabase.from('audit').insert({ booking_id: id, state: 'AgreementLocked', created_at: now() }); } catch {}
    }

    return send(res, 201, await getBooking(id, user));
  }

  // ── Single booking actions ──
  const match = /^\/api\/bookings\/([^/]+)(?:\/(payment|complete|cancel|dispute|audit|sync-payment|accept|reject|refund-estimate|report-off-platform|verify-arrival))?$/.exec(path);
  if (match) {
    checkAutoRelease();
    const b = await getBooking(match[1], user);
    const action = match[2];

    const isOwner = b.user_id === user.id;
    const isVendor = user.role === 'vendor' && (b.owner_id === user.id || user.id === 'd9d01426-73a7-43e6-86fe-d296b200d0b1');
    const isAdmin = user.role === 'admin';

    if (method === 'GET' && !action) {
      const pendingPay = Array.from(localPayments.values()).find(p => p.booking_id === b.id && p.outcome === 'pending' && p.redirect_url);
      const dispute = localDisputes.get(b.id) || null;
      return send(res, 200, {
        ...b,
        dispute,
        dpBlockchain: null,
        finalBlockchain: null,
        ledgerHeld: b.paid || 0,
        pendingPayment: pendingPay || null,
        blockchainConfigured: isBlockchainConfigured(),
        policy: {
          isLate: b.late_booking || false,
          upfrontPercent: b.late_booking ? POLICY.LATE_BOOKING_UPFRONT_PERCENT : POLICY.DP_PERCENT,
          finalPercent: b.late_booking ? (100 - POLICY.LATE_BOOKING_UPFRONT_PERCENT) : (100 - POLICY.DP_PERCENT),
          vendorAcceptWindowHours: POLICY.VENDOR_ACCEPT_WINDOW_HOURS,
          autoReleaseHours: POLICY.AUTO_RELEASE_HOURS_AFTER_EVENT
        }
      });
    }

    if (method === 'GET' && action === 'audit') {
      const audits = localAudit.filter(a => a.booking_id === b.id);
      return send(res, 200, audits);
    }

    if (method === 'GET' && action === 'refund-estimate') {
      const estimate = calculateRefund({
        eventDate: b.event_date,
        totalPaid: b.paid || 0,
        price: b.price,
        isVendorCancellation: user.role === 'vendor'
      });
      return send(res, 200, { estimate, booking: b });
    }

    if (method !== 'POST') fail(405, 'Metode tidak diizinkan.');

    // Vendor actions: accept / reject late booking
    if (action === 'accept') {
      if (!isVendor && !isAdmin) fail(403, 'Hanya vendor atau admin yang dapat menerima booking.');
      if (b.state !== 'WaitingVendorApproval') fail(409, 'Hanya booking yang menunggu persetujuan vendor yang dapat diterima.');
      if (Date.now() > b.expires) {
        b.state = 'Cancelled';
        b.updated_at = now();
        localAudit.push({ booking_id: b.id, state: 'Cancelled:VendorAcceptTimeout', created_at: now() });
        fail(410, 'Batas waktu persetujuan vendor (3 jam) telah berakhir. Booking otomatis dibatalkan.');
      }
      b.state = b.paid > 0 ? 'DPPaid' : 'Pending';
      b.vendor_accepted_at = now();
      b.updated_at = now();
      localAudit.push({ booking_id: b.id, state: 'VendorAccepted', created_at: now() });
      return send(res, 200, { ...b, message: 'Booking diterima oleh vendor.' });
    }

    if (action === 'reject') {
      if (!isVendor && !isAdmin) fail(403, 'Hanya vendor atau admin yang dapat menolak booking.');
      const refund = b.paid || 0;
      b.state = 'Cancelled';
      b.paid = 0;
      b.updated_at = now();
      localAudit.push({ booking_id: b.id, state: `VendorRejected:refund=${refund}`, created_at: now() });
      return send(res, 200, { ...b, refund, message: 'Booking ditolak vendor. Dana 100% dikembalikan ke pelanggan.' });
    }

    const d = await body(req);

    if (action === 'report-off-platform') {
      const reason = validateText(d.reason, 'Alasan laporan', 500);
      const evidence = validateText(d.evidence, 'Bukti pelanggaran', 2000);
      b.off_platform_reported = true;
      b.updated_at = now();
      localReports.push({ booking_id: b.id, reporter_id: user.id, role: user.role, reason, evidence, created_at: now() });
      localAudit.push({ booking_id: b.id, state: 'OffPlatformReported', created_at: now() });
      return send(res, 200, {
        ok: true,
        message: 'Laporan pembayaran di luar platform berhasil dikirim. Sanksi denda 30% dan pencabutan hak mediasi akan ditinjau oleh admin.'
      });
    }

    if (!isOwner && !isAdmin && !isVendor) fail(403, 'Akses ditolak.');

    if (action === 'payment') {
      if (!isOwner && !isAdmin) fail(403, 'Hanya pemilik booking yang dapat melakukan pembayaran.');
      if (!['Pending', 'DPPaid', 'WaitingVendorApproval'].includes(b.state)) fail(409, 'Booking tidak dapat dibayar pada status ini.');
      if (d.expectedState && d.expectedState !== b.state) fail(409, 'Status pembayaran telah berubah. Muat ulang halaman.');

      const isLate = Boolean(b.late_booking);
      const upfrontPercent = isLate ? POLICY.LATE_BOOKING_UPFRONT_PERCENT : POLICY.DP_PERCENT;

      const amount = (b.state === 'Pending' || b.state === 'WaitingVendorApproval')
        ? (b.deposit ? b.price + b.deposit : Math.round(b.price * (upfrontPercent / 100)))
        : b.price - b.paid;

      const paymentType = b.state === 'DPPaid' ? 'FINAL' : 'DP';

      // Mode Midtrans aktif
      if (isMidtransConfigured() && d.outcome !== 'failed' && d.outcome !== 'expired') {
        const orderId = `LOCKIN-${paymentType}-${b.id}-${randomBytes(4).toString('hex')}`;
        let snapRes;
        try { snapRes = await createSnapPayment({ orderId, amount }); }
        catch (err) { fail(502, 'Gagal membuat checkout Midtrans: ' + err.message); }
        const redirectUrl = typeof snapRes === 'string' ? snapRes : snapRes.redirectUrl;
        const token = typeof snapRes === 'object' ? snapRes.token : null;
        const payData = { id: randomBytes(12).toString('hex'), booking_id: b.id, method: d.method || 'Midtrans', amount, outcome: 'pending', created_at: now(), provider_order_id: orderId, redirect_url: redirectUrl, payment_type: paymentType };
        localPayments.set(payData.id, payData);
        if (supabase) {
          try { await supabase.from('payments').insert(payData); } catch {}
        }
        return send(res, 200, { redirect_url: redirectUrl, token, reused: false, id: b.id });
      }

      // Mode simulasi (tanpa Midtrans)
      if (!['QRIS', 'Virtual Account', 'E-wallet'].includes(d.method)) fail(400, 'Metode pembayaran tidak valid.');
      if (!['success', 'failed', 'expired'].includes(d.outcome)) fail(400, 'Skenario pembayaran tidak valid.');
      const payId = randomBytes(12).toString('hex');
      const payData = { id: payId, booking_id: b.id, method: d.method, amount, outcome: d.outcome, created_at: now(), payment_type: paymentType };
      localPayments.set(payId, payData);

      if (d.outcome === 'success') {
        const state = b.deposit || b.state === 'DPPaid' ? 'Paid' : 'DPPaid';
        b.paid = (b.paid || 0) + amount;
        b.state = state;
        b.updated_at = now();
        localAudit.push({ booking_id: b.id, state, created_at: now() });
        await syncBookingToSupabase(b);
      } else if (d.outcome === 'expired') {
        b.state = 'Expired';
        b.updated_at = now();
        localAudit.push({ booking_id: b.id, state: 'Expired', created_at: now() });
        await syncBookingToSupabase(b);
      }
      return send(res, 200, { ...b, outcome: d.outcome });
    }

    if (action === 'complete') {
      if (b.state !== 'Paid' && b.state !== 'DPPaid') fail(409, 'Booking belum memenuhi syarat penyelesaian.');
      if (isVendor) {
        const evidence = validateText(d.evidence || d.proofUrl || '', 'Bukti penyelesaian pekerjaan', 2000);
        if (!evidence || evidence.trim().length < 5) fail(400, 'Vendor wajib menyertakan bukti penyelesaian kerja (tautan file foto/video hasil atau serah terima).');
        b.completion_evidence = evidence;
        b.updated_at = now();
        localAudit.push({ booking_id: b.id, state: 'VendorProofSubmitted', created_at: now() });
        return send(res, 200, { ...b, message: 'Bukti kerja berhasil diunggah. Menunggu konfirmasi pelanggan atau auto-release 48 jam.' });
      }

      b.state = 'Completed';
      b.updated_at = now();
      localAudit.push({ booking_id: b.id, state: 'Completed', created_at: now() });
      await syncBookingToSupabase(b);
      return send(res, 200, b);
    }

    if (action === 'cancel') {
      if (!['Pending', 'DPPaid', 'Paid', 'WaitingVendorApproval'].includes(b.state)) fail(409, 'Booking tidak dapat dibatalkan.');
      const refundCalc = calculateRefund({
        eventDate: b.event_date,
        totalPaid: b.paid || 0,
        price: b.price,
        isVendorCancellation: user.role === 'vendor'
      });
      const refund = refundCalc.refundAmount + (b.deposit && b.paid ? b.deposit : 0);
      b.state = 'Cancelled';
      b.updated_at = now();
      localAudit.push({ booking_id: b.id, state: `Cancelled:tier=${refundCalc.tier}:refund=${refund}`, created_at: now() });
      return send(res, 200, { ...b, refund, refundTier: refundCalc.tier, refundDescription: refundCalc.description });
    }

    if (action === 'dispute') {
      if (!['DPPaid', 'Paid'].includes(b.state)) fail(409, 'Keluhan hanya untuk booking yang sudah dibayar.');
      const reason = validateText(d.reason, 'Alasan', 1000);
      const evidence = validateText(d.evidence, 'Bukti keluhan', 4000);
      if (!evidence || evidence.trim().length < 5) {
        fail(400, 'Keluhan wajib menyertakan bukti tertulis dan tautan berkas pendukung (foto, hasil kerja, atau chat).');
      }
      const id = 'DSP-' + randomBytes(4).toString('hex').toUpperCase();
      const disputeData = {
        id,
        booking_id: b.id,
        reason,
        evidence,
        evidence_url: d.evidenceUrl || null,
        response: '',
        vendor_evidence_url: null,
        vendor_response_due: new Date(Date.now() + POLICY.VENDOR_RESPONSE_WINDOW_HOURS * 3600 * 1000).toISOString(),
        created_at: now()
      };
      localDisputes.set(b.id, disputeData);
      b.state = 'Disputed';
      b.updated_at = now();
      localAudit.push({ booking_id: b.id, state: 'Disputed', created_at: now() });
      return send(res, 201, { id, message: 'Keluhan diajukan. Pencairan dana ditahan sampai admin memutuskan.' });
    }

    if (action === 'verify-arrival') {
      const code = String(d.otp || d.code || '').trim();
      const expected = String(b.arrival_code || '482910').trim();
      if (!code || code !== expected) {
        fail(400, 'Kode OTP kedatangan tidak cocok. Minta 6-digit kode OTP kedatangan kepada pelanggan.');
      }
      b.vendor_arrived = true;
      b.vendor_arrived_at = now();
      b.updated_at = now();
      localAudit.push({ booking_id: b.id, state: 'VendorArrivalVerified', created_at: now() });
      await syncBookingToSupabase(b);
      return send(res, 200, { ok: true, message: 'Vendor terverifikasi telah tiba dan check-in di lokasi acara.', booking: b });
    }

    if (action === 'sync-payment') {
      if (!isMidtransConfigured()) fail(400, 'Midtrans tidak dikonfigurasi.');
      const pay = Array.from(localPayments.values()).reverse().find(p => p.booking_id === b.id && p.provider_order_id);
      if (!pay) fail(404, 'Belum ada transaksi pembayaran Midtrans.');
      try {
        const status = await fetchMidtransStatus(pay.provider_order_id);
        const result = await recordNotification(status, { localBookings, localPayments, localAudit });
        await syncBookingToSupabase(b);
        return send(res, 200, { result, booking: b });
      } catch (err) { fail(502, 'Gagal memeriksa pembayaran: ' + err.message); }
    }
  }

  // ── Disputes (vendor/admin) ──
  if (path === '/api/disputes' && method === 'GET') {
    if (user.role !== 'admin' && user.role !== 'vendor') fail(403, 'Akses ditolak.');
    const rows = Array.from(localDisputes.values()).map(d => {
      const b = localBookings.get(d.booking_id) || {};
      return { ...d, event_date: b.event_date, paid: b.paid, state: b.state, vendor_name: b.vendor_name, owner_id: b.owner_id };
    });
    return send(res, 200, rows.filter(d => user.role === 'admin' || d.owner_id === user.id));
  }

  const disputeMatch = /^\/api\/disputes\/([^/]+)\/(resolve|response)$/.exec(path);
  if (disputeMatch && method === 'POST') {
    const d = await body(req);
    const disputeId = disputeMatch[1];
    const dispute = Array.from(localDisputes.values()).find(x => x.id === disputeId);
    if (!dispute) fail(404, 'Sengketa tidak ditemukan.');
    const b = await getBooking(dispute.booking_id, user);
    if (dispute.decision) fail(409, 'Sengketa telah diputuskan.');
    if (disputeMatch[2] === 'response') {
      if (user.role !== 'vendor' || b.owner_id !== user.id) fail(403, 'Hanya vendor terkait yang dapat menanggapi.');
      dispute.response = validateText(d.response, 'Tanggapan', 4000);
      return send(res, 200, { ok: true });
    }
    if (user.role !== 'admin') fail(403, 'Hanya admin yang dapat memutuskan sengketa.');
    if (!['vendor', 'sebagian', 'penuh', 'release', 'partial', 'full'].includes(d.decision)) fail(400, 'Keputusan tidak valid.');
    const reason = validateText(d.reason || 'Keputusan mediasi admin berdasarkan bukti', 'Alasan keputusan', 1000);
    const percent = (d.decision === 'penuh' || d.decision === 'full') ? 100 : (d.decision === 'vendor' || d.decision === 'release') ? 0 : Number(d.percent || 50);
    const refund = Math.round((b.paid || 0) * percent / 100);
    dispute.decision = d.decision;
    dispute.decision_reason = reason;
    dispute.refund = refund;
    dispute.decided_at = now();
    b.state = percent === 100 ? 'Refunded' : 'Resolved';
    b.updated_at = now();
    localAudit.push({ booking_id: b.id, state: `Resolved:${d.decision}:refund=${refund}`, created_at: now() });
    return send(res, 200, { ok: true, refund, dispute });
  }

  fail(404, 'Endpoint tidak ditemukan.');
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  try {
    const url = new URL(req.url, 'http://localhost');

    // Webhook Midtrans
    if (url.pathname === '/webhooks/midtrans' && req.method === 'POST') {
      const d = await body(req);
      return handleMidtransWebhook(req, res, d, { localBookings, localPayments, localAudit });
    }

    // Return URL setelah Midtrans payment
    if (url.pathname === '/payment/return' && req.method === 'GET') {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }

    if (url.pathname.startsWith('/api/')) return await api(req, res, url);

    // Static file server (frontend)
    if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'Metode tidak diizinkan.');
    const file = resolve(publicRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(publicRoot + '\\') && !file.startsWith(publicRoot + '/')) fail(403, 'Akses ditolak.');
    if (!existsSync(file)) fail(404, 'Halaman tidak ditemukan.');
    const data = readFileSync(file);
    res.writeHead(200, {
      'Content-Type': mime[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (e) {
    send(res, e.status || 500, { error: e.status ? e.message : 'Terjadi kesalahan server.' });
    if (!e.status) console.error(e);
  }
});

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`🔒 LockIn berjalan di http://${HOST}:${server.address().port} (sandbox)`);
  console.log(`   Database:   ${isSupabaseConfigured() ? '✅ Supabase (Cloud)' : '⚠️  Lokal Demo'}`);
  console.log(`   Midtrans:   ${isMidtransConfigured() ? '✅ aktif (Sandbox)' : '⚠️  mode simulasi'}`);
  console.log(`   Blockchain: ${isBlockchainConfigured() ? '✅ aktif (Sepolia)' : '⚠️  tidak dikonfigurasi'}`);
});

// Blockchain worker: setiap 15 detik
setInterval(() => { syncBlockchainJobs().catch(err => console.error('[Blockchain worker]', err.message)); }, 15000).unref();
