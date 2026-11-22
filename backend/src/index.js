// LockIn — Backend Entry Point
// Node.js HTTP server + REST API + static file server
import 'dotenv/config';
import http from 'node:http';
import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { hasCompleteSimulatedFunds } from './utils/simulated-release.js';
import { buildBookingBlockchainEvidence, unavailableBookingBlockchainEvidence } from './utils/booking-blockchain-evidence.js';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { supabase, isSupabaseConfigured, createUserAuthClient } from './db/supabase.js';
import { DEMO_VENDORS, DEMO_VENDOR_OWNER_ID } from './db/seed.js';
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
  'user@lockin.demo':   { id: 'd32824cc-da8b-4ed5-b8aa-af8a62daac53', name: 'Pelanggan Demo', email: 'user@lockin.demo', role: 'customer' },
  'vendor@lockin.demo': { id: 'd9d01426-73a7-43e6-86fe-d296b200d0b1', name: 'Vendor Demo', email: 'vendor@lockin.demo', role: 'vendor' },
  'vendor2@lockin.demo': { id: 'd9d01426-73a7-43e6-86fe-d296b200d0b2', name: 'Vendor Lain', email: 'vendor2@lockin.demo', role: 'vendor' },
  'admin@lockin.demo':  { id: 'a3769509-249b-4cb9-8aff-12d1dd5b65d9', name: 'Admin Demo', email: 'admin@lockin.demo', role: 'admin' }
};
const localPasswords = new Map(); // Hanya untuk akun lokal yang didaftarkan di mode demo.
function storeLocalPassword(email, password) {
  const salt = randomBytes(16).toString('hex');
  localPasswords.set(email, { salt, hash: scryptSync(password, salt, 64) });
}
function verifyLocalPassword(email, password) {
  if (demoAccounts[email] && ['user@lockin.demo', 'vendor@lockin.demo', 'vendor2@lockin.demo', 'admin@lockin.demo'].includes(email))
    return password === 'LockInDemo123!';
  const saved = localPasswords.get(email);
  if (!saved) return false;
  const result = scryptSync(password, saved.salt, saved.hash.length);
  return timingSafeEqual(saved.hash, result);
}
const localSessions = new Map();
const localBookings = new Map();
const ADMIN_ACTIVE_BOOKING_STATES = ['Pending', 'WaitingVendorApproval', 'DPPaid', 'Paid', 'Disputed'];
const VENDOR_APPLICATION_CITIES = ['Malang', 'Surabaya', 'Yogyakarta', 'Semarang', 'Solo', 'Bandung', 'Bogor'];
const VENDOR_APPLICATION_CATEGORY_MAP = {
  'PA Wisuda': 'PA Wisuda',
  'Graduation Content Creator': 'GCC',
  'Hijab & Hair Stylist': 'Hijab & Hair Stylist',
  'MUA': 'MUA',
  'Acrylic Standing Sign': 'Standing Sign',
  'GCC': 'GCC',
  'Standing Sign': 'Standing Sign'
};
const localPayments = new Map();
const localLedgerEntries = [];
const localDisputes = new Map();
const localEvidence = new Map();
const localReports  = [];
const localAudit    = [];
const localReviews  = [
  { id: 'rev-1', vendor_name: 'Hijab Do Malang', client_name: 'Rani K.', rating: 5, comment: 'Puas banget! Datang tepat waktu, hijab stylist rapi dan tahan seharian pas wisuda.', date: '15 Nov 2026' },
  { id: 'rev-2', vendor_name: 'Glow Studio PA', client_name: 'Dinda P.', rating: 5, comment: 'PA-nya super helpful, nemenin dari pagi sampai foto toga beres.', date: '12 Nov 2026' },
  { id: 'rev-3', vendor_name: 'Lolita Makeup', client_name: 'Sarah M.', rating: 5, comment: 'Makeup flawless dan gak cakey sama sekali. Recommended wisudawan UB!', date: '10 Nov 2026' }
];
const localVendorApplications = [];
const localVendorApplicationVendorIds = new Map();
const otpAttempts = new Map();

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

