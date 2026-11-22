import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const migrationFile = 'database/migrations/20261123_dispute_simulated_settlement.sql';
const sourceFile = 'backend/src/index.js';
const frontFile = 'frontend/public/index.html';

test('Sengketa 1D RPC is atomic, privileged, idempotent, and keeps vendor deposit separate', async () => {
  const sql = await readFile(migrationFile, 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.execute_dispute_simulated_settlement/);
  assert.match(sql, /SECURITY DEFINER SET search_path = pg_catalog, public/);
  assert.match(sql, /FROM public\.bookings WHERE id = booking_id_value FOR UPDATE/);
  assert.match(sql, /FROM public\.disputes WHERE id = p_dispute_id FOR UPDATE/);
  assert.match(sql, /dispute_row\.settled_at IS NOT NULL/);
  assert.match(sql, /entry_type IN \('SIMULATED_RELEASE','SIMULATED_REFUND'\)/);
  assert.match(sql, /HAVING COUNT\(le\.id\) <> 1 OR COALESCE\(SUM\(le\.amount\),0\) <> p\.amount/);
  assert.match(sql, /INSERT INTO public\.ledger_entries[\s\S]+?'SIMULATED_REFUND'/);
  assert.match(sql, /INSERT INTO public\.ledger_entries[\s\S]+?'SIMULATED_RELEASE'/);
  assert.match(sql, /SET state = 'Resolved'/);
  assert.match(sql, /service_funds \* dispute_row\.refund_percent \+ 50\) \/ 100/);
  assert.match(sql, /held_amount - LEAST\(COALESCE\(booking_row\.deposit,0\)::BIGINT,held_amount\)/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.execute_dispute_simulated_settlement\(TEXT,TIMESTAMPTZ\) TO service_role/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.execute_dispute_simulated_settlement\(TEXT,TIMESTAMPTZ\) FROM anon,authenticated/);
  assert.doesNotMatch(sql, /UPDATE public\.payments|UPDATE public\.blockchain_jobs|pg_sleep\(/i);
});

