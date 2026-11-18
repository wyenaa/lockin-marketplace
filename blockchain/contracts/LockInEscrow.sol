// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  LockInEscrow
/// @notice Smart Contract Tunggal untuk mencatat perjanjian, pembayaran DP, pelunasan, dan pembaruan status booking.
/// @dev    Testnet-only audit trail: TIDAK MENYIMPAN RUPIAH, TIDAK ADA TOKEN. Hanya menyimpan hash referensi off-chain.
contract LockInEscrow {
    address public immutable authorizedWriter;

    enum BookingStatus {
        None,
        AgreementLocked,
        DPPaid,
        FinalPaid,
        Completed,
        Cancelled,
        Disputed,
        Resolved
    }

    struct BookingRecord {
        bytes32 agreementHash;
        BookingStatus status;
        uint256 updatedAt;
    }

    // bookingRefHash => BookingRecord
    mapping(bytes32 => BookingRecord) public bookings;

    // paymentRefHash => bool (idempotency: cegah pencatatan pembayaran ganda)
    mapping(bytes32 => bool) public recordedPayments;

    event BookingStatusUpdated(
        bytes32 indexed bookingRefHash,
        bytes32 indexed paymentRefHash,
        bytes32 agreementHash,
        BookingStatus status,
        uint256 timestamp
    );

    error Unauthorized();
    error AlreadyRecorded();
    error InvalidWriter();
    error BookingNotFound();

    constructor(address writer) {
        if (writer == address(0)) revert InvalidWriter();
        authorizedWriter = writer;
    }

    modifier onlyWriter() {
        if (msg.sender != authorizedWriter) revert Unauthorized();
        _;
    }

    /// @notice Catat pembayaran DP dan ubah status menjadi DPPaid
    /// @param bookingRefHash keccak256 dari bookingId
    /// @param agreementHash  SHA-256 dari snapshot isi perjanjian
    /// @param paymentRefHash keccak256 dari provider order ID Midtrans
    function recordDpPayment(
        bytes32 bookingRefHash,
        bytes32 agreementHash,
        bytes32 paymentRefHash
    ) external onlyWriter {
        if (recordedPayments[paymentRefHash]) revert AlreadyRecorded();
        recordedPayments[paymentRefHash] = true;

        bookings[bookingRefHash] = BookingRecord({
            agreementHash: agreementHash,
            status: BookingStatus.DPPaid,
            updatedAt: block.timestamp
        });

        emit BookingStatusUpdated(
            bookingRefHash,
            paymentRefHash,
            agreementHash,
            BookingStatus.DPPaid,
            block.timestamp
        );
    }

    /// @notice Catat pelunasan dan update status menjadi FinalPaid
    function recordFinalPayment(
        bytes32 bookingRefHash,
        bytes32 agreementHash,
        bytes32 paymentRefHash
    ) external onlyWriter {
        if (recordedPayments[paymentRefHash]) revert AlreadyRecorded();
        recordedPayments[paymentRefHash] = true;

        bookings[bookingRefHash].status = BookingStatus.FinalPaid;
        bookings[bookingRefHash].updatedAt = block.timestamp;

        emit BookingStatusUpdated(
            bookingRefHash,
            paymentRefHash,
            agreementHash,
            BookingStatus.FinalPaid,
            block.timestamp
        );
    }

    /// @notice Update status siklus hidup booking (misal Completed, Disputed, Resolved)
    function updateStatus(
        bytes32 bookingRefHash,
        BookingStatus newStatus
    ) external onlyWriter {
        if (bookings[bookingRefHash].updatedAt == 0) revert BookingNotFound();
        bookings[bookingRefHash].status = newStatus;
        bookings[bookingRefHash].updatedAt = block.timestamp;

        emit BookingStatusUpdated(
            bookingRefHash,
            bytes32(0),
            bookings[bookingRefHash].agreementHash,
            newStatus,
            block.timestamp
        );
    }

    /// @notice Ambil data status booking (publik, dapat diverifikasi siapa saja)
    function getBooking(bytes32 bookingRefHash) external view returns (
        bytes32 agreementHash,
        BookingStatus status,
        uint256 updatedAt
    ) {
        BookingRecord memory b = bookings[bookingRefHash];
        return (b.agreementHash, b.status, b.updatedAt);
    }
}
