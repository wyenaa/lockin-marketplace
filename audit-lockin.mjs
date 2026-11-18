/**
 * LockIn — Audit pembayaran DP dan FINAL.
 * Pemeriksaan bersifat read-only.
 * Jalankan: node audit-lockin.mjs
 */

import "dotenv/config";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  Contract,
  id,
  Interface,
  isAddress,
  JsonRpcProvider
} from "ethers";

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

const contracts = {
  DP: {
    address: process.env.SEPOLIA_DP_CONTRACT_ADDRESS,
    eventName: "DpPaymentRecorded"
  },
  FINAL: {
    address: process.env.SEPOLIA_FINAL_CONTRACT_ADDRESS,
    eventName: "FinalPaymentRecorded"
  }
};

const events = {
  DP: new Interface([
    "event DpPaymentRecorded(bytes32 indexed bookingRefHash, bytes32 indexed paymentRefHash, bytes32 agreementHash, uint256 recordedAt)"
  ]),
  FINAL: new Interface([
    "event FinalPaymentRecorded(bytes32 indexed bookingRefHash, bytes32 indexed paymentRefHash, bytes32 agreementHash, uint256 recordedAt)"
  ])
};

const databasePath = path.resolve(process.cwd(), "data", "lockin.sqlite");
let db;
let provider;
const writerCache = new Map();

async function auditConfirmedJob(job, payment, booking) {
  const kind = payment.payment_type || 'DP';
  const config = contracts[kind];

  if (!job.tx_hash) {
    warn(`${kind}: CONFIRMED tanpa tx_hash.`);
    return;
  }

  if (!provider || !config?.address || !isAddress(config.address)) {
    warn(`${kind}: RPC atau alamat kontrak tidak tersedia.`);
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

    if (receipt.to?.toLowerCase() !== config.address.toLowerCase()) {
      fail(`${kind}: alamat kontrak tujuan tidak cocok`);
      return;
    }
    pass(`${kind}: tujuan kontrak sesuai`);

    let authorizedWriter = writerCache.get(kind);
    if (!authorizedWriter) {
      const contract = new Contract(
        config.address,
        ["function authorizedWriter() view returns (address)"],
        provider
      );
      authorizedWriter = await contract.authorizedWriter();
      writerCache.set(kind, authorizedWriter);
    }

    if (receipt.from.toLowerCase() === authorizedWriter.toLowerCase()) {
      pass(`${kind}: pengirim sesuai authorizedWriter`);
    } else {
      fail(`${kind}: pengirim bukan authorizedWriter`);
    }

    const matchingEvents = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== config.address.toLowerCase()) continue;
      try {
        const parsed = events[kind].parseLog(log);
        if (parsed?.name === config.eventName) matchingEvents.push(parsed.args);
      } catch {}
    }

    if (matchingEvents.length !== 1) {
      fail(`${kind}: diharapkan 1 event ${config.eventName}, ditemukan ${matchingEvents.length}`);
      return;
    }
    pass(`${kind}: event ${config.eventName} ditemukan`);

    const event = matchingEvents[0];
    if (event.bookingRefHash.toLowerCase() === id(booking.id).toLowerCase()) {
      pass(`${kind}: bookingRefHash cocok`);
    } else {
      fail(`${kind}: bookingRefHash berbeda`);
    }

    const orderRef = payment.provider_order_id || payment.id;
    if (event.paymentRefHash.toLowerCase() === id(orderRef).toLowerCase()) {
      pass(`${kind}: paymentRefHash cocok`);
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
  } catch (error) {
    warn(`${kind}: pemeriksaan RPC bermasalah (${error.shortMessage || error.message})`);
  }
}

try {
  db = new DatabaseSync(databasePath, { readOnly: true });

  console.log("\n=== AUDIT LOCKIN: DP + PELUNASAN (READ ONLY) ===");

  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(row => row.name);
  const required = ["bookings", "payments", "ledger_entries", "blockchain_jobs"];

  for (const name of required) {
    if (tables.includes(name)) pass(`Tabel ${name} ada`);
    else fail(`Tabel ${name} tidak ada`);
  }

  if (process.env.SEPOLIA_RPC_URL) {
    try {
      provider = new JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
      const network = await provider.getNetwork();
      if (network.chainId !== 11155111n) {
        fail(`RPC memakai chainId ${network.chainId}, bukan Sepolia`);
        provider.destroy();
        provider = null;
      } else {
        pass("RPC terhubung ke Ethereum Sepolia");
      }
    } catch (error) {
      warn(`Koneksi Sepolia bermasalah (${error.shortMessage || error.message})`);
      provider?.destroy();
      provider = null;
    }
  } else {
    warn("SEPOLIA_RPC_URL tidak tersedia");
  }

  const bookings = db.prepare(`SELECT * FROM bookings ORDER BY id`).all();
  if (bookings.length) pass(`Ditemukan ${bookings.length} booking`);
  else warn("Belum ada booking");

  for (const booking of bookings) {
    const totalAmount = booking.price || booking.total_amount || 0;
    const bookingState = booking.state || booking.status;
    console.log(`\nBOOKING ${booking.id} | ${bookingState} | Total Rp${totalAmount}`);

    const rawHash = booking.hash || booking.agreement_hash || '';
    const cleanHash = rawHash.replace(/^0x/i, '');
    if (/^[0-9a-f]{64}$/i.test(cleanHash)) {
      pass("Format agreement hash valid SHA-256");
    } else {
      fail("Format agreement hash tidak valid");
    }

    const payments = db.prepare(`SELECT * FROM payments WHERE booking_id = ? ORDER BY id`).all(booking.id);
    if (!payments.length) warn("Booking belum memiliki pembayaran");

    for (const payment of payments) {
      const isPaid = payment.outcome === 'success' || payment.status === 'PAID';
      console.log(`  Pembayaran ${payment.id} [${payment.payment_type || 'DP'}]: ${isPaid ? 'PAID' : (payment.outcome || payment.status)} Rp${payment.amount}`);
      if (isPaid) {
        const job = db.prepare(`SELECT * FROM blockchain_jobs WHERE payment_id = ?`).get(payment.id);
        if (job) {
          console.log(`    Blockchain job: ${job.status}${job.tx_hash ? ` (tx: ${job.tx_hash})` : ''}`);
          if (job.status === 'CONFIRMED') {
            await auditConfirmedJob(job, payment, booking);
          }
        }
      }
    }
  }

  console.log(`\nAudit selesai: ${passed} passed, ${failed} failed, ${warnings} warnings\n`);
} catch (e) {
  console.error("Audit error:", e.message);
} finally {
  provider?.destroy();
}
