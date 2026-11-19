/**
 * LockIn — Script Audit Konsistensi Transaksi (Database & Ethereum Sepolia)
 * Mengaudit Smart Contract Tunggal (LockInEscrow.sol).
 * Pemeriksaan bersifat read-only.
 * Jalankan: node audit-lockin.mjs
 */

import "dotenv/config";
import ws from "ws";
if (!globalThis.WebSocket) {
  globalThis.WebSocket = ws;
}
import {
  Contract,
  id,
  Interface,
  isAddress,
  JsonRpcProvider
} from "ethers";
import { createClient } from "@supabase/supabase-js";

let passed = 0;
let failed = 0;
let warnings = 0;

const pass = message => {
  passed++;
  console.log(`  [OK] ${message}`);
};

const fail = message => {
  failed++;
  console.log(`  [GAGAL] ${message}`);
};

const warn = message => {
  warnings++;
  console.log(`  [PERLU DICEK] ${message}`);
};

const contractAddress = process.env.SEPOLIA_CONTRACT_ADDRESS || process.env.SEPOLIA_DP_CONTRACT_ADDRESS;

const contractInterface = new Interface([
  "event BookingStatusUpdated(bytes32 indexed bookingRefHash, bytes32 indexed paymentRefHash, bytes32 agreementHash, uint8 status, uint256 timestamp)"
]);

let provider;
let authorizedWriterCache = null;

async function auditConfirmedJob(job, payment, booking) {
  const kind = payment.payment_type || 'DP';

  if (!job.tx_hash) {
    warn(`${kind}: CONFIRMED tanpa tx_hash.`);
    return;
  }

  if (!provider || !contractAddress || !isAddress(contractAddress)) {
    warn(`${kind}: RPC atau alamat kontrak tidak valid.`);
    return;
  }

  try {
    const receipt = await provider.getTransactionReceipt(job.tx_hash);
    if (!receipt) {
      warn(`${kind}: receipt belum ditemukan (${job.tx_hash})`);
      return;
    }

    if (receipt.status !== 1) {
      fail(`${kind}: receipt transaksi tidak berhasil`);
      return;
    }
    pass(`${kind}: receipt Sepolia berhasil`);

    if (receipt.to?.toLowerCase() !== contractAddress.toLowerCase()) {
      fail(`${kind}: alamat kontrak tujuan tidak cocok`);
      return;
    }
    pass(`${kind}: tujuan kontrak sesuai (LockInEscrow)`);

    if (!authorizedWriterCache) {
      const contract = new Contract(
        contractAddress,
        ["function authorizedWriter() view returns (address)"],
        provider
      );
      authorizedWriterCache = await contract.authorizedWriter();
    }

    if (receipt.from.toLowerCase() === authorizedWriterCache.toLowerCase()) {
      pass(`${kind}: pengirim sesuai authorizedWriter`);
    } else {
      fail(`${kind}: pengirim bukan authorizedWriter`);
    }

    const matchingEvents = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
      try {
        const parsed = contractInterface.parseLog(log);
        if (parsed?.name === "BookingStatusUpdated") matchingEvents.push(parsed.args);
      } catch {}
    }

    if (matchingEvents.length >= 1) {
      pass(`${kind}: event BookingStatusUpdated ditemukan on-chain`);
      const event = matchingEvents[0];
      if (event.bookingRefHash.toLowerCase() === id(booking.id).toLowerCase()) {
        pass(`${kind}: bookingRefHash cocok on-chain`);
      } else {
        fail(`${kind}: bookingRefHash berbeda`);
      }

      const orderRef = payment.provider_order_id || payment.id;
      if (event.paymentRefHash.toLowerCase() === id(orderRef).toLowerCase()) {
        pass(`${kind}: paymentRefHash cocok on-chain`);
      } else {
        fail(`${kind}: paymentRefHash berbeda`);
      }

      const rawHash = booking.hash || booking.agreement_hash || '';
      const formattedHash = rawHash.startsWith('0x') ? rawHash : `0x${rawHash}`;
      if (event.agreementHash.toLowerCase() === formattedHash.toLowerCase()) {
        pass(`${kind}: agreementHash cocok dengan database`);
      } else {
        fail(`${kind}: agreementHash berbeda dari database`);
      }
    } else {
      fail(`${kind}: event BookingStatusUpdated tidak ditemukan di receipt`);
    }
  } catch (error) {
    warn(`${kind}: pemeriksaan RPC bermasalah (${error.shortMessage || error.message})`);
  }
}

