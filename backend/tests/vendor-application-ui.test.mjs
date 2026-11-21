import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function makeUi(apiRequest) {
  const html = await readFile('frontend/public/index.html', 'utf8');
  const start = html.indexOf('var vendorApplicationSending=false;');
  const end = html.indexOf('function validHttpUrl', start);
  assert.ok(start >= 0 && end > start, 'Handler pendaftaran aktif harus ditemukan');
  const fields = { vn: 'Usaha Uji', vo: 'Pemilik Uji', vk: 'MUA', ve: 'uji@example.id', vw: '081234567890', vi: '@usaha.uji', vp: 'https://example.id', vpr: 'Mulai Rp100.000', vd: 'Deskripsi uji' };
  const elements = {};
  for (const id of [...Object.keys(fields), 'vreg-form', 'vreg-success', 'vreg-step1', 'vreg-step2', 'vreg-step-badge', 'vreg-message', 'vreg-submit']) {
    elements[id] = { value: fields[id] ?? '', textContent: '', style: {}, disabled: false, selectedIndex: 0 };
  }
  const idText = { textContent: '' };
  elements['vreg-success-id'] = { style: {}, querySelector: () => idText };
  const context = {
    URL, document: { getElementById: id => elements[id] }, apiRequest, toast: () => {}
  };
  vm.runInNewContext(html.slice(start, html.indexOf('// Bank-Style', end)), context);
  return { context, elements, fields, idText, html };
}

test('vendor application UI shows confirmation after server success, prevents duplicate submit, and resets for another listing', async () => {
  let resolveRequest;
  let requests = 0;
  const ui = await makeUi(() => { requests++; return new Promise(resolve => { resolveRequest = resolve; }); });
  assert.match(ui.html, /Pengajuan Berhasil Dikirim!/);
  assert.match(ui.html, /Menunggu Persetujuan Admin/);
  const first = ui.context.submitVendorApplication();
  assert.equal(ui.elements['vreg-submit'].disabled, true);
  await ui.context.submitVendorApplication();
  assert.equal(requests, 1);
  resolveRequest({ ok: true, application: { id: 'VAPP-1234ABCD', status: 'pending_approval' } });
  await first;
  assert.equal(ui.elements['vreg-form'].style.display, 'none');
  assert.equal(ui.elements['vreg-success'].style.display, 'block');
  assert.equal(ui.idText.textContent, 'VAPP-1234ABCD');

  ui.context.resetVendorApplicationForm();
  assert.equal(ui.elements['vreg-success'].style.display, 'none');
  assert.equal(ui.elements['vreg-form'].style.display, 'block');
  assert.equal(ui.elements['vreg-step1'].style.display, 'block');
  assert.equal(ui.elements['vreg-step2'].style.display, 'none');
  assert.equal(ui.elements['vreg-step-badge'].textContent, 'Tahap 1 dari 2');
  for (const id of ['vn', 'vo', 've', 'vw', 'vi', 'vp', 'vpr', 'vd']) assert.equal(ui.elements[id].value, '');
  assert.equal(ui.elements.vk.selectedIndex, 0);
});

test('vendor application UI keeps form data and shows a readable error after request failure', async () => {
  const ui = await makeUi(async () => { throw new Error('Server gagal menyimpan pengajuan.'); });
  await ui.context.submitVendorApplication();
  assert.equal(ui.elements['vreg-form'].style.display, undefined);
  assert.equal(ui.elements['vreg-success'].style.display, undefined);
  assert.equal(ui.elements.vn.value, 'Usaha Uji');
  assert.equal(ui.elements.vd.value, 'Deskripsi uji');
  assert.match(ui.elements['vreg-message'].textContent, /gagal menyimpan/i);
  assert.equal(ui.elements['vreg-message'].style.color, 'var(--badt)');
  assert.equal(ui.elements['vreg-message'].style.background, 'var(--bad)');
});
