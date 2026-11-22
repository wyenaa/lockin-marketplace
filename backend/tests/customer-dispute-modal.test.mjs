import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const html = await readFile(new URL('../../frontend/public/index.html', import.meta.url), 'utf8');

function extract(start, end) {
  const first = html.indexOf(start);
  const last = html.indexOf(end, first);
  assert.notEqual(first, -1, `missing source marker ${start}`);
  assert.notEqual(last, -1, `missing source marker ${end}`);
  return html.slice(first, last);
}

test('dispute form validates required text, limits, and HTTP(S) evidence URLs', () => {
  const context = { URL };
  runInNewContext(extract('function disputeFormValidation', 'function safeVendorApplicationUrl'), context);

  assert.equal(context.disputeFormValidation({ title: '', evidence: 'abc' }).valid, false);
  assert.equal(context.disputeFormValidation({ title: 'Kategori: keterlambatan', evidence: '1234' }).errors.evidence, 'Bukti tertulis wajib diisi minimal 5 karakter.');
  assert.equal(context.disputeFormValidation({ title: 'x'.repeat(1001), evidence: '12345' }).errors.title, 'Kategori dan kronologi harus maksimal 1.000 karakter.');
  assert.match(context.disputeFormValidation({ title: 'x', evidence: '12345', evidenceUrl: 'javascript:alert(1)' }).errors.evidenceUrl, /http/);

  const valid = context.disputeFormValidation({ title: 'Layanan tidak sesuai kronologi', evidence: 'Rincian bukti tertulis', evidenceUrl: 'https://example.test/proof' });
  assert.equal(valid.valid, true);
  assert.equal(valid.reason, 'Layanan tidak sesuai kronologi');
  assert.equal(valid.evidence, 'Rincian bukti tertulis');
  assert.equal(valid.evidenceUrl, 'https://example.test/proof');
});

test('dispute modal renders escaped booking information, hold notice, fields, and accessible dialog', () => {
  const context = {
    S: {
      disputeModalBookingId: 'BKG-<1>',
      disputeForm: { title: '', evidence: '', evidenceUrl: '' },
      disputeErrors: {},
      disputeModalLoading: false,
      bookingsList: [{ id: 'BKG-<1>', vendor_name: '<Vendor>' }]
    },
    URL,
    getVendor: () => null,
    escapeUi: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
  };
  runInNewContext(extract('function disputeFormValidation', 'function safeVendorApplicationUrl'), context);
  const modal = context.renderDisputeModal();
  assert.match(modal, /role="dialog" aria-modal="true"/);
  assert.match(modal, /Ajukan Sengketa/);
  assert.match(modal, /&lt;Vendor&gt;/);
  assert.match(modal, /BKG-&lt;1&gt;/);
  assert.match(modal, /Judul Keluhan/);
  assert.match(modal, /Bukti Pendukung Tertulis/);
  assert.match(modal, /Tautan Bukti/);
  assert.match(modal, /ditahan secara simulasi/);
});

test('submission posts to the booking captured by the modal even if active selection changes', async () => {
  let posted;
  const origin = { focus() {} };
  const context = {
    S: {
      role: 'customer', activeBid: 'BKG-A', bookingsList: [
        { id: 'BKG-A', state: 'DPPaid', vendor_name: 'Vendor A' },
        { id: 'BKG-B', state: 'DPPaid', vendor_name: 'Vendor B' }
      ], disputeModalBookingId: '', disputeModalLoading: false,
      disputeForm: { title: '', evidence: '', evidenceUrl: '' }, disputeErrors: {}, disputePreviousFocus: null
    },
    URL,
    document: { activeElement: origin, getElementById: () => ({ focus() {} }), contains: () => false, querySelector: () => null },
    encodeURIComponent,
    render() {},
    toast() {},
    async apiRequest(path, method, body) {
      posted = { path, method, body };
      context.S.activeBid = 'BKG-B';
      return { ok: true };
    },
    async refreshBookings(id) { assert.equal(id, 'BKG-A'); }
  };
  runInNewContext(extract('function disputeFormValidation', 'function safeVendorApplicationUrl') + extract('function openDisputeModal', "window.addEventListener('hashchange'"), context);

  context.openDisputeModal('BKG-A');
  context.S.disputeForm = { title: 'Kategori dan kronologi ringkas', evidence: 'Bukti tertulis lengkap', evidenceUrl: 'https://example.test/evidence' };
  await context.submitBookingDispute();

  assert.equal(posted.path, '/api/bookings/BKG-A/dispute');
  assert.equal(posted.method, 'POST');
  assert.equal(posted.body.reason, 'Kategori dan kronologi ringkas');
  assert.equal(posted.body.evidence, 'Bukti tertulis lengkap');
  assert.equal(posted.body.evidenceUrl, 'https://example.test/evidence');
  assert.equal(context.S.disputeModalBookingId, '');
});

test('legacy prompt and duplicate complaint simulation handlers are removed', () => {
  assert.doesNotMatch(html, /window\.prompt\('Masukkan kronologi keluhan sengketa:'/);
  assert.equal((html.match(/if\(k===?'open-complain'\)/g) || []).length, 1);
  assert.doesNotMatch(html, /complaintText=r\.trim\(\)/);
});