async function runAudit() {
  console.log("\n=======================================================");
  console.log(" 🔍 AUDIT LOCKIN: 1 KONTRAK TUNGGAL & DATABASE (READ-ONLY)");
  console.log("=======================================================\n");

  // 1. Periksa RPC Sepolia
  if (process.env.SEPOLIA_RPC_URL) {
    try {
      provider = new JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
      const network = await provider.getNetwork();
      if (network.chainId !== 11155111n) {
        fail(`RPC memakai chainId ${network.chainId}, bukan Sepolia (11155111)`);
        provider.destroy();
        provider = null;
      } else {
        pass("RPC terhubung ke Ethereum Sepolia Testnet");
      }
    } catch (error) {
      warn(`Koneksi Sepolia bermasalah (${error.shortMessage || error.message})`);
      provider?.destroy();
      provider = null;
    }
  } else {
    warn("SEPOLIA_RPC_URL tidak tersedia");
  }

  // 2. Periksa Smart Contract Tunggal
  if (contractAddress && isAddress(contractAddress)) {
    pass(`Alamat Smart Contract Tunggal (LockInEscrow) valid: ${contractAddress}`);
  } else {
    warn("Alamat Smart Contract belum diatur di .env (SEPOLIA_CONTRACT_ADDRESS)");
  }

  // 3. Periksa Database (Supabase)
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (supabaseUrl && supabaseKey) {
    pass("Konfigurasi Supabase terdeteksi");
    const supabase = createClient(supabaseUrl, supabaseKey);

    const requiredTables = ["bookings", "payments", "ledger_entries", "blockchain_jobs"];
    for (const table of requiredTables) {
      const { error } = await supabase.from(table).select('id').limit(1);
      if (error && error.code === '42P01') {
        fail(`Tabel ${table} belum dibuat di Supabase`);
      } else {
        pass(`Tabel ${table} tersedia di Supabase`);
      }
    }

    const { data: bookings } = await supabase.from('bookings').select('*').order('created_at', { ascending: false });
    if (bookings?.length) {
      pass(`Ditemukan ${bookings.length} booking di database`);
      for (const booking of bookings) {
        console.log(`\nBOOKING ${booking.id} | Status: ${booking.state} | Total: Rp${booking.price}`);
        const rawHash = booking.hash || '';
        const cleanHash = rawHash.replace(/^0x/i, '');
        if (/^[0-9a-f]{64}$/i.test(cleanHash)) {
          pass("Format agreement hash valid SHA-256");
        } else {
          fail("Format agreement hash tidak valid");
        }

        const { data: payments } = await supabase.from('payments').select('*').eq('booking_id', booking.id);
        if (!payments?.length) warn("Booking belum memiliki pembayaran");

        for (const payment of payments || []) {
          const isPaid = payment.outcome === 'success';
          console.log(`  Pembayaran ${payment.id} [${payment.payment_type || 'DP'}]: ${isPaid ? 'PAID' : payment.outcome} Rp${payment.amount}`);
          if (isPaid) {
            const { data: job } = await supabase.from('blockchain_jobs').select('*').eq('payment_id', payment.id).single();
            if (job) {
              console.log(`    Blockchain job: ${job.status}${job.tx_hash ? ` (tx: ${job.tx_hash})` : ''}`);
              if (job.status === 'CONFIRMED') {
                await auditConfirmedJob(job, payment, booking);
              }
            }
          }
        }
      }
    } else {
      warn("Belum ada data booking di database Supabase.");
    }
  } else {
    warn("Kredensial Supabase belum diatur di .env.");
  }

  console.log(`\nAudit selesai: ${passed} passed, ${failed} failed, ${warnings} warnings\n`);
  provider?.destroy();
}

runAudit().catch(err => {
  console.error("Audit error:", err.message);
  provider?.destroy();
});
