// LockIn — Backend Entry Point
// Node.js HTTP server + REST API + static file server
import 'dotenv/config';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { supabase, isSupabaseConfigured } from './db/supabase.js';
import { createSnapPayment, verifySignature, interpretNotification, fetchMidtransStatus, isMidtransConfigured } from './services/midtrans.js';
import { syncBlockchainJobs, isBlockchainConfigured } from './services/blockchain.js';
import { handleMidtransWebhook, recordNotification } from './webhooks/midtrans.js';

const root = dirname(fileURLToPath(import.meta.url));
// Frontend static files served dari folder frontend/public
const publicRoot = resolve(root, '../../frontend/public');

// ─── Helpers ────────────────────────────────────────────────────────────────
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const now  = () => new Date().toISOString();
const localToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
const digest = text => '0x' + createHash('sha256').update(text).digest('hex');
const send = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
};

// ─── Session helper (Supabase auth) ─────────────────────────────────────────
async function userOf(req) {
  if (!supabase) return null;
  const token = /lockin_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
  if (!token) return null;
  const { data } = await supabase
    .from('sessions')
    .select('*, users(id, name, email, role)')
    .eq('token', token)
    .gt('expires', Date.now())
    .single();
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

// ─── Expire pending bookings ─────────────────────────────────────────────────
async function expireBookings() {
  if (!supabase) return;
  await supabase.from('bookings').update({ state: 'Expired', updated_at: now() })
    .eq('state', 'Pending').lt('expires', Date.now());
}

// ─── Booking helper (dengan role check) ──────────────────────────────────────
async function getBooking(id, user) {
  const { data: b } = await supabase
    .from('bookings')
    .select('*, vendors(name, category, owner_id)')
    .eq('id', id)
    .single();
  if (!b) fail(404, 'Booking tidak ditemukan.');
  if (user.role !== 'admin' && b.user_id !== user.id &&
     !(user.role === 'vendor' && b.vendors?.owner_id === user.id))
    fail(403, 'Anda tidak memiliki akses ke booking ini.');
  return { ...b, vendor_name: b.vendors?.name, category: b.vendors?.category, owner_id: b.vendors?.owner_id };
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
    return send(res, 200, { ok: true, mode: 'sandbox', database: isSupabaseConfigured() ? 'Supabase' : 'tidak terkonfigurasi', blockchain: isBlockchainConfigured(), midtrans: isMidtransConfigured() });

  // ── Auth ──
  if (path === '/api/auth/me')
    return send(res, 200, { user: user || null });

  if (path === '/api/auth/logout' && method === 'POST') {
    const token = /lockin_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
    if (token && supabase) await supabase.from('sessions').delete().eq('token', token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'lockin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }

  if (['/api/auth/login', '/api/auth/register'].includes(path) && method === 'POST') {
    const d = await body(req);
    const email = validateText(d.email, 'Email', 160).toLowerCase();
    const password = validateText(d.password, 'Password', 128);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Format email tidak valid.');

    if (path.endsWith('register')) {
      if (password.length < 10) fail(400, 'Password minimal 10 karakter.');
      // Daftarkan via Supabase Auth
      const { error } = await supabase.auth.signUp({ email, password, options: { data: { name: validateText(d.name, 'Nama', 80), role: 'customer' } } });
      if (error) fail(error.status || 400, error.message);
    }

    const { data: authData, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) fail(401, 'Email atau password salah.');

    const token = randomBytes(32).toString('hex');
    await supabase.from('sessions').insert({ token, user_id: authData.user.id, expires: Date.now() + 86400000 });
    const { data: profile } = await supabase.from('users').select('id,name,email,role').eq('id', authData.user.id).single();
    return send(res, 200, { user: profile }, { 'Set-Cookie': `lockin_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400` });
  }

  // ── Vendors (public) ──
  if (path === '/api/vendors' && method === 'GET') {
    let query = supabase.from('vendors').select('id,name,category,price,deposit,rating,completed,verified,color,description');
    const category = url.searchParams.get('category');
    const city = url.searchParams.get('city');
    const date = url.searchParams.get('date');
    if (category && category !== 'Semua') query = query.eq('category', category);
    if (city && !'malang'.includes(city.toLowerCase())) return send(res, 200, []);
    const { data: rows } = await query;
    let result = rows || [];
    if (date) {
      const { data: booked } = await supabase.from('bookings').select('vendor_id').eq('event_date', date).not('state', 'in', '("Expired","Cancelled","Refunded")');
      const bookedIds = new Set((booked || []).map(b => b.vendor_id));
      result = result.filter(v => !bookedIds.has(v.id));
    }
    if (url.searchParams.get('sort') === 'price') result.sort((a, b) => a.price - b.price);
    if (url.searchParams.get('sort') === 'rating') result.sort((a, b) => b.rating - a.rating);
    return send(res, 200, result);
  }

  if (/^\/api\/vendors\/[^/]+$/.test(path) && method === 'GET') {
    const { data: v } = await supabase.from('vendors').select('*').eq('id', path.split('/').pop()).single();
    if (!v) fail(404, 'Vendor tidak ditemukan.');
    const { data: reserved } = await supabase.from('bookings').select('event_date').eq('vendor_id', v.id).not('state', 'in', '("Expired","Cancelled","Refunded")');
    return send(res, 200, { ...v, reserved: (reserved || []).map(r => r.event_date) });
  }

  // ── Leads (public) ──
  if (path === '/api/leads' && method === 'POST') {
    const d = await body(req);
    const contact = validateText(d.contact, 'Email atau WhatsApp', 160);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) && !/^\+?[\d\s-]{9,18}$/.test(contact))
      fail(400, 'Masukkan email atau nomor WhatsApp yang valid.');
    await supabase.from('leads').upsert({ contact, created_at: now() }, { onConflict: 'contact', ignoreDuplicates: true });
    return send(res, 201, { message: 'Terima kasih! Pendaftaran minat vendor tersimpan.' });
  }

  // ── Auth required beyond this point ──
  if (!user) fail(401, 'Silakan masuk terlebih dahulu.');

  // ── Bookings list ──
  if (path === '/api/bookings' && method === 'GET') {
    const { data: rows } = await supabase.from('bookings').select('*, vendors(name, category, owner_id)').order('created_at', { ascending: false });
    const filtered = (rows || []).filter(b =>
      user.role === 'admin' || b.user_id === user.id ||
      (user.role === 'vendor' && b.vendors?.owner_id === user.id)
    ).map(b => ({ ...b, vendor_name: b.vendors?.name, category: b.vendors?.category, owner_id: b.vendors?.owner_id }));
    return send(res, 200, filtered);
  }

  // ── Create booking ──
  if (path === '/api/bookings' && method === 'POST') {
    if (user.role !== 'customer') fail(403, 'Gunakan akun pelanggan untuk membuat booking.');
    const d = await body(req);
    const { data: v } = await supabase.from('vendors').select('*').eq('id', d.vendorId).single();
    if (!v) fail(404, 'Vendor tidak ditemukan.');
    if (!d.agreed) fail(400, 'Setujui perjanjian terlebih dahulu.');
    const date = validateText(d.date, 'Tanggal', 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < localToday()) fail(400, 'Pilih tanggal acara yang valid dan belum lewat.');
    const location = validateText(d.location, 'Lokasi', 200);
    const start = validateText(d.startTime, 'Jam mulai', 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) fail(400, 'Jam mulai tidak valid.');

    // Cek ketersediaan vendor di tanggal yang dipilih
    const { data: conflict } = await supabase.from('bookings').select('id').eq('vendor_id', v.id).eq('event_date', date).not('state', 'in', '("Expired","Cancelled","Refunded")').limit(1);
    if (conflict?.length) fail(409, 'Vendor sudah dipesan pada tanggal ini. Pilih tanggal lain.');

    const id = 'LI-' + randomBytes(5).toString('hex').toUpperCase();
    const agreement = JSON.stringify({
      vendorId: v.id, category: v.category, date, location, startTime: start,
      price: v.price, deposit: v.deposit,
      refund: v.deposit ? 'H-3:100%;H-2:0%' : 'H-7:100%;H-3:50%;H-2:0%',
      scope: v.description,
      ...(v.category === 'GCC' ? { revisions: 1, files: 30 } : {})
    });
    const hash = digest(agreement);

    await supabase.from('bookings').insert({
      id, user_id: user.id, vendor_id: v.id, event_date: date, location,
      start_time: start, price: v.price, deposit: v.deposit, paid: 0,
      state: 'Pending', agreement, hash, created_at: now(), expires: Date.now() + 86400000
    });
    await supabase.from('audit').insert({ booking_id: id, state: 'AgreementLocked', created_at: now() });

    return send(res, 201, await getBooking(id, user));
  }

  // ── Single booking actions ──
  const match = /^\/api\/bookings\/([^/]+)(?:\/(payment|complete|cancel|dispute|audit|sync-payment))?$/.exec(path);
  if (match) {
    const b = await getBooking(match[1], user);
    const action = match[2];

    if (method === 'GET' && !action) {
      const { data: dpPay }    = await supabase.from('payments').select('id,provider_order_id').eq('booking_id', b.id).eq('payment_type', 'DP').eq('outcome', 'success').limit(1);
      const { data: finalPay } = await supabase.from('payments').select('id,provider_order_id').eq('booking_id', b.id).eq('payment_type', 'FINAL').eq('outcome', 'success').limit(1);
      const dpJob    = dpPay?.[0]  ? (await supabase.from('blockchain_jobs').select('status,tx_hash,last_error').eq('payment_id', dpPay[0].id).single()).data : null;
      const finalJob = finalPay?.[0] ? (await supabase.from('blockchain_jobs').select('status,tx_hash,last_error').eq('payment_id', finalPay[0].id).single()).data : null;
      const { data: ledger } = await supabase.from('ledger_entries').select('amount').eq('booking_id', b.id).eq('entry_type', 'SIMULATED_HELD');
      const ledgerHeld = (ledger || []).reduce((s, r) => s + r.amount, 0);
      const { data: dispute } = await supabase.from('disputes').select('*').eq('booking_id', b.id).single();
      const { data: pendingPay } = await supabase.from('payments').select('redirect_url,payment_type').eq('booking_id', b.id).eq('outcome', 'pending').not('redirect_url', 'is', null).order('created_at', { ascending: false }).limit(1);
      return send(res, 200, { ...b, dispute: dispute || null, dpBlockchain: dpJob, finalBlockchain: finalJob, ledgerHeld, pendingPayment: pendingPay?.[0] || null, blockchainConfigured: isBlockchainConfigured() });
    }

    if (method === 'GET' && action === 'audit') {
      const { data } = await supabase.from('audit').select('state,hash,created_at').eq('booking_id', b.id).order('id');
      return send(res, 200, data || []);
    }

    if (method !== 'POST') fail(405, 'Metode tidak diizinkan.');
    if (b.user_id !== user.id) fail(403, 'Tindakan ini hanya untuk pemilik booking.');

    const d = await body(req);

    if (action === 'payment') {
      if (!['Pending', 'DPPaid'].includes(b.state)) fail(409, 'Booking tidak dapat dibayar pada status ini.');
      if (d.expectedState && d.expectedState !== b.state) fail(409, 'Status pembayaran telah berubah. Muat ulang halaman.');
      const amount = b.state === 'Pending' ? (b.deposit ? b.price + b.deposit : Math.round(b.price * .3)) : b.price - b.paid;
      const paymentType = b.state === 'DPPaid' ? 'FINAL' : 'DP';

      // Mode Midtrans aktif → buat Snap transaction
      if (isMidtransConfigured() && d.outcome !== 'failed' && d.outcome !== 'expired') {
        const { data: existing } = await supabase.from('payments').select('redirect_url').eq('booking_id', b.id).eq('payment_type', paymentType).eq('outcome', 'pending').not('redirect_url', 'is', null).order('created_at', { ascending: false }).limit(1);
        if (existing?.[0]?.redirect_url) return send(res, 200, { redirect_url: existing[0].redirect_url, reused: true, id: b.id });
        const orderId = `LOCKIN-${paymentType}-${b.id}-${randomBytes(4).toString('hex')}`;
        let redirectUrl;
        try { redirectUrl = await createSnapPayment({ orderId, amount }); }
        catch (err) { fail(502, 'Gagal membuat checkout Midtrans: ' + err.message); }
        await supabase.from('payments').insert({ id: randomBytes(12).toString('hex'), booking_id: b.id, method: d.method || 'Midtrans', amount, outcome: 'pending', created_at: now(), provider_order_id: orderId, redirect_url: redirectUrl, payment_type: paymentType });
        return send(res, 200, { redirect_url: redirectUrl, reused: false, id: b.id });
      }

      // Mode simulasi (tanpa Midtrans)
      if (!['QRIS', 'Virtual Account', 'E-wallet'].includes(d.method)) fail(400, 'Metode pembayaran tidak valid.');
      if (!['success', 'failed', 'expired'].includes(d.outcome)) fail(400, 'Skenario pembayaran tidak valid.');
      const payId = randomBytes(12).toString('hex');
      await supabase.from('payments').insert({ id: payId, booking_id: b.id, method: d.method, amount, outcome: d.outcome, created_at: now(), payment_type: paymentType });
      if (d.outcome === 'success') {
        const state = b.deposit || b.state === 'DPPaid' ? 'Paid' : 'DPPaid';
        await supabase.from('bookings').update({ paid: (b.paid || 0) + amount, state, updated_at: now() }).eq('id', b.id);
        await supabase.from('audit').insert({ booking_id: b.id, state, created_at: now() });
        await supabase.from('ledger_entries').insert({ booking_id: b.id, payment_id: payId, entry_type: 'SIMULATED_HELD', amount, created_at: now() });
        await supabase.from('blockchain_jobs').upsert({ booking_id: b.id, payment_id: payId, status: 'QUEUED', retry_after: 0 }, { onConflict: 'booking_id,payment_id', ignoreDuplicates: true });
      } else if (d.outcome === 'expired') {
        await supabase.from('bookings').update({ state: 'Expired', updated_at: now() }).eq('id', b.id);
        await supabase.from('audit').insert({ booking_id: b.id, state: 'Expired', created_at: now() });
      }
      return send(res, 200, { ...await getBooking(b.id, user), outcome: d.outcome });
    }

    if (action === 'complete') {
      if (b.state !== 'Paid') fail(409, 'Booking harus lunas.');
      if (b.event_date > localToday()) fail(409, 'Acara belum berlangsung.');
      await supabase.from('bookings').update({ state: 'Completed', updated_at: now() }).eq('id', b.id);
      await supabase.from('audit').insert({ booking_id: b.id, state: 'Completed', created_at: now() });
      return send(res, 200, await getBooking(b.id, user));
    }

    if (action === 'cancel') {
      if (!['Pending', 'DPPaid', 'Paid'].includes(b.state)) fail(409, 'Booking tidak dapat dibatalkan.');
      const days = Math.round((Date.parse(b.event_date) - Date.parse(localToday())) / 86400000);
      const rate = b.deposit ? (days >= 3 ? 1 : 0) : (days >= 7 ? 1 : days >= 3 ? .5 : 0);
      const refund = Math.round(Math.min(b.paid, b.price) * rate) + (b.deposit && b.paid ? b.deposit : 0);
      await supabase.from('bookings').update({ state: 'Cancelled', updated_at: now() }).eq('id', b.id);
      await supabase.from('audit').insert({ booking_id: b.id, state: `Cancelled:refund=${refund}`, created_at: now() });
      return send(res, 200, { ...await getBooking(b.id, user), refund });
    }

    if (action === 'dispute') {
      if (!['DPPaid', 'Paid'].includes(b.state)) fail(409, 'Keluhan hanya untuk booking yang sudah dibayar.');
      const elapsed = Date.now() - Date.parse(b.event_date + 'T00:00:00+07:00');
      if (elapsed < 0 || elapsed > 3 * 86400000) fail(409, 'Keluhan dapat diajukan pada hari acara hingga 48 jam setelah akhir hari acara.');
      const reason = validateText(d.reason, 'Alasan', 1000);
      const evidence = validateText(d.evidence, 'Bukti', 4000);
      const id = 'DSP-' + randomBytes(4).toString('hex');
      await supabase.from('disputes').insert({ id, booking_id: b.id, reason, evidence, created_at: now() });
      await supabase.from('bookings').update({ state: 'Disputed', updated_at: now() }).eq('id', b.id);
      await supabase.from('audit').insert({ booking_id: b.id, state: 'Disputed', created_at: now() });
      return send(res, 201, { id });
    }

    if (action === 'sync-payment') {
      if (!isMidtransConfigured()) fail(400, 'Midtrans tidak dikonfigurasi.');
      const { data: pays } = await supabase.from('payments').select('*').eq('booking_id', b.id).not('provider_order_id', 'is', null).order('created_at', { ascending: false }).limit(1);
      const pay = pays?.[0];
      if (!pay) fail(404, 'Belum ada transaksi pembayaran Midtrans.');
      try {
        const status = await fetchMidtransStatus(pay.provider_order_id);
        if (status.order_id !== pay.provider_order_id || Number(status.gross_amount) !== pay.amount) fail(409, 'Data pembayaran tidak sesuai.');
        const result = await recordNotification(status);
        if (result.status === 'rejected') fail(409, result.reason);
        return send(res, 200, { result, booking: await getBooking(b.id, user) });
      } catch (err) { if (err.status) throw err; fail(502, 'Gagal memeriksa pembayaran: ' + err.message); }
    }
  }

  // ── Disputes (vendor/admin) ──
  if (path === '/api/disputes' && method === 'GET') {
    if (user.role !== 'admin' && user.role !== 'vendor') fail(403, 'Akses ditolak.');
    const { data: rows } = await supabase.from('disputes').select('*, bookings(event_date, paid, hash, agreement, state, vendors(name, owner_id))').order('created_at', { ascending: false });
    return send(res, 200, (rows || []).filter(d => user.role === 'admin' || d.bookings?.vendors?.owner_id === user.id));
  }

  const disputeMatch = /^\/api\/disputes\/([^/]+)\/(resolve|response)$/.exec(path);
  if (disputeMatch && method === 'POST') {
    const d = await body(req);
    const { data: dispute } = await supabase.from('disputes').select('*').eq('id', disputeMatch[1]).single();
    if (!dispute) fail(404, 'Sengketa tidak ditemukan.');
    const b = await getBooking(dispute.booking_id, user);
    if (dispute.decision) fail(409, 'Sengketa telah diputuskan.');
    if (disputeMatch[2] === 'response') {
      if (user.role !== 'vendor' || b.owner_id !== user.id) fail(403, 'Hanya vendor terkait yang dapat menanggapi.');
      await supabase.from('disputes').update({ response: validateText(d.response, 'Tanggapan', 4000) }).eq('id', dispute.id);
      return send(res, 200, { ok: true });
    }
    if (user.role !== 'admin') fail(403, 'Hanya admin yang dapat memutuskan sengketa.');
    if (!['release', 'partial', 'full'].includes(d.decision)) fail(400, 'Keputusan tidak valid.');
    const percent = d.decision === 'full' ? 100 : d.decision === 'release' ? 0 : Number(d.percent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) fail(400, 'Persentase harus 0–100.');
    const refund = Math.round(b.paid * percent / 100);
    await supabase.from('disputes').update({ decision: d.decision, refund }).eq('id', dispute.id);
    await supabase.from('bookings').update({ state: percent === 100 ? 'Refunded' : 'Resolved', updated_at: now() }).eq('id', b.id);
    await supabase.from('audit').insert({ booking_id: b.id, state: `Resolved:refund=${refund}`, created_at: now() });
    return send(res, 200, { ok: true, refund });
  }

  fail(404, 'Endpoint tidak ditemukan.');
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  try {
    const url = new URL(req.url, 'http://localhost');

    // Webhook Midtrans
    if (url.pathname === '/webhooks/midtrans' && req.method === 'POST') {
      const d = await body(req);
      return handleMidtransWebhook(req, res, d);
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
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
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
  console.log(`   Supabase:   ${isSupabaseConfigured() ? '✅ aktif' : '❌ tidak dikonfigurasi'}`);
  console.log(`   Midtrans:   ${isMidtransConfigured() ? '✅ aktif (Sandbox)' : '⚠️  mode simulasi'}`);
  console.log(`   Blockchain: ${isBlockchainConfigured() ? '✅ aktif (Sepolia)' : '⚠️  tidak dikonfigurasi'}`);
});

// Blockchain worker: setiap 15 detik
setInterval(() => { syncBlockchainJobs().catch(err => console.error('[Blockchain worker]', err.message)); }, 15000).unref();
