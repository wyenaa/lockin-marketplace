// LockIn — Smart contract: Pencatatan bukti DP
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  LockInBookingLog
/// @notice Testnet-only audit trail — NO RUPIAH, NO ESCROW, NO TOKENS.
/// @dev    Hanya menyimpan hash referensi. Perjanjian asli tetap off-chain.
contract LockInBookingLog {
    address public immutable authorizedWriter;

    /// @dev paymentRefHash → sudah tercatat atau belum (idempotency)
    mapping(bytes32 => bool) public recordedPayments;

    event DpPaymentRecorded(
        bytes32 indexed bookingRefHash,
        bytes32 indexed paymentRefHash,
        bytes32 agreementHash,
        uint256 recordedAt
    );

    error Unauthorized();
    error AlreadyRecorded();
    error InvalidWriter();

    /// @param writer Alamat wallet backend yang berhak menulis ke kontrak ini.
    constructor(address writer) {
        if (writer == address(0)) revert InvalidWriter();
        authorizedWriter = writer;
    }

    /// @notice Catat bukti pembayaran DP ke blockchain.
    /// @param bookingRefHash  keccak256(bookingId)
    /// @param agreementHash   SHA-256 dari isi perjanjian (disimpan di DB)
    /// @param paymentRefHash  keccak256(provider_order_id Midtrans)
    function recordDpPayment(
        bytes32 bookingRefHash,
        bytes32 agreementHash,
        bytes32 paymentRefHash
    ) external {
        if (msg.sender != authorizedWriter) revert Unauthorized();
        if (recordedPayments[paymentRefHash]) revert AlreadyRecorded();
        recordedPayments[paymentRefHash] = true;
        emit DpPaymentRecorded(bookingRefHash, paymentRefHash, agreementHash, block.timestamp);
    }
}
