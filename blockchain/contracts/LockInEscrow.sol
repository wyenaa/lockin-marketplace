// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LockInEscrow
/// @notice Hash-only audit trail. No payment, token-transfer, or fund-custody methods.
/// @dev Stores off-chain booking/payment references as hashes; it is not a funds escrow.
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

    mapping(bytes32 => BookingRecord) public bookings;
    mapping(bytes32 => bool) public recordedPayments;
    mapping(bytes32 => bool) public migratedLegacyTransactions;

    event BookingStatusUpdated(
        bytes32 indexed bookingRefHash,
        bytes32 indexed paymentRefHash,
        bytes32 agreementHash,
        BookingStatus status,
        uint256 timestamp
    );

    /// @notice Explicit writer attestation linking a legacy DP to its old contract and tx.
    event LegacyDpPaymentMigrated(
        bytes32 indexed bookingRefHash,
        bytes32 indexed paymentRefHash,
        address indexed legacyContract,
        bytes32 legacyTxHash,
        bytes32 agreementHash,
        uint256 timestamp
    );

    error Unauthorized();
    error AlreadyRecorded();
    error InvalidWriter();
    error BookingNotFound();
    error InvalidReference();
    error InvalidAgreementHash();
    error InvalidBookingState();
    error AgreementHashMismatch();
    error InvalidMigrationProof();
    error LegacyTransactionAlreadyMigrated();

    constructor(address writer) {
        if (writer == address(0)) revert InvalidWriter();
        authorizedWriter = writer;
    }

    modifier onlyWriter() {
        if (msg.sender != authorizedWriter) revert Unauthorized();
        _;
    }

    /// @notice Record the first DP on this contract.
    function recordDpPayment(
        bytes32 bookingRefHash,
        bytes32 agreementHash,
        bytes32 paymentRefHash
    ) external onlyWriter {
        _validateReferences(bookingRefHash, agreementHash, paymentRefHash);
        if (recordedPayments[paymentRefHash]) revert AlreadyRecorded();
        BookingRecord storage booking = bookings[bookingRefHash];
        if (booking.status != BookingStatus.None && booking.status != BookingStatus.AgreementLocked)
            revert InvalidBookingState();
        if (booking.status == BookingStatus.AgreementLocked && booking.agreementHash != agreementHash)
            revert AgreementHashMismatch();

        _recordDp(bookingRefHash, agreementHash, paymentRefHash);
    }

    /// @notice Migrate a DP already verified on a legacy contract.
    /// @dev The writer must verify legacyContract and legacyTxHash off-chain before calling.
    ///      The old chain record remains untouched; this creates an explicit attestation here.
    function migrateLegacyDpPayment(
        bytes32 bookingRefHash,
        bytes32 agreementHash,
        bytes32 paymentRefHash,
        address legacyContract,
        bytes32 legacyTxHash
    ) external onlyWriter {
        _validateReferences(bookingRefHash, agreementHash, paymentRefHash);
        if (legacyContract == address(0) || legacyTxHash == bytes32(0)) revert InvalidMigrationProof();
        if (recordedPayments[paymentRefHash]) revert AlreadyRecorded();
        if (migratedLegacyTransactions[legacyTxHash]) revert LegacyTransactionAlreadyMigrated();
        if (bookings[bookingRefHash].status != BookingStatus.None) revert InvalidBookingState();

        migratedLegacyTransactions[legacyTxHash] = true;
        _recordDp(bookingRefHash, agreementHash, paymentRefHash);
        emit LegacyDpPaymentMigrated(
            bookingRefHash,
            paymentRefHash,
            legacyContract,
            legacyTxHash,
            agreementHash,
            block.timestamp
        );
    }

    /// @notice Record FINAL only after the booking has a matching DP on this contract.
    function recordFinalPayment(
        bytes32 bookingRefHash,
        bytes32 agreementHash,
        bytes32 paymentRefHash
    ) external onlyWriter {
        _validateReferences(bookingRefHash, agreementHash, paymentRefHash);
        if (recordedPayments[paymentRefHash]) revert AlreadyRecorded();
        BookingRecord storage booking = bookings[bookingRefHash];
        if (booking.status != BookingStatus.DPPaid) revert InvalidBookingState();
        if (booking.agreementHash != agreementHash) revert AgreementHashMismatch();
        recordedPayments[paymentRefHash] = true;
        booking.status = BookingStatus.FinalPaid;
        booking.updatedAt = block.timestamp;
        emit BookingStatusUpdated(
            bookingRefHash,
            paymentRefHash,
            booking.agreementHash,
            BookingStatus.FinalPaid,
            block.timestamp
        );
    }

    /// @notice Update only forward lifecycle transitions after FINAL.
    function updateStatus(bytes32 bookingRefHash, BookingStatus newStatus) external onlyWriter {
        BookingRecord storage booking = bookings[bookingRefHash];
        if (booking.updatedAt == 0) revert BookingNotFound();

        bool allowed =
            (newStatus == BookingStatus.Completed && booking.status == BookingStatus.FinalPaid) ||
            (newStatus == BookingStatus.Cancelled && (
                booking.status == BookingStatus.AgreementLocked ||
                booking.status == BookingStatus.DPPaid ||
                booking.status == BookingStatus.FinalPaid
            )) ||
            (newStatus == BookingStatus.Disputed && (
                booking.status == BookingStatus.DPPaid ||
                booking.status == BookingStatus.FinalPaid
            )) ||
            (newStatus == BookingStatus.Resolved && booking.status == BookingStatus.Disputed);
        if (!allowed) revert InvalidBookingState();

        booking.status = newStatus;
        booking.updatedAt = block.timestamp;
        emit BookingStatusUpdated(
            bookingRefHash,
            bytes32(0),
            booking.agreementHash,
            newStatus,
            block.timestamp
        );
    }

    /// @notice Public booking status and agreement hash lookup.
    function getBooking(bytes32 bookingRefHash) external view returns (
        bytes32 agreementHash,
        BookingStatus status,
        uint256 updatedAt
    ) {
        BookingRecord memory booking = bookings[bookingRefHash];
        return (booking.agreementHash, booking.status, booking.updatedAt);
    }

    function _recordDp(bytes32 bookingRefHash, bytes32 agreementHash, bytes32 paymentRefHash) private {
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

    function _validateReferences(bytes32 bookingRefHash, bytes32 agreementHash, bytes32 paymentRefHash) private pure {
        if (bookingRefHash == bytes32(0) || paymentRefHash == bytes32(0)) revert InvalidReference();
        if (agreementHash == bytes32(0)) revert InvalidAgreementHash();
    }
}