test('Admin-only settlement endpoint calls the RPC and blocks repeat execution', async () => {
  const source = await readFile(sourceFile, 'utf8');
  const begin = source.indexOf("if (disputeMatch[2] === 'execute') {");
  const end = source.indexOf("if (dispute.decision) fail(409", begin);
  assert.ok(begin >= 0 && end > begin);
  const section = source.slice(begin, end);
  assert.match(section, /user\.role !== 'admin'/);
  assert.match(section, /dispute\.settled_at \|\| b\.state !== 'Disputed'/);
  assert.match(section, /supabase\.rpc\('execute_dispute_simulated_settlement'/);
  assert.match(section, /result\.settlement\?\.status !== 'SETTLED'/);
  assert.doesNotMatch(section, /createSnapPayment|syncBlockchainJobs|\.rpc\('complete_booking_with_simulated_release'/);
});

// Run actual backend helper source with an isolated in-memory ledger (no Supabase credentials).
async function isolatedReleaseHelpers() {
  const source = await readFile(sourceFile, 'utf8');
  const start = source.indexOf('async function getReleaseStatus(');
  const end = source.indexOf('function vendorPackages(', start);
  assert.ok(start > 0 && end > start);
  const context = vm.createContext({
    Number, Math, Array, Map, Boolean,
    supabase: null,
    localDisputes: new Map(),
    localLedgerEntries: [],
    fail: (status, message) => { throw new Error(`${status}: ${message}`); }
  });
  vm.runInContext(source.slice(start, end), context);
  return context;
}

test('Refund partial/full/vendor-only is reported as SETTLED, never as a normal payout', async () => {
  const c = await isolatedReleaseHelpers();
  const booking = { id:'TEST-SETTLE', price:100000, deposit:0, paid:100000, state:'Resolved' };
  const held = [{ booking_id:booking.id, entry_type:'SIMULATED_HELD', amount:100000 }];
  for (const [percent, refund, vendor] of [[70,70000,30000],[100,100000,0],[0,0,100000]]) {
    c.localLedgerEntries.length = 0;
    c.localLedgerEntries.push(...held);
    if (refund) c.localLedgerEntries.push({ booking_id:booking.id, entry_type:'SIMULATED_REFUND', amount:refund });
    if (vendor) c.localLedgerEntries.push({ booking_id:booking.id, entry_type:'SIMULATED_RELEASE', amount:vendor });
    c.localDisputes.set(booking.id, { decision: percent===100?'full':percent===0?'release':'partial',
      refund_percent:percent,refund,settled_at:'2026-11-22T16:00:00Z' });
    const result = await c.getReleaseStatus(booking);
    assert.equal(result.status,'SETTLED');
    assert.equal(result.settlement.refundAmount,refund);
    assert.equal(result.settlement.vendorAmount,vendor);
    assert.equal(result.amount,0);
  }
});

test('Incomplete disputed ledger is unavailable rather than falsely marked settled', async () => {
  const c = await isolatedReleaseHelpers();
  const booking = { id:'TEST-MISMATCH',price:100000,deposit:0,paid:100000,state:'Resolved' };
  c.localLedgerEntries.push({booking_id:booking.id,entry_type:'SIMULATED_HELD',amount:100000},
    {booking_id:booking.id,entry_type:'SIMULATED_REFUND',amount:70000});
  c.localDisputes.set(booking.id,{decision:'partial',refund_percent:70,refund:70000,settled_at:'2026-11-22T16:00:00Z'});
  await assert.rejects(()=>c.getReleaseStatus(booking),/belum cocok dengan catatan ledger/);
});

test('Verified admin escrow totals exclude allocated refunds and vendor portions', async () => {
  const c = await isolatedReleaseHelpers();
  const bookings = [
    {id:'held',price:100000,deposit:0,paid:100000,state:'Disputed'},
    {id:'settled',price:100000,deposit:0,paid:100000,state:'Resolved'},
    {id:'normal',price:625000,deposit:0,paid:625000,state:'Completed'}
  ];
  const payments = bookings.map((b,i)=>({id:`payment-${i}`,booking_id:b.id,amount:b.paid,outcome:'success'}));
  const ledger = bookings.map((b,i)=>({booking_id:b.id,payment_id:`payment-${i}`,entry_type:'SIMULATED_HELD',amount:b.paid}));
  ledger.push({booking_id:'settled',payment_id:null,entry_type:'SIMULATED_REFUND',amount:70000},
    {booking_id:'settled',payment_id:null,entry_type:'SIMULATED_RELEASE',amount:30000},
    {booking_id:'normal',payment_id:null,entry_type:'SIMULATED_RELEASE',amount:625000});
  assert.equal(c.verifiedSimulatedEscrowTotal(bookings,payments,ledger),100000);
  ledger.find(e=>e.booking_id==='settled'&&e.entry_type==='SIMULATED_REFUND').amount=70001;
  assert.equal(c.verifiedSimulatedEscrowTotal(bookings,payments,ledger),null);
});

test('Customer, vendor and admin UI distinguish decision from executed settlement', async () => {
  const html = await readFile(frontFile, 'utf8');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const code = script.replace(/\ninitializeLockIn\(\);\s*$/, '');
  const dummyEl={style:{},innerHTML:'',classList:{toggle:()=>{}}};
  const sandbox={console,Math,Date,Intl,URL,String,Number,Boolean,Array,Object,JSON,RegExp,
    location:{hash:'#status'}, document:{addEventListener:()=>{},getElementById:()=>dummyEl,querySelectorAll:()=>[]},
    history:{pushState:()=>{},replaceState:()=>{}},addEventListener:()=>{},scrollTo:()=>{},fetch:async()=>({ok:true,json:async()=>({})})};
  sandbox.window=sandbox;
  const c=vm.createContext(sandbox);
  vm.runInContext(code,c);
  const booking = {id:'LI-TEST-1D',state:'Resolved',price:100000,paid:100000,deposit:0,
    event_date:'2026-11-22',date:'2026-11-22',location:'Malang',vendor_name:'MUA Test',
    execution_state:'NOT_STARTED',executionStatus:'NOT_STARTED',paymentStatus:'PAID',
    dpPaid:30000,finalPaid:70000,rest:70000,arrived:false,vendor_arrived:false,
    paymentBreakdown:{dpAmount:30000,finalAmount:70000},paymentBreakdownVerified:true,
    dispute:{id:'DSP-TEST',decision:'partial',refund_percent:70,decision_reason:'Keputusan setelah bukti diperiksa.',
      settled_at:'2026-11-22T16:00:00Z',reason:'Keluhan',evidence:'Bukti tes'},
    release:{simulated:true,status:'SETTLED',amount:0,releasedAt:null,
      settlement:{simulated:true,status:'SETTLED',serviceAmount:100000,refundAmount:70000,
        vendorAmount:30000,refundPercent:70,settledAt:'2026-11-22T16:00:00Z'}}};
  const statusCard=c.releaseStatusCard(booking);
  assert.match(statusCard,/Sengketa Selesai \(Simulasi\)/);
  assert.match(statusCard,/Rp70\.000/);
  assert.match(statusCard,/Rp30\.000/);
  assert.doesNotMatch(statusCard,/Dana Ditahan \(Simulasi\)/);
  c.S.role='customer';c.S.activeBid=booking.id;c.S.bookingsList=[booking];
  assert.match(c.pages.status(),/Sengketa selesai melalui keputusan admin/);
  c.S.role='vendor';c.S.activeVendorBid=booking.id;c.S.vendorDetail=booking;c.S.vendorBookings=[booking];
  c.S.vendorDashboardLoading=false;c.S.vendorDashboardError='';
  const vendor=c.pages.dashboard();
  assert.match(vendor,/Refund Sengketa \(Simulasi\)/);
  assert.match(vendor,/Rp70\.000/);
  assert.match(vendor,/Rp30\.000/);
  assert.match(vendor,/Sengketa Selesai/);
  c.S.role='admin';c.S.adminDisputeDetailId=booking.dispute.id;c.S.adminDisputeDetail=booking;
  c.S.adminDisputeDetailLoading=false;c.S.adminDisputeDecisionError='';
  const admin=c.renderAdminDisputeModal();
  assert.match(admin,/Penyelesaian Sengketa Sudah Dicatat/);
  assert.doesNotMatch(admin,/data-a="execute-admin-settlement"/);
});