// Auto-release ditangguhkan sampai worker persisten memakai transaksi release yang sama.
function checkAutoRelease() {
  return;
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const now  = () => new Date().toISOString();
function paymentStatus(b) {
  if (b.state === 'Cancelled') return 'CANCELLED';
  if (b.state === 'Refunded') return 'REFUNDED';
  const total = Math.max(0, Number(b.price) || 0) + Math.max(0, Number(b.deposit) || 0);
  const paid = Math.max(0, Number(b.paid) || 0);
  if (paid > 0 && paid >= total) return 'PAID';
  return paid > 0 ? 'DP_PAID' : 'UNPAID';
}
function executionStatus(b) {
  if (['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'].includes(b.execution_state)) return b.execution_state;
  if (b.state === 'Completed') return 'COMPLETED';
  return b.vendor_arrived ? 'IN_PROGRESS' : 'NOT_STARTED';
}
function withBookingStatuses(b) {
  return { ...b, paymentStatus: paymentStatus(b), executionStatus: executionStatus(b) };
}
async function getSuccessfulPaymentBreakdown(bookingId) {
  let rows;
  if (supabase) {
    const { data, error } = await supabase.from('payments').select('payment_type,amount').eq('booking_id', bookingId).eq('outcome', 'success');
    if (error) {
      console.error('[Supabase booking payments]', { code: error.code, message: error.message });
      fail(503, 'Rincian pembayaran booking gagal dimuat dari database.');
    }
    rows = data || [];
  } else {
    rows = Array.from(localPayments.values()).filter(p => p.booking_id === bookingId && p.outcome === 'success');
  }
  return rows.reduce((totals, row) => {
    const amount = Number(row.amount) || 0;
    if (row.payment_type === 'DP') totals.dpAmount += amount;
    if (row.payment_type === 'FINAL') totals.finalAmount += amount;
    return totals;
  }, { dpAmount: 0, finalAmount: 0 });
}
async function getBookingBlockchainEvidence(bookingId) {
  if (!supabase) return buildBookingBlockchainEvidence([], []);
  try {
    const [paymentsResult, jobsResult] = await Promise.all([
      supabase.from('payments').select('id,payment_type,outcome,created_at').eq('booking_id', bookingId).eq('outcome', 'success'),
      supabase.from('blockchain_jobs').select('payment_id,status,tx_hash').eq('booking_id', bookingId)
    ]);
    if (paymentsResult.error || jobsResult.error) {
      console.error('[Booking blockchain evidence]', {
        paymentCode: paymentsResult.error?.code || null,
        jobCode: jobsResult.error?.code || null
      });
      return unavailableBookingBlockchainEvidence();
    }
    return buildBookingBlockchainEvidence(paymentsResult.data || [], jobsResult.data || []);
  } catch (error) {
    console.error('[Booking blockchain evidence] Query failed.', error?.code || 'unknown');
    return unavailableBookingBlockchainEvidence();
  }
}
async function getReleaseStatus(booking) {
  let ledgerRows = [], activeDispute = Boolean(localDisputes.get(booking.id) && !localDisputes.get(booking.id).decision);
  if (supabase) {
    const [{ data: entries, error: ledgerError }, { data: dispute, error: disputeError }] = await Promise.all([
      supabase.from('ledger_entries').select('entry_type,amount,created_at').eq('booking_id', booking.id).in('entry_type', ['SIMULATED_HELD', 'SIMULATED_RELEASE']),
      supabase.from('disputes').select('id,decision').eq('booking_id', booking.id).maybeSingle()
    ]);
    if (ledgerError) {
      console.error('[Supabase release ledger]', { code: ledgerError.code, message: ledgerError.message });
      fail(503, 'Status pencairan gagal dimuat dari database.');
    }
    if (disputeError) {
      console.error('[Supabase release dispute]', { code: disputeError.code, message: disputeError.message });
      fail(503, 'Status sengketa untuk pencairan gagal diverifikasi.');
    }
    ledgerRows = entries || [];
    activeDispute = activeDispute || Boolean(dispute && !dispute.decision);
  } else {
    ledgerRows = localLedgerEntries.filter(entry => entry.booking_id === booking.id);
  }
  const releaseEntry = ledgerRows.find(entry => entry.entry_type === 'SIMULATED_RELEASE');
  const heldAmount = ledgerRows.filter(entry => entry.entry_type === 'SIMULATED_HELD')
    .reduce((total, entry) => total + (Number(entry.amount) || 0), 0);
  const serviceHeldAmount = Math.min(
    Math.max(0, Number(booking.price) || 0),
    Math.max(0, heldAmount - Math.max(0, Number(booking.deposit) || 0))
  );
  if (releaseEntry) {
    return { simulated: true, status: 'RELEASED', amount: Number(releaseEntry.amount) || 0, releasedAt: releaseEntry.created_at || null };
  }
  const onHold = activeDispute || ['Disputed', 'Cancelled', 'Refunded', 'Resolved', 'Completed'].includes(booking.state);
  return { simulated: true, status: onHold ? 'ON_HOLD' : 'HELD', amount: serviceHeldAmount, releasedAt: null };
}
function verifiedSimulatedEscrowTotal(bookings, payments, ledgerRows) {
  if (!Array.isArray(bookings) || !Array.isArray(payments) || !Array.isArray(ledgerRows)) return null;
  const bookingById = new Map(bookings.map(booking => [booking.id, booking]));
  const successfulPayments = payments.filter(payment => payment.outcome === 'success');
  const successfulById = new Map(successfulPayments.map(payment => [payment.id, payment]));
  const heldByBooking = new Map(), releaseByBooking = new Map(), paymentsByBooking = new Map(), heldPaymentIds = new Set();
  for (const payment of successfulPayments) {
    if (!payment.id || !bookingById.has(payment.booking_id) || !Number.isSafeInteger(Number(payment.amount)) || Number(payment.amount) <= 0) return null;
    const rows = paymentsByBooking.get(payment.booking_id) || [];
    rows.push(payment);
    paymentsByBooking.set(payment.booking_id, rows);
  }
  for (const entry of ledgerRows) {
    if (!bookingById.has(entry.booking_id) || !Number.isSafeInteger(Number(entry.amount)) || Number(entry.amount) <= 0) return null;
    if (entry.entry_type === 'SIMULATED_HELD') {
      const payment = successfulById.get(entry.payment_id);
      if (!payment || heldPaymentIds.has(entry.payment_id) || Number(payment.amount) !== Number(entry.amount)) return null;
      heldPaymentIds.add(entry.payment_id);
      const rows = heldByBooking.get(entry.booking_id) || [];
      rows.push(entry);
      heldByBooking.set(entry.booking_id, rows);
    } else if (entry.entry_type === 'SIMULATED_RELEASE') {
      if (entry.payment_id != null) return null;
      const rows = releaseByBooking.get(entry.booking_id) || [];
      rows.push(entry);
      releaseByBooking.set(entry.booking_id, rows);
    } else return null;
  }
  let total = 0;
  for (const booking of bookings) {
    const successful = paymentsByBooking.get(booking.id) || [];
    const held = heldByBooking.get(booking.id) || [];
    const releases = releaseByBooking.get(booking.id) || [];
    const paid = Number(booking.paid) || 0;
    const successfulTotal = successful.reduce((sum, payment) => sum + Number(payment.amount), 0);
    if (!Number.isSafeInteger(successfulTotal) || paid !== successfulTotal || held.length !== successful.length) return null;
    if (!successful.length && (held.length || releases.length)) return null;
    if (releases.length > 1) return null;
    if (!successful.length) continue;
    const price = Number(booking.price), deposit = Number(booking.deposit) || 0;
    const heldTotal = held.reduce((sum, entry) => sum + Number(entry.amount), 0);
    if (!Number.isSafeInteger(price) || price <= 0 || !Number.isSafeInteger(deposit) || deposit < 0 || heldTotal !== successfulTotal) return null;
    if (releases.length) {
      if (Number(releases[0].amount) !== price) return null;
      continue;
    }
    total += Math.min(price, Math.max(0, heldTotal - deposit));
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}
function vendorPackages(v) {
  const base = Math.max(0, Number(v.price) || 0);
  const basic = { id: '1', name: 'Paket Hemat / Basic', desc: 'Layanan esensial standar untuk wisudawan mandiri.', price: base, durasi: '1 Sesi (~2 jam)', revisi: '1x revisi' };
  if (v.category === 'Standing Sign') return [basic];
  return [
    basic,
    { id: '2', name: 'Paket Lengkap / Standard (Favorit)', desc: 'Layanan komplit: styling inti + bonus touchup saat prosesi.', price: Math.round(base * 1.25 / 1000) * 1000, durasi: '3-4 Jam', revisi: '2x revisi' },
    { id: '3', name: 'Paket Premium / Exclusive', desc: 'Standby seharian penuh + prioritas hasil cepat + bundling aksesoris.', price: Math.round(base * 1.5 / 1000) * 1000, durasi: 'Full Day', revisi: 'Revisi bebas' }
  ];
}
function approvedVendorDetails(application) {
  validateText(application?.name, 'Nama Usaha', 120);
  validateText(application?.owner_name, 'Nama Pemilik', 80);
  const email = validateText(application?.email, 'Email', 160);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Email pengajuan tidak valid.');
  validateText(application?.whatsapp, 'WhatsApp', 40);
  const category = VENDOR_APPLICATION_CATEGORY_MAP[application?.category];
  if (!category) fail(400, 'Kategori pengajuan tidak didukung katalog LockIn.');
  const city = validateText(application?.city, 'Kota layanan', 60);
  if (!VENDOR_APPLICATION_CITIES.includes(city)) fail(400, 'Kota layanan pengajuan tidak didukung.');
  const basePrice = Number(application?.base_price);
  if (!Number.isSafeInteger(basePrice) || basePrice <= 0 || basePrice > 2147483647)
    fail(400, 'Harga dasar harus berupa Rupiah bulat positif agar sesuai dengan kolom katalog.');
  const packages = vendorPackages({ category, price: basePrice });
  const priceMax = Math.max(...packages.map(pkg => pkg.price));
  if (!Number.isSafeInteger(priceMax) || priceMax <= 0 || priceMax > 2147483647)
    fail(400, 'Harga paket tertinggi melebihi batas kolom katalog.');
  return {
    category, city, price: basePrice, priceMax,
    instagram: optionalText(application.instagram, 'Instagram', 200),
    whatsapp: application.whatsapp.trim(),
    description: optionalText(application.description, 'Deskripsi', 2000),
    color: ({ MUA: 'gold', 'Hijab & Hair Stylist': 'green', GCC: 'blue', 'PA Wisuda': 'pink', 'Standing Sign': 'purple' })[category]
  };
}
function withVendorPackages(v) {
  return { ...v, packages: vendorPackages(v) };
}
const localToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
const digest = text => '0x' + createHash('sha256').update(text).digest('hex');
const send = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
};

// ─── Session helper: server-side session + database-backed role ─────────────
function sessionToken(req) {
  return /(?:^|;\s*)lockin_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
}

function sessionCookie(req, token, maxAge = 86400) {
  return `lockin_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${req.socket.encrypted ? '; Secure' : ''}`;
}

async function userOf(req) {
  const token = sessionToken(req);
  if (!token) return null;
  if (!supabase) {
    const local = localSessions.get(token);
    return local && local.expires > Date.now() ? local.user : null;
  }
  // Jangan pernah percaya sesi atau role yang disimpan frontend.
  const { data, error } = await supabase.from('sessions')
    .select('expires, users(id, name, email, role)')
    .eq('token', token).gt('expires', Date.now()).maybeSingle();
  if (error) {
    console.error('[Auth] Gagal membaca sesi:', error.code, error.message);
    return null;
  }
  return data?.users || null;
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
function optionalText(value, label, max = 500) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > max) fail(400, `${label} tidak valid.`);
  return value.trim();
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname;
  } catch { return false; }
}

