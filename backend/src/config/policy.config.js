// LockIn — Central Business Policy Configuration
// Menyimpan semua parameter operasional, jendela waktu, dan aturan refund terpusat.

export const POLICY = {
  DP_PERCENT: 30,
  LATE_BOOKING_UPFRONT_PERCENT: 70,
  FINAL_PAYMENT_INVOICE_DAYS_BEFORE: 3, // Tagihan pelunasan dikirim H-3
  FINAL_PAYMENT_DUE_DAYS_BEFORE: 1,    // Jatuh tempo pelunasan H-1
  VENDOR_ACCEPT_WINDOW_HOURS: 3,       // Batas waktu vendor menerima booking mepet (3 jam)
  DISPUTE_FILE_WINDOW_HOURS: 48,       // Batas waktu ajukan keluhan pasca acara (48 jam)
  VENDOR_RESPONSE_WINDOW_HOURS: 48,    // Batas waktu vendor merespons keluhan (48 jam)
  AUTO_RELEASE_HOURS_AFTER_EVENT: 48,  // Dana otomatis cair ke vendor jika tanpa keluhan (48 jam)
  OFF_PLATFORM_PENALTY_PERCENT: 30,    // Sanksi denda 30% dari dana tertahan jika bayar di luar platform
  PLATFORM_FEE_PERCENT: 3,

  // Aturan Refund Berjenjang (Refund Tiers)
  REFUND_TIERS: [
    {
      key: 'H7_OR_MORE',
      minDaysBefore: 7,
      label: 'H-7 atau lebih',
      clientRefundPercent: 70, // Dari total harga (sisa 70% dikembalikan penuh, DP 30% jadi hak vendor setelah fee)
      vendorPercent: 30,
      description: 'Refund semua pembayaran di luar DP 30% (DP menjadi hak vendor, dikurangi fee platform).'
    },
    {
      key: 'H3_TO_H6',
      minDaysBefore: 3,
      maxDaysBefore: 6,
      label: 'H-6 sampai H-3',
      clientRefundPercent: 50,
      vendorPercent: 50,
      description: 'Refund 50% dari total dana yang sudah dibayar.'
    },
    {
      key: 'H0_TO_H2',
      minDaysBefore: 0,
      maxDaysBefore: 2,
      label: 'H-2 sampai Hari H',
      clientRefundPercent: 0,
      vendorPercent: 100,
      description: 'Tidak ada refund (0%). Seluruh dana diteruskan ke vendor.'
    }
  ],

  // Kata kunci deteksi transaksi di luar platform
  OFF_PLATFORM_KEYWORDS: [
    'transfer langsung',
    'rekening pribadi',
    'bca',
    'bri',
    'mandiri',
    'bni',
    'no rek',
    'nomor rekening',
    'bayar di luar',
    'cash aja',
    'wa saya',
    'whatsapp langsung'
  ]
};

/**
 * Hitung selisih hari antara tanggal acara dengan tanggal saat ini (H-X)
 */
export function getDaysBeforeEvent(eventDate, currentDate = new Date()) {
  const eDate = new Date(eventDate);
  const cDate = new Date(currentDate);
  eDate.setHours(0, 0, 0, 0);
  cDate.setHours(0, 0, 0, 0);
  return Math.floor((eDate.getTime() - cDate.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Cek apakah booking termasuk kategori booking mepet (H-1 atau kurang)
 */
export function isLateBooking(eventDate, currentDate = new Date()) {
  const daysBefore = getDaysBeforeEvent(eventDate, currentDate);
  return daysBefore <= 1;
}

/**
 * Hitung persentase pembayaran muka dan pelunasan berdasarkan waktu pemesanan
 */
export function getPaymentSchedule(eventDate, currentDate = new Date()) {
  const late = isLateBooking(eventDate, currentDate);
  const upfrontPercent = late ? POLICY.LATE_BOOKING_UPFRONT_PERCENT : POLICY.DP_PERCENT;
  const finalPercent = 100 - upfrontPercent;
  return {
    isLate: late,
    upfrontPercent,
    finalPercent,
    invoiceDaysBefore: POLICY.FINAL_PAYMENT_INVOICE_DAYS_BEFORE,
    dueDaysBefore: POLICY.FINAL_PAYMENT_DUE_DAYS_BEFORE
  };
}

/**
 * Hitung nominal refund secara dinamis berdasarkan tier dan kondisi pembatalan
 */
export function calculateRefund({
  eventDate,
  currentDate = new Date(),
  totalPaid = 0,
  price = 0,
  isVendorCancellation = false,
  isForceMajeure = false
}) {
  // 1. Vendor membatalkan atau Force Majeure -> Refund 100%
  if (isVendorCancellation || isForceMajeure) {
    return {
      tier: isVendorCancellation ? 'VENDOR_CANCEL' : 'FORCE_MAJEURE',
      daysBefore: getDaysBeforeEvent(eventDate, currentDate),
      refundPercent: 100,
      refundAmount: totalPaid,
      vendorPenalized: isVendorCancellation,
      description: isVendorCancellation
        ? 'Vendor membatalkan sepihak: 100% dana kembali ke pelanggan dan vendor terkena penalti reputasi.'
        : 'Force Majeure diverifikasi admin: 100% dana kembali atau dilakukan penjadwalan ulang.'
    };
  }

  const daysBefore = getDaysBeforeEvent(eventDate, currentDate);

  // 2. H-7 atau lebih
  if (daysBefore >= 7) {
    const dpAmount = Math.round(price * (POLICY.DP_PERCENT / 100));
    const refundAmount = Math.max(0, totalPaid - dpAmount);
    return {
      tier: 'H7_OR_MORE',
      daysBefore,
      refundPercent: 70,
      refundAmount,
      description: POLICY.REFUND_TIERS[0].description
    };
  }

  // 3. H-6 sampai H-3
  if (daysBefore >= 3 && daysBefore <= 6) {
    const refundAmount = Math.round(totalPaid * 0.5);
    return {
      tier: 'H3_TO_H6',
      daysBefore,
      refundPercent: 50,
      refundAmount,
      description: POLICY.REFUND_TIERS[1].description
    };
  }

  // 4. H-2 sampai Hari H
  return {
    tier: 'H0_TO_H2',
    daysBefore,
    refundPercent: 0,
    refundAmount: 0,
    description: POLICY.REFUND_TIERS[2].description
  };
}

/**
 * Deteksi ajakan pembayaran di luar platform
 */
export function detectOffPlatformViolation(text) {
  if (!text || typeof text !== 'string') return { detected: false, matches: [] };
  const lower = text.toLowerCase();
  const matches = POLICY.OFF_PLATFORM_KEYWORDS.filter(k => lower.includes(k));
  // Cek juga pola nomor rekening (deretan 9-16 digit)
  const bankAccountPattern = /\b\d{9,16}\b/;
  const hasAccount = bankAccountPattern.test(text.replace(/[\s-]/g, ''));
  if (hasAccount) matches.push('Nomor Rekening Terdeteksi');

  return {
    detected: matches.length > 0,
    matches,
    warning: matches.length > 0
      ? 'Peringatan Keamanan: Terdeteksi indikasi ajakan bertransaksi di luar platform. Pembayaran di luar sistem LockIn menghilangkan jaminan refund dan mediasi resmi.'
      : null
  };
}
