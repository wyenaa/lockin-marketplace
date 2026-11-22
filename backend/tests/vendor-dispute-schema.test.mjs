import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('persistent dispute select matches additive migration columns', async () => {
  const backend = await readFile('backend/src/index.js', 'utf8');
  const migration = await readFile('database/migrations/20261123_vendor_dispute_response_fields.sql', 'utf8');
  for (const column of ['vendor_evidence_url', 'decision_reason', 'decided_at']) {
    assert.match(backend, new RegExp(`\\b${column}\\b`));
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`));
  }
  assert.match(migration, /GRANT UPDATE \(response, vendor_evidence_url\) ON TABLE public\.disputes TO service_role/);
  assert.doesNotMatch(migration, /GRANT.+TO (anon|authenticated)/);
});

test('vendor dispute list checks ownership through vendors, not nonexistent booking columns', async () => {
  const backend = await readFile('backend/src/index.js', 'utf8');
  const listing = backend.slice(backend.indexOf("if (path === '/api/disputes'"), backend.indexOf('const disputeMatch ='));
  assert.match(listing, /from\('vendors'\)\.select\('id'\)\.eq\('owner_id', user\.id\)/);
  assert.match(listing, /from\('bookings'\)\.select\('id'\)\.in\('vendor_id', vendorIds\)/);
  assert.doesNotMatch(listing, /from\('bookings'\)\.select\('id'\)\.eq\('owner_id'/);
  assert.doesNotMatch(listing, /select\('id,event_date,paid,state,vendor_name,owner_id,/);
});
