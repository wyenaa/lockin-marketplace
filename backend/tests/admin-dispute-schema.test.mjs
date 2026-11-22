import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('admin decision migration records only a decision under ordered locks, no funds moved', async () => {
  const sql = await readFile('database/migrations/20261123_admin_dispute_decision_record.sql', 'utf8');
  assert.match(sql, /FROM public\.bookings WHERE id = booking_id_value FOR UPDATE/);
  assert.match(sql, /FROM public\.disputes WHERE id = p_dispute_id FOR UPDATE/);
  assert.match(sql, /decision IS NOT NULL/);
  assert.match(sql, /vendor_response_due/);
  assert.match(sql, /refund_percent/);
  assert.match(sql, /GRANT EXECUTE.*TO service_role/);
  assert.doesNotMatch(sql, /INSERT INTO public\.ledger_entries|UPDATE public\.ledger_entries|UPDATE public\.bookings|refund\s*=\s*/);
});