function bookingCancellationEstimate(b) {
  const estimate = calculateRefund({
    eventDate: b.event_date,
    totalPaid: b.paid || 0,
    price: b.price
  });
  // Preserve the existing rental-deposit handling used by the cancel action.
  const refundAmount = estimate.refundAmount + (b.deposit && b.paid ? b.deposit : 0);
  return {
    ...estimate,
    refundAmount,
    notRefundedAmount: Math.max(0, (b.paid || 0) - refundAmount)
  };
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
    const { data, error } = await supabase
      .from('bookings')
      .select('*, vendors(name, category, owner_id)')
      .eq('id', id)
      .maybeSingle();
    if (error) fail(503, 'Gagal membaca booking dari database. Coba lagi.');
    if (data) b = { ...data, vendor_name: data.vendor_name || data.vendors?.name, category: data.category || data.vendors?.category, owner_id: data.owner_id || data.vendors?.owner_id };
  } else {
    b = localBookings.get(id);
  }
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
  if (path === '/api/auth/me' && method === 'GET')
    return send(res, 200, { user: user || null });

  if (path === '/api/auth/logout' && method === 'POST') {
    const token = sessionToken(req);
    if (token) {
      if (supabase) {
        const { error } = await supabase.from('sessions').delete().eq('token', token);
        if (error) fail(503, 'Gagal mengakhiri sesi. Coba lagi.');
      } else localSessions.delete(token);
    }
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  if (['/api/auth/login', '/api/auth/register'].includes(path) && method === 'POST') {
    const d = await body(req);
    const email = validateText(d.email, 'Email', 160).toLowerCase();
    const password = validateText(d.password, 'Password', 128);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Format email tidak valid.');

    if (path.endsWith('register')) {
      const name = validateText(d.name, 'Nama', 80);
      if (password.length < 10) fail(400, 'Password minimal 10 karakter.');
      if (supabase) {
        let authClient;
        try { authClient = createUserAuthClient(); }
        catch { fail(503, 'Konfigurasi autentikasi Supabase belum lengkap.'); }
        const { data: registered, error } = await authClient.auth.signUp({
          email, password, options: { data: { name } }
        });
        if (error) fail(error.status || 400, error.message);
        if (!registered?.user?.id) fail(503, 'Pendaftaran belum berhasil. Coba lagi.');
        // Semua pendaftaran mandiri hanya bisa menjadi customer.
        const { error: profileError } = await supabase.from('users').insert({
          id: registered.user.id, name, email, role: 'customer'
        });
        if (profileError) {
          console.error('[Auth] Gagal menyimpan profil pelanggan:', profileError.code, profileError.message);
          fail(503, 'Akun Auth dibuat tetapi profil belum tersimpan. Hubungi admin.');
        }
        return send(res, 201, {
          ok: true, requiresEmailConfirmation: !registered.session,
          message: registered.session ? 'Akun dibuat. Silakan login.' : 'Akun dibuat. Periksa email untuk verifikasi, kemudian login.'
        });
      }
      // Mode lokal hanya aktif ketika Supabase tidak dikonfigurasi.
      if (demoAccounts[email]) fail(409, 'Email sudah terdaftar.');
      const newAcc = { id: randomBytes(16).toString('hex'), name, email, role: 'customer' };
      demoAccounts[email] = newAcc;
      storeLocalPassword(email, password);
      return send(res, 201, { ok: true, message: 'Akun dibuat. Silakan login.' });
    }

    let profile;
    if (supabase) {
      let authClient;
      try { authClient = createUserAuthClient(); }
      catch { fail(503, 'Konfigurasi autentikasi Supabase belum lengkap.'); }
      const { data: authData, error: loginError } = await authClient.auth.signInWithPassword({ email, password });
      if (loginError || !authData?.user) fail(401, 'Email atau password salah, atau email belum diverifikasi.');
      const { data: storedProfile, error: profileError } = await supabase.from('users')
        .select('id, name, email, role').eq('id', authData.user.id).maybeSingle();
      if (profileError) fail(503, 'Profil pengguna tidak dapat dibaca dari database.');
      if (!storedProfile) fail(403, 'Profil akun belum terdaftar di public.users. Minta admin menyinkronkan akun.');
      profile = storedProfile; // Role HANYA bersumber dari tabel terkelola server.
    } else {
      profile = demoAccounts[email];
      if (!profile || !verifyLocalPassword(email, password)) fail(401, 'Email atau password salah.');
    }

    const token = randomBytes(32).toString('hex');
    const expires = Date.now() + 86400000;
    if (supabase) {
      const { error } = await supabase.from('sessions').insert({ token, user_id: profile.id, expires });
      if (error) {
        console.error('[Auth] Gagal menyimpan sesi:', error.code, error.message);
        fail(503, 'Login terverifikasi tetapi sesi gagal dibuat. Hubungi admin.');
      }
    } else localSessions.set(token, { user: profile, expires });
    return send(res, 200, { user: profile }, { 'Set-Cookie': sessionCookie(req, token) });
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
      let q = supabase.from('vendors').select('id,name,category,city,instagram,whatsapp,price,price_max,price_type,deposit,rating,completed,verified,color,description,owner_id').order('created_at', { ascending: true });
      const category = url.searchParams.get('category');
      if (category && category !== 'Semua') q = q.eq('category', category);
      const { data: rows, error } = await q;
      if (error) {
        console.error('[Supabase vendors]', { code: error.code, message: error.message, hint: error.hint });
        fail(503, 'Gagal memuat vendor dari database. Coba lagi.');
      }
      result = (rows || []).map(withVendorPackages);
    }

    // Fallback otomatis ke vendor demo lokal jika tabel Supabase belum diisi
    if (!supabase) {
      result = DEMO_VENDORS.map(v => withVendorPackages({ ...v, owner_id: v.owner_id || DEMO_VENDOR_OWNER_ID }));
      const category = url.searchParams.get('category');
      if (category && category !== 'Semua') result = result.filter(v => v.category === category);
    }

    const city = url.searchParams.get('city');
    if (city) result = result.filter(v => String(v.city || '').toLowerCase() === city.toLowerCase());
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
      const { data, error } = await supabase.from('vendors').select('*').eq('id', id).maybeSingle();
      if (error) fail(503, 'Detail vendor gagal dimuat dari database.');
      if (data) {
        const { source_application_id: _sourceApplicationId, ...publicVendor } = data;
        v = publicVendor;
      }
    } else {
      v = DEMO_VENDORS.find(item => String(item.id) === String(id));
    }
    if (!v) fail(404, 'Vendor tidak ditemukan.');
    const reserved = [];
    for (const b of localBookings.values()) {
      if (String(b.vendor_id) === String(v.id) && !['Expired', 'Cancelled', 'Refunded'].includes(b.state)) {
        reserved.push(b.event_date);
      }
    }
    return send(res, 200, { ...withVendorPackages(v), reserved });
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
    const email = validateText(d.email, 'Email', 160).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Format email tidak valid.');
    const city = validateText(d.city, 'Kota layanan', 60);
    if (!VENDOR_APPLICATION_CITIES.includes(city)) fail(400, 'Pilih kota layanan yang tersedia.');
    const rawBasePrice = d.basePrice != null ? d.basePrice : d.base_price;
    const basePriceText = typeof rawBasePrice === 'number' && Number.isFinite(rawBasePrice) ? String(rawBasePrice)
      : typeof rawBasePrice === 'string' ? rawBasePrice.trim() : '';
    const basePrice = /^\d+(?:\.\d{1,2})?$/.test(basePriceText) ? Number(basePriceText) : NaN;
    if (!Number.isFinite(basePrice) || basePrice <= 0 || basePrice > 9999999999.99) fail(400, 'Harga dasar harus lebih dari Rp0, maksimal Rp9.999.999.999,99, dan paling banyak dua angka desimal.');
    const whatsapp = validateText(d.whatsapp, 'WhatsApp', 40);
    if (!/^\+?[\d\s().-]{9,25}$/.test(whatsapp)) fail(400, 'Format nomor WhatsApp tidak valid.');
    const instagram = optionalText(d.instagram, 'Instagram', 200);
    if (instagram && !/^@[\w.]{1,30}$/.test(instagram) && !isHttpUrl(instagram)) fail(400, 'Format Instagram harus berupa @username atau URL HTTP/HTTPS.');
    const portfolioUrl = optionalText(d.portfolioUrl, 'URL portofolio', 500);
    if (portfolioUrl && !isHttpUrl(portfolioUrl)) fail(400, 'URL portofolio harus menggunakan HTTP atau HTTPS yang valid.');
    const appData = {
      id: 'VAPP-' + randomBytes(4).toString('hex').toUpperCase(),
      name: validateText(d.brandName || d.name, 'Nama Usaha', 120),
      owner_name: validateText(d.ownerName, 'Nama Pemilik', 80),
      email,
      whatsapp,
      category: validateText(d.category, 'Kategori Jasa', 60),
      city,
      base_price: basePrice,
      instagram,
      portfolio_url: portfolioUrl,
      description: optionalText(d.description, 'Deskripsi', 2000),
      price_range: 'Mulai Rp' + basePrice.toLocaleString('id-ID', { minimumFractionDigits: Number.isInteger(basePrice) ? 0 : 2, maximumFractionDigits: 2 }),
      status: 'pending_approval',
      created_at: now()
    };
    if (supabase) {
      const { error } = await supabase.from('vendor_applications').insert(appData);
      if (error) {
        console.error('[Vendor Applications] Gagal menyimpan pengajuan:', error.code, error.message);
        fail(503, 'Pengajuan belum tersimpan. Silakan coba lagi nanti.');
      }
    } else {
      localVendorApplications.push(appData);
    }
    return send(res, 201, {
      ok: true,
      message: 'Pengajuan jasa berhasil tersimpan dan menunggu persetujuan tim LockIn. Pengajuan ini belum membuat akun login.',
      application: appData
    });
  }

  // ── Reviews & Ratings (public GET, user POST) ──
  if (path === '/api/reviews' && method === 'GET') {
    return send(res, 200, localReviews);
  }
  if (path === '/api/reviews' && method === 'POST') {
    if (!user) fail(401, 'Silakan login untuk memberi ulasan.');
    if (user.role !== 'customer') fail(403, 'Hanya pelanggan yang dapat mengirim ulasan.');
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

  if (path === '/api/admin/summary' && method === 'GET') {
    if (user.role !== 'admin') fail(403, 'Hanya admin yang dapat melihat ringkasan ini.');
    let totalBookings, activeBookings, openDisputes;
    if (supabase) {
      let results;
      try {
        results = await Promise.all([
          supabase.from('bookings').select('id', { count: 'exact', head: true }),
          supabase.from('bookings').select('id', { count: 'exact', head: true }).in('state', ADMIN_ACTIVE_BOOKING_STATES),
          supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('state', 'Disputed')
        ]);
      } catch (error) {
        console.error('[Admin summary] Gagal membaca statistik booking:', error.message);
        fail(503, 'Ringkasan admin gagal dimuat dari database. Coba lagi.');
      }
      const queryError = results.find(result => result.error || !Number.isInteger(result.count));
      if (queryError) {
        console.error('[Admin summary] Query statistik booking gagal:', queryError.error?.message || 'Count tidak tersedia.');
        fail(503, 'Ringkasan admin gagal dimuat dari database. Coba lagi.');
      }
      [totalBookings, activeBookings, openDisputes] = results.map(result => result.count);
    } else {
      const bookings = Array.from(localBookings.values());
      totalBookings = bookings.length;
      activeBookings = bookings.filter(booking => ADMIN_ACTIVE_BOOKING_STATES.includes(booking.state)).length;
      openDisputes = bookings.filter(booking => booking.state === 'Disputed').length;
    }
    let simulatedEscrowFunds = { available: false, label: 'Belum tersedia' };
    try {
      let bookings, successfulPayments, ledgerRows;
      if (supabase) {
        const results = await Promise.all([
          supabase.from('bookings').select('id,price,deposit,paid'),
          supabase.from('payments').select('id,booking_id,amount,outcome').eq('outcome', 'success'),
          supabase.from('ledger_entries').select('booking_id,payment_id,entry_type,amount').in('entry_type', ['SIMULATED_HELD', 'SIMULATED_RELEASE'])
        ]);
        const queryError = results.find(result => result.error || !Array.isArray(result.data));
        if (queryError) throw queryError.error || new Error('Ledger escrow tidak tersedia.');
        [bookings, successfulPayments, ledgerRows] = results.map(result => result.data);
      } else {
        bookings = Array.from(localBookings.values());
        successfulPayments = Array.from(localPayments.values()).filter(payment => payment.outcome === 'success');
        ledgerRows = localLedgerEntries.filter(entry => ['SIMULATED_HELD', 'SIMULATED_RELEASE'].includes(entry.entry_type));
      }
      const amount = verifiedSimulatedEscrowTotal(bookings, successfulPayments, ledgerRows);
      if (amount !== null) simulatedEscrowFunds = { available: true, amount };
      else console.error('[Admin summary] Ledger escrow tidak lengkap atau tidak konsisten; total tidak ditampilkan.');
    } catch (error) {
      console.error('[Admin summary] Gagal memverifikasi ledger escrow:', error.message);
    }
    return send(res, 200, {
      totalBookings,
      activeBookings,
      activeBookingStates: ADMIN_ACTIVE_BOOKING_STATES,
      openDisputes,
      simulatedEscrowFunds
    });
  }

  if (path === '/api/admin/vendor-applications' && method === 'GET') {
    if (user.role !== 'admin') fail(403, 'Hanya admin yang dapat melihat pengajuan vendor jasa.');
    let applications;
    if (supabase) {
      const { data, error } = await supabase.from('vendor_applications').select('*').order('created_at', { ascending: false });
      if (error) {
        console.error('[Admin vendor applications] Gagal memuat pengajuan:', error.code, error.message);
        fail(503, 'Daftar pengajuan vendor gagal dimuat dari database. Coba lagi.');
      }
      applications = data || [];
    } else {
      applications = [...localVendorApplications].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }
    return send(res, 200, applications);
  }

  const applicationDecisionMatch = /^\/api\/admin\/vendor-applications\/([^/]+)\/status$/.exec(path);
  if (applicationDecisionMatch && method === 'PATCH') {
    if (user.role !== 'admin') fail(403, 'Hanya admin yang dapat memproses pengajuan vendor jasa.');
    const applicationId = applicationDecisionMatch[1];
    if (!/^VAPP-[A-F0-9]{8}$/i.test(applicationId)) fail(400, 'ID pengajuan tidak valid.');
    const d = await body(req);
    if (!['approved', 'rejected'].includes(d.status)) fail(400, 'Status harus approved atau rejected.');

    if (supabase) {
      let expectedBasePrice = null, expectedCategory = null, priceMax = null;
      if (d.status === 'approved') {
        const { data: application, error } = await supabase.from('vendor_applications').select('*').eq('id', applicationId).maybeSingle();
        if (error) {
          console.error('[Admin vendor application] Gagal membaca pengajuan:', error.code, error.message);
          fail(503, 'Pengajuan gagal dibaca dari database. Coba lagi.');
        }
        if (!application) fail(404, 'Pengajuan vendor tidak ditemukan.');
        if (application.status !== 'pending_approval') fail(409, 'Pengajuan ini sudah pernah diproses.');
        const details = approvedVendorDetails(application);
        expectedBasePrice = Number(application.base_price);
        expectedCategory = application.category;
        priceMax = details.priceMax;
      }

      const { data, error } = await supabase.rpc('process_vendor_application_decision', {
        p_application_id: applicationId,
        p_status: d.status,
        p_expected_base_price: expectedBasePrice,
        p_expected_category: expectedCategory,
        p_price_max: priceMax
      });
      if (error) {
        console.error('[Admin vendor application] Transaksi keputusan gagal:', error.code, error.message);
        if (error.code === 'P0002') fail(404, 'Pengajuan vendor tidak ditemukan.');
        if (error.code === 'P0001' || error.code === '23505') fail(409, 'Pengajuan sudah diproses atau sudah tertaut ke katalog. Muat ulang daftar.');
        if (error.code === '22023' || error.code === '23514') fail(400, 'Data pengajuan tidak memenuhi syarat katalog. Periksa kota, kategori, dan harga dasar.');
        fail(503, 'Keputusan pengajuan gagal disimpan. Pengajuan tetap menunggu dan katalog tidak berubah.');
      }
      if (!data?.ok || data.application?.status !== d.status || (d.status === 'approved' && !data.vendor?.id))
        fail(503, 'Database tidak mengonfirmasi seluruh perubahan pengajuan dan katalog.');
      return send(res, 200, data);
    }

    const application = localVendorApplications.find(item => item.id === applicationId);
    if (!application) fail(404, 'Pengajuan vendor tidak ditemukan.');
    if (application.status !== 'pending_approval') fail(409, 'Pengajuan ini sudah pernah diproses.');
    if (d.status === 'rejected') {
      application.status = 'rejected';
      return send(res, 200, { ok: true, application, vendor: null });
    }

    const details = approvedVendorDetails(application);
    if (localVendorApplicationVendorIds.has(applicationId)) fail(409, 'Pengajuan sudah tertaut ke katalog.');
    const vendor = {
      id: randomUUID(), owner_id: DEMO_VENDOR_OWNER_ID, name: application.name,
      category: details.category, city: details.city, instagram: details.instagram || null,
      whatsapp: details.whatsapp, price: details.price, price_max: details.priceMax,
      price_type: 'listed', deposit: 0, rating: 0, completed: 0, verified: true,
      color: details.color, description: details.description || null
    };
    DEMO_VENDORS.push(vendor);
    localVendorApplicationVendorIds.set(applicationId, vendor.id);
    application.status = 'approved';
    return send(res, 200, { ok: true, application, vendor });
  }

  // ── Bookings list ──
  if (path === '/api/bookings' && method === 'GET') {
    checkAutoRelease();
    let rows;
    if (supabase) {
      const bookingSelect = user.role === 'vendor'
        ? '*, vendors(name, category, owner_id), users(name)'
        : '*, vendors(name, category, owner_id)';
      const { data, error } = await supabase.from('bookings').select(bookingSelect).order('created_at', { ascending: false });
      if (error) {
        console.error('[Supabase bookings]', { code: error.code, message: error.message, hint: error.hint });
        fail(503, 'Gagal memuat booking dari database. Coba muat ulang.');
      }
      rows = data || [];
    } else rows = Array.from(localBookings.values());
    let filtered = rows.filter(b =>
      user.role === 'admin' || b.user_id === user.id ||
      (user.role === 'vendor' && (b.owner_id === user.id || b.vendors?.owner_id === user.id))
    ).map(b => {
      const localCustomer = Object.values(demoAccounts).find(account => account.id === b.user_id);
      const { users, ...booking } = b;
      const customer = user.role === 'vendor' ? { customer_name: b.users?.name || localCustomer?.name || null } : {};
      const resBooking = withBookingStatuses({ ...booking, vendor_name: b.vendor_name || b.vendors?.name, category: b.category || b.vendors?.category, ...customer });
      if (user.role === 'vendor') {
        delete resBooking.arrival_code;
      }
      return resBooking;
    });
    if (user.role === 'vendor') {
      filtered = await Promise.all(filtered.map(async booking => {
        try {
          return { ...booking, paymentBreakdown: await getSuccessfulPaymentBreakdown(booking.id), paymentBreakdownVerified: true };
        } catch {
          return { ...booking, paymentBreakdown: null, paymentBreakdownVerified: false };
        }
      }));
    }
    filtered = await Promise.all(filtered.map(async booking => ({ ...booking, release: await getReleaseStatus(booking) })));
    return send(res, 200, filtered);
  }

  // ── Create booking ──
  if (path === '/api/bookings' && method === 'POST') {
    if (user.role !== 'customer') fail(403, 'Gunakan akun pelanggan untuk membuat booking.');
    const d = await body(req);
    let v = null;
    if (supabase) {
      const { data, error } = await supabase.from('vendors').select('*').eq('id', d.vendorId).maybeSingle();
      if (error) fail(400, 'Vendor tidak dapat dibaca dari database. Muat ulang daftar vendor.');
      v = data;
    } else v = DEMO_VENDORS.find(item => String(item.id) === String(d.vendorId));
    if (!v) fail(404, 'Vendor tidak ditemukan.');
    if (!d.agreed) fail(400, 'Setujui perjanjian terlebih dahulu.');
    const selectedPackage = vendorPackages(v).find(item => item.id === String(d.packageId));
    if (!selectedPackage) fail(400, 'Paket vendor tidak valid. Pilih paket yang tersedia lalu coba lagi.');
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
      ? Math.round(selectedPackage.price * (schedule.upfrontPercent / 100))
      : (v.deposit ? selectedPackage.price + v.deposit : Math.round(selectedPackage.price * (schedule.upfrontPercent / 100)));
    const finalAmount = Math.max(0, selectedPackage.price - upfrontAmount);

    const agreement = JSON.stringify({
      vendorId: v.id,
      vendorName: v.name,
      category: v.category,
      date,
      location,
      startTime: start,
      price: selectedPackage.price,
      deposit: v.deposit,
      packageId: selectedPackage.id,
      packageName: selectedPackage.name,
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
      owner_id: v.owner_id || DEMO_VENDOR_OWNER_ID,
      event_date: date,
      location,
      start_time: start,
      price: selectedPackage.price,
      deposit: v.deposit,
      package_id: selectedPackage.id,
      package_name: selectedPackage.name,
      paid: 0,
      late_booking: late,
      execution_state: 'NOT_STARTED',
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
    if (supabase) {
      const { error: bookingError } = await supabase.from('bookings').insert({
        id: bookingData.id,
        user_id: bookingData.user_id,
        vendor_id: bookingData.vendor_id,
        event_date: bookingData.event_date,
        location: bookingData.location,
        start_time: bookingData.start_time,
        price: bookingData.price,
        deposit: bookingData.deposit,
        package_id: bookingData.package_id,
        package_name: bookingData.package_name,
        paid: bookingData.paid,
        state: bookingData.state,
        execution_state: bookingData.execution_state,
        late_booking: bookingData.late_booking,
        vendor_accepted_at: bookingData.vendor_accepted_at,
        arrival_code: bookingData.arrival_code,
        vendor_arrived: bookingData.vendor_arrived,
        off_platform_warning: bookingData.off_platform_warning,
        agreement: bookingData.agreement,
        hash: bookingData.hash,
        expires: bookingData.expires,
        created_at: bookingData.created_at
      });
      if (bookingError) {
        console.error('[Supabase booking INSERT]', {
          code: bookingError.code,
          message: bookingError.message,
          details: bookingError.details,
          hint: bookingError.hint
        });
        fail(503, 'Booking gagal disimpan ke database. Periksa data vendor dan coba lagi.');
      }
      const { error: auditError } = await supabase.from('audit').insert({ booking_id: id, state: 'AgreementLocked', created_at: bookingData.created_at });
      if (auditError) {
        const { error: rollbackError } = await supabase.from('bookings').delete().eq('id', id);
        if (rollbackError) console.error('[Booking rollback]', rollbackError.message);
        fail(503, 'Booking tidak dapat disimpan karena pencatatan audit gagal.');
      }
    }

    localBookings.set(id, bookingData);
    localAudit.push({ booking_id: id, state: 'AgreementLocked', created_at: bookingData.created_at });

    return send(res, 201, await getBooking(id, user));
  }

  // ── Single booking actions ──
  const match = /^\/api\/bookings\/([^/]+)(?:\/(payment|complete|cancel|dispute|audit|sync-payment|accept|reject|refund-estimate|report-off-platform|verify-arrival))?$/.exec(path);
  if (match) {
    checkAutoRelease();
    const b = await getBooking(match[1], user);
    const action = match[2];

    const isOwner = b.user_id === user.id;
    const isVendor = user.role === 'vendor' && b.owner_id === user.id;
    const isAdmin = user.role === 'admin';

    if (method === 'GET' && !action) {
      const pendingPay = Array.from(localPayments.values()).find(p => p.booking_id === b.id && p.outcome === 'pending' && p.redirect_url);
      const dispute = localDisputes.get(b.id) || null;
      const resBooking = withBookingStatuses(b);
      if (user.role === 'vendor') {
        delete resBooking.arrival_code;
      }
      return send(res, 200, {
        ...resBooking,
        paymentBreakdown: await getSuccessfulPaymentBreakdown(b.id),
        release: await getReleaseStatus(b),
        blockchainEvidence: await getBookingBlockchainEvidence(b.id),
        dispute,
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
      if (user.role !== 'customer' || !isOwner) fail(403, 'Hanya pemilik booking sebagai pelanggan yang dapat melihat estimasi pembatalan.');
      if (!['Pending', 'DPPaid', 'Paid', 'WaitingVendorApproval'].includes(b.state)) fail(409, 'Booking tidak dapat dibatalkan.');
      const estimate = bookingCancellationEstimate(b);
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
      const resBooking = withBookingStatuses(b);
      if (user.role === 'vendor') delete resBooking.arrival_code;
      return send(res, 200, { ...resBooking, message: 'Booking diterima oleh vendor.' });
    }

    if (action === 'reject') {
      if (!isVendor && !isAdmin) fail(403, 'Hanya vendor atau admin yang dapat menolak booking.');
      const refund = b.paid || 0;
      b.state = 'Cancelled';
      b.paid = 0;
      b.updated_at = now();
      localAudit.push({ booking_id: b.id, state: `VendorRejected:refund=${refund}`, created_at: now() });
      const resBooking = withBookingStatuses(b);
      if (user.role === 'vendor') delete resBooking.arrival_code;
      return send(res, 200, { ...resBooking, refund, message: 'Booking ditolak vendor. Dana 100% dikembalikan ke pelanggan.' });
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
      if (user.role !== 'customer' || !isOwner) fail(403, 'Hanya pelanggan pemilik booking yang dapat melakukan pembayaran.');
      if (!['Pending', 'DPPaid', 'WaitingVendorApproval'].includes(b.state)) fail(409, 'Booking tidak dapat dibayar pada status ini.');
      if (!d.expectedState || d.expectedState !== b.state) fail(409, 'Status pembayaran telah berubah. Muat ulang halaman.');

      const paymentType = b.state === 'DPPaid' ? 'FINAL' : 'DP';
      if (d.paymentType !== paymentType) fail(409, 'Jenis pembayaran tidak sesuai dengan status booking. Muat ulang halaman.');
      if (paymentType === 'FINAL' && d.confirmedFinal !== true) fail(400, 'Konfirmasi pelunasan diperlukan sebelum membuat pembayaran FINAL.');

      const isLate = Boolean(b.late_booking);
      const upfrontPercent = isLate ? POLICY.LATE_BOOKING_UPFRONT_PERCENT : POLICY.DP_PERCENT;

      const amount = (b.state === 'Pending' || b.state === 'WaitingVendorApproval')
        ? (b.deposit ? b.price + b.deposit : Math.round(b.price * (upfrontPercent / 100)))
        : b.price - b.paid;
      if (paymentType === 'FINAL') {
        const outstanding = Number(b.price) - Number(b.paid || 0);
        if (!Number.isSafeInteger(outstanding) || outstanding <= 0 || amount !== outstanding) {
          fail(409, 'Sisa tagihan booking tidak valid. Pembayaran pelunasan diblokir.');
        }
      }

      const existing = supabase
        ? await supabase.from('payments').select('*').eq('booking_id', b.id).eq('payment_type', paymentType).order('created_at', { ascending: false })
        : { data: Array.from(localPayments.values()).filter(p => p.booking_id === b.id && p.payment_type === paymentType), error: null };
      if (existing.error) fail(503, 'Riwayat pembayaran gagal dibaca dari database.');
      if (existing.data?.some(p => p.outcome === 'success')) fail(409, 'Pembayaran ini sudah berhasil tercatat.');
      const pendingExisting = existing.data?.find(p => p.outcome === 'pending');
      if (pendingExisting) {
        if (pendingExisting.redirect_url) return send(res, 200, { redirect_url: pendingExisting.redirect_url, token: null, amount: pendingExisting.amount, reused: true, id: b.id });
        fail(409, 'Pembayaran sedang diproses. Tunggu sebentar lalu muat ulang halaman.');
      }

      // Mode Midtrans aktif
      if (isMidtransConfigured() && d.outcome !== 'failed' && d.outcome !== 'expired') {
        const idempotencyKey = `LOCKIN-PAY-${b.id}-${paymentType}-${existing.data?.length || 0}`;
        const orderId = idempotencyKey;
        const payData = { id: randomBytes(12).toString('hex'), booking_id: b.id, method: d.method || 'Midtrans', amount, outcome: 'pending', created_at: now(), provider_order_id: orderId, redirect_url: null, payment_type: paymentType, idempotency_key: idempotencyKey, final_confirmed_at: paymentType === 'FINAL' ? now() : null };
        if (supabase) {
          const { error } = await supabase.from('payments').insert(payData);
          if (error) {
            if (error.code === '23505') fail(409, 'Pembayaran sedang dibuat. Muat ulang halaman untuk melanjutkan.');
            fail(503, 'Data pembayaran gagal disimpan ke database. Coba lagi.');
          }
        }
        localPayments.set(payData.id, payData);
        let snapRes;
        try { snapRes = await createSnapPayment({ orderId, amount }); }
        catch (err) {
          if (supabase) { const { error } = await supabase.from('payments').delete().eq('id', payData.id); if (error) console.error('[Payment reservation cleanup]', error.message); }
          localPayments.delete(payData.id);
          fail(502, 'Gagal membuat checkout Midtrans: ' + err.message);
        }
        const redirectUrl = typeof snapRes === 'string' ? snapRes : snapRes.redirectUrl;
        const token = typeof snapRes === 'object' ? snapRes.token : null;
        if (supabase) {
          const { error } = await supabase.from('payments').update({ redirect_url: redirectUrl }).eq('id', payData.id);
          if (error) fail(503, 'Checkout dibuat, tetapi tautan pembayaran gagal disimpan.');
        }
        payData.redirect_url = redirectUrl;
        localPayments.set(payData.id, payData);
        return send(res, 200, { redirect_url: redirectUrl, token, amount, reused: false, id: b.id });
      }

      // Mode simulasi (tanpa Midtrans)
      if (!['QRIS', 'Virtual Account', 'E-wallet'].includes(d.method)) fail(400, 'Metode pembayaran tidak valid.');
      if (!['success', 'failed', 'expired'].includes(d.outcome)) fail(400, 'Skenario pembayaran tidak valid.');
      const payId = randomBytes(12).toString('hex');
      const payData = { id: payId, booking_id: b.id, method: d.method, amount, outcome: d.outcome, created_at: now(), payment_type: paymentType, idempotency_key: `LOCKIN-PAY-${b.id}-${paymentType}-${existing.data?.length || 0}`, final_confirmed_at: paymentType === 'FINAL' ? now() : null };
      let nextState = b.state, nextPaid = b.paid || 0;
      if (d.outcome === 'success') {
        nextState = b.deposit || b.state === 'DPPaid' ? 'Paid' : 'DPPaid';
        nextPaid += amount;
      } else if (d.outcome === 'expired') nextState = 'Expired';
      const changed = nextState !== b.state || nextPaid !== (b.paid || 0);
      const updatedAt = changed ? now() : b.updated_at;
      if (d.outcome === 'success') {
        payData.paid_at = updatedAt;
      }

      if (supabase) {
        const { error: paymentError } = await supabase.from('payments').insert(payData);
        if (paymentError) fail(paymentError.code === '23505' ? 409 : 503, paymentError.code === '23505' ? 'Pembayaran sedang diproses atau sudah tercatat.' : 'Pembayaran gagal disimpan ke database. Status booking tidak diubah.');
        if (changed) {
          const { error: auditError } = await supabase.from('audit').insert({ booking_id: b.id, state: nextState, created_at: updatedAt });
          if (auditError) {
            const { error: rollbackError } = await supabase.from('payments').delete().eq('id', payId);
            if (rollbackError) console.error('[Payment rollback]', rollbackError.message);
            fail(503, 'Status pembayaran tidak dapat dicatat ke audit database.');
          }
          const { data: persistedBooking, error: bookingError } = await supabase.from('bookings').update({ paid: nextPaid, state: nextState, updated_at: updatedAt }).eq('id', b.id).eq('state', b.state).select('*').maybeSingle();
          if (bookingError || !persistedBooking) {
            await supabase.from('audit').delete().eq('booking_id', b.id).eq('state', nextState).eq('created_at', updatedAt);
            const { error: rollbackError } = await supabase.from('payments').delete().eq('id', payId);
            if (rollbackError) console.error('[Payment rollback]', rollbackError.message);
            fail(bookingError ? 503 : 409, bookingError ? 'Status pembayaran gagal disimpan ke database.' : 'Status booking berubah saat pembayaran diproses. Muat ulang halaman.');
          }
          Object.assign(b, persistedBooking);
        }
      } else if (changed) {
        b.paid = nextPaid;
        b.state = nextState;
        b.updated_at = updatedAt;
      }

      localPayments.set(payId, payData);
      if (!supabase && d.outcome === 'success') {
        localLedgerEntries.push({
          id: `LED-${payId}`, booking_id: b.id, payment_id: payId,
          entry_type: 'SIMULATED_HELD', amount, created_at: updatedAt
        });
      }
      if (changed) localAudit.push({ booking_id: b.id, state: nextState, created_at: updatedAt });
      return send(res, 200, { ...b, outcome: d.outcome, paymentAmount: amount });
    }

    if (action === 'complete') {
      if (b.state !== 'Paid') fail(409, 'Pembayaran belum lunas; booking belum memenuhi syarat penyelesaian.');
      if (isVendor) {
        const evidence = validateText(d.evidence || d.proofUrl || '', 'Bukti penyelesaian pekerjaan', 2000);
        if (!evidence || evidence.trim().length < 5) fail(400, 'Vendor wajib menyertakan bukti penyelesaian kerja (tautan file foto/video hasil atau serah terima).');
        b.completion_evidence = evidence;
        b.updated_at = now();
        localAudit.push({ booking_id: b.id, state: 'VendorProofSubmitted', created_at: now() });
        const resBooking = withBookingStatuses(b);
        if (user.role === 'vendor') delete resBooking.arrival_code;
        return send(res, 200, { ...resBooking, message: 'Bukti kerja berhasil diunggah. Menunggu konfirmasi pelanggan.' });
      }

      if (user.role !== 'customer' || !isOwner) fail(403, 'Hanya pelanggan pemilik booking yang boleh mengonfirmasi penyelesaian dan pencairan.');
      if (b.vendor_arrived !== true || b.execution_state !== 'IN_PROGRESS')
        fail(409, 'Pencairan ditahan sampai kehadiran vendor terverifikasi melalui OTP.');
      const localDispute = localDisputes.get(b.id);
      if (b.state === 'Disputed' || (localDispute && !localDispute.decision))
        fail(409, 'Pencairan ditahan selama sengketa aktif.');
      const releasedAt = now();
      let release;
      if (supabase) {
        const { data, error } = await supabase.rpc('complete_booking_with_simulated_release', {
          p_booking_id: b.id,
          p_released_at: releasedAt
        });
        if (error) {
          console.error('[Simulated release]', { code: error.code, message: error.message });
          if (error.code === 'P0002') fail(404, 'Booking tidak ditemukan.');
          if (error.code === 'P0001' || error.code === '23505' || error.code === '22023')
            fail(409, 'Pencairan tidak dapat diproses: pastikan dana tercatat, OTP terverifikasi, dan tidak ada sengketa.');
          fail(503, 'Pencairan gagal disimpan secara atomik. Status booking dan ledger tidak diubah.');
        }
        if (!data?.ok || data.booking?.state !== 'Completed' || data.release?.entry_type !== 'SIMULATED_RELEASE')
          fail(503, 'Database belum mengonfirmasi status Completed beserta catatan pencairan.');
        Object.assign(b, data.booking);
        release = { simulated: true, status: 'RELEASED', amount: Number(data.release.amount), releasedAt: data.release.created_at };
      } else {
        const successfulPayments = Array.from(localPayments.values())
          .filter(payment => payment.booking_id === b.id && payment.outcome === 'success');
        const heldEntries = localLedgerEntries.filter(entry => entry.booking_id === b.id && entry.entry_type === 'SIMULATED_HELD');
        if (!hasCompleteSimulatedFunds({ booking: b, successfulPayments, heldEntries }))
          fail(409, 'Dana escrow belum tercatat lunas. Pencairan tidak diproses.');
        if (localLedgerEntries.some(entry => entry.booking_id === b.id && entry.entry_type === 'SIMULATED_RELEASE'))
          fail(409, 'Pencairan untuk booking ini sudah tercatat.');
        const releaseEntry = {
          id: `REL-${randomBytes(8).toString('hex').toUpperCase()}`,
          booking_id: b.id, payment_id: null, entry_type: 'SIMULATED_RELEASE',
          amount: Number(b.price), created_at: releasedAt
        };
        localLedgerEntries.push(releaseEntry);
        b.state = 'Completed';
        b.execution_state = 'COMPLETED';
        b.updated_at = releasedAt;
        release = { simulated: true, status: 'RELEASED', amount: releaseEntry.amount, releasedAt };
      }
      localAudit.push({ booking_id: b.id, state: 'Completed:SIMULATED_RELEASE', created_at: releasedAt });
      return send(res, 200, { ...withBookingStatuses(b), release });
    }

    if (action === 'cancel') {
      if (user.role !== 'customer' || !isOwner) fail(403, 'Hanya pelanggan pemilik booking yang dapat membatalkan booking.');
      if (!['Pending', 'DPPaid', 'Paid', 'WaitingVendorApproval'].includes(b.state)) fail(409, 'Booking tidak dapat dibatalkan.');
      const refundCalc = bookingCancellationEstimate(b);
      const cancelledAt = now();
      const allowedStates = ['Pending', 'DPPaid', 'Paid', 'WaitingVendorApproval'];
      if (supabase) {
        const { data, error } = await supabase.from('bookings').update({
          state: 'Cancelled',
          cancellation_refund: refundCalc.refundAmount,
          cancellation_not_refunded: refundCalc.notRefundedAmount,
          cancellation_refund_tier: refundCalc.tier,
          cancellation_refund_description: refundCalc.description,
          cancelled_at: cancelledAt,
          updated_at: cancelledAt
        }).eq('id', b.id).in('state', allowedStates).select('*').maybeSingle();
        if (error) fail(500, 'Hasil pembatalan gagal disimpan. Coba lagi.');
        if (!data) fail(409, 'Booking sudah berubah atau telah dibatalkan. Muat ulang halaman.');
        Object.assign(b, data);
      } else {
        b.state = 'Cancelled';
        b.cancellation_refund = refundCalc.refundAmount;
        b.cancellation_not_refunded = refundCalc.notRefundedAmount;
        b.cancellation_refund_tier = refundCalc.tier;
        b.cancellation_refund_description = refundCalc.description;
        b.cancelled_at = cancelledAt;
        b.updated_at = cancelledAt;
      }
      localAudit.push({ booking_id: b.id, state: `Cancelled:tier=${refundCalc.tier}:refund=${refundCalc.refundAmount}`, created_at: cancelledAt });
      if (supabase) {
        try { await supabase.from('audit').insert({ booking_id: b.id, state: `Cancelled:tier=${refundCalc.tier}:refund=${refundCalc.refundAmount}`, created_at: cancelledAt }); } catch {}
      }
      return send(res, 200, { ...b, refund: refundCalc.refundAmount, refundTier: refundCalc.tier, refundDescription: refundCalc.description, notRefunded: refundCalc.notRefundedAmount });
    }

    if (action === 'dispute') {
      if (user.role !== 'customer' || !isOwner) fail(403, 'Hanya pelanggan pemilik booking yang dapat mengajukan keluhan.');
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
      if (supabase) {
        const { data, error } = await supabase.rpc('create_booking_dispute_with_hold', {
          p_dispute_id: disputeData.id,
          p_booking_id: b.id,
          p_reason: disputeData.reason,
          p_evidence: disputeData.evidence,
          p_evidence_url: disputeData.evidence_url,
          p_vendor_response_due: disputeData.vendor_response_due,
          p_created_at: disputeData.created_at
        });
        if (error) {
          console.error('[Persistent booking dispute]', { code: error.code, message: error.message });
          if (error.code === 'P0001' || error.code === '23505') fail(409, 'Sengketa tidak dapat dibuka karena status booking telah berubah atau sudah ada sengketa.');
          fail(503, 'Sengketa gagal disimpan secara persisten. Status booking tidak diubah.');
        }
        if (!data?.ok || data.booking?.state !== 'Disputed' || data.dispute?.id !== id)
          fail(503, 'Database belum mengonfirmasi status sengketa.');
        Object.assign(b, data.booking);
        Object.assign(disputeData, data.dispute);
      } else {
        b.state = 'Disputed';
        b.updated_at = disputeData.created_at;
      }
      localDisputes.set(b.id, disputeData);
      localAudit.push({ booking_id: b.id, state: 'Disputed', created_at: disputeData.created_at });
      return send(res, 201, { id, message: 'Keluhan diajukan. Pencairan dana ditahan sampai admin memutuskan.' });
    }

    if (action === 'verify-arrival') {
      if (user.role !== 'vendor' || b.owner_id !== user.id) {
        fail(403, 'Hanya vendor pemilik booking yang dapat mengonfirmasi kedatangan.');
      }
      if (b.state === 'Cancelled') {
        fail(409, 'Booking telah dibatalkan.');
      }
      if (b.state !== 'Paid') {
        fail(409, 'Hanya booking yang telah berstatus lunas (Paid) yang dapat diverifikasi kedatangannya.');
      }
      if (b.vendor_arrived || b.execution_state === 'IN_PROGRESS' || b.execution_state === 'COMPLETED' || b.state === 'Completed') {
        fail(409, 'Kedatangan vendor sudah pernah diverifikasi sebelumnya.');
      }

      const todayJakarta = localToday();
      if (!b.event_date || typeof b.event_date !== 'string') {
        fail(400, 'Tanggal acara booking tidak valid.');
      }
      if (todayJakarta < b.event_date) {
        fail(400, 'Verifikasi kehadiran hanya dapat dilakukan pada hari pelaksanaan acara (hari H) atau setelahnya.');
      }

      const attemptKey = `otp:${b.id}`;
      const nowTs = Date.now();
      const attemptRecord = otpAttempts.get(attemptKey) || { count: 0, lockedUntil: 0 };
      if (attemptRecord.lockedUntil > nowTs) {
        const waitMin = Math.ceil((attemptRecord.lockedUntil - nowTs) / 60000);
        fail(429, `Terlalu banyak percobaan OTP yang salah. Coba lagi dalam ${waitMin} menit.`);
      }

      const expectedCode = typeof b.arrival_code === 'string' ? b.arrival_code.trim() : '';
      if (!expectedCode || !/^\d{6}$/.test(expectedCode)) {
        fail(400, 'Kode OTP kedatangan belum tersedia pada booking ini.');
      }

      const inputCode = String(d.otp != null ? d.otp : d.code != null ? d.code : '').trim();
      if (!/^\d{6}$/.test(inputCode)) {
        fail(400, 'Kode OTP kedatangan wajib tepat 6 digit angka.');
      }

      const inputBuf = Buffer.from(inputCode, 'utf8');
      const expectedBuf = Buffer.from(expectedCode, 'utf8');
      const match = inputBuf.length === expectedBuf.length && timingSafeEqual(inputBuf, expectedBuf);

      if (!match) {
        attemptRecord.count += 1;
        if (attemptRecord.count >= 5) {
          attemptRecord.lockedUntil = nowTs + (15 * 60 * 1000);
          otpAttempts.set(attemptKey, attemptRecord);
          fail(429, 'Terlalu banyak percobaan OTP yang salah. Verifikasi untuk booking ini ditangguhkan selama 15 menit.');
        }
        otpAttempts.set(attemptKey, attemptRecord);
        const remaining = 5 - attemptRecord.count;
        fail(400, `Kode OTP kedatangan tidak cocok. Sisa percobaan: ${remaining}.`);
      }

      otpAttempts.delete(attemptKey);

      const arrivedAt = now();
      const executionState = 'IN_PROGRESS';

      if (supabase) {
        const updatePayload = {
          vendor_arrived: true,
          execution_state: executionState,
          updated_at: arrivedAt
        };
        let { data, error } = await supabase
          .from('bookings')
          .update({ ...updatePayload, vendor_arrived_at: arrivedAt })
          .eq('id', b.id)
          .eq('vendor_arrived', false)
          .eq('state', 'Paid')
          .select('*')
          .maybeSingle();

        if (error && error.code === '42703') {
          const fallback = await supabase
            .from('bookings')
            .update(updatePayload)
            .eq('id', b.id)
            .eq('vendor_arrived', false)
            .eq('state', 'Paid')
            .select('*')
            .maybeSingle();
          data = fallback.data;
          error = fallback.error;
        }

        if (error) {
          console.error('[Supabase verify-arrival error]', error.code, error.message);
          fail(503, 'Status kedatangan gagal disimpan ke database.');
        }
        if (!data) {
          fail(409, 'Verifikasi kedatangan gagal diproses karena status booking telah berubah atau sudah diverifikasi.');
        }
        Object.assign(b, data);
        b.vendor_arrived_at = arrivedAt;
      } else {
        if (b.vendor_arrived) {
          fail(409, 'Kedatangan vendor sudah pernah diverifikasi sebelumnya.');
        }
        b.vendor_arrived = true;
        b.execution_state = executionState;
        b.vendor_arrived_at = arrivedAt;
        b.updated_at = arrivedAt;
      }

      localAudit.push({ booking_id: b.id, state: 'VendorArrivalVerified', created_at: arrivedAt });
      if (supabase) {
        try {
          await supabase.from('audit').insert({ booking_id: b.id, state: 'VendorArrivalVerified', created_at: arrivedAt });
        } catch (auditErr) {
          console.error('[Audit verify-arrival error]', auditErr);
        }
      }

      const resBooking = withBookingStatuses(b);
      delete resBooking.arrival_code;

      return send(res, 200, {
        ok: true,
        message: 'Vendor terverifikasi telah tiba dan check-in di lokasi acara.',
        booking: resBooking
      });
    }

    if (action === 'sync-payment') {
      if (!isMidtransConfigured()) fail(400, 'Midtrans tidak dikonfigurasi.');
      if (!isOwner && !isAdmin) fail(403, 'Hanya pemilik booking yang dapat menyinkronkan pembayaran.');
      let pay;
      if (supabase) {
        const { data, error } = await supabase.from('payments').select('*').eq('booking_id', b.id).not('provider_order_id', 'is', null).order('created_at', { ascending: false }).limit(1);
        if (error) fail(503, 'Transaksi gagal dibaca dari database.');
        pay = data?.[0];
      } else pay = Array.from(localPayments.values()).reverse().find(p => p.booking_id === b.id && p.provider_order_id);
      if (!pay) fail(404, 'Belum ada transaksi pembayaran Midtrans.');
      try {
        const status = await fetchMidtransStatus(pay.provider_order_id);
        const result = await recordNotification(status, { localBookings, localPayments, localAudit });
        const latestBooking = await getBooking(b.id, user);
        return send(res, 200, { result, booking: withBookingStatuses(latestBooking) });
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
