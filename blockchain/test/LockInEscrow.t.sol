// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../contracts/LockInEscrow.sol";

interface Vm {
    function prank(address caller) external;
    function expectRevert(bytes4 revertSelector) external;
}

contract LockInEscrowTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    LockInEscrow private escrow;

    bytes32 private constant BOOKING = keccak256("LI-TEST-001");
    bytes32 private constant AGREEMENT = keccak256("agreement-snapshot");
    bytes32 private constant DP_PAYMENT = keccak256("payment-dp");
    bytes32 private constant FINAL_PAYMENT = keccak256("payment-final");
    bytes32 private constant LEGACY_TX = keccak256("legacy-dp-transaction");
    address private constant LEGACY_CONTRACT = address(0xD00D);
    address private constant UNAUTHORIZED = address(0xBAD);

    function setUp() public {
        escrow = new LockInEscrow(address(this));
    }

    function testNormalDpThenFinalKeepsAgreementHash() public {
        escrow.recordDpPayment(BOOKING, AGREEMENT, DP_PAYMENT);
        escrow.recordFinalPayment(BOOKING, AGREEMENT, FINAL_PAYMENT);

        (bytes32 agreementHash, LockInEscrow.BookingStatus status,) = escrow.getBooking(BOOKING);
        require(agreementHash == AGREEMENT, "agreement hash changed");
        require(status == LockInEscrow.BookingStatus.FinalPaid, "not FinalPaid");
        require(escrow.recordedPayments(DP_PAYMENT), "DP ref missing");
        require(escrow.recordedPayments(FINAL_PAYMENT), "FINAL ref missing");
    }

    function testFinalRequiresDpAndMatchingAgreement() public {
        vm.expectRevert(LockInEscrow.InvalidBookingState.selector);
        escrow.recordFinalPayment(BOOKING, AGREEMENT, FINAL_PAYMENT);

        escrow.recordDpPayment(BOOKING, AGREEMENT, DP_PAYMENT);
        vm.expectRevert(LockInEscrow.AgreementHashMismatch.selector);
        escrow.recordFinalPayment(BOOKING, keccak256("different-agreement"), FINAL_PAYMENT);
    }

    function testDuplicateDpAndFinalPaymentsAreRejected() public {
        escrow.recordDpPayment(BOOKING, AGREEMENT, DP_PAYMENT);
        vm.expectRevert(LockInEscrow.AlreadyRecorded.selector);
        escrow.recordDpPayment(BOOKING, AGREEMENT, DP_PAYMENT);
        vm.expectRevert(LockInEscrow.InvalidBookingState.selector);
        escrow.recordDpPayment(BOOKING, AGREEMENT, keccak256("second-dp"));

        escrow.recordFinalPayment(BOOKING, AGREEMENT, FINAL_PAYMENT);
        vm.expectRevert(LockInEscrow.AlreadyRecorded.selector);
        escrow.recordFinalPayment(BOOKING, AGREEMENT, FINAL_PAYMENT);
        vm.expectRevert(LockInEscrow.InvalidBookingState.selector);
        escrow.recordFinalPayment(BOOKING, AGREEMENT, keccak256("second-final"));
    }

    function testUnauthorizedWriterCannotRecordOrMigrate() public {
        vm.expectRevert(LockInEscrow.Unauthorized.selector);
        vm.prank(UNAUTHORIZED);
        escrow.recordDpPayment(BOOKING, AGREEMENT, DP_PAYMENT);

        vm.expectRevert(LockInEscrow.Unauthorized.selector);
        vm.prank(UNAUTHORIZED);
        escrow.migrateLegacyDpPayment(BOOKING, AGREEMENT, DP_PAYMENT, LEGACY_CONTRACT, LEGACY_TX);
    }

    function testLegacyDpMigrationAllowsFinalAndIsExplicitlyTracked() public {
        escrow.migrateLegacyDpPayment(BOOKING, AGREEMENT, DP_PAYMENT, LEGACY_CONTRACT, LEGACY_TX);

        (bytes32 agreementHash, LockInEscrow.BookingStatus status,) = escrow.getBooking(BOOKING);
        require(agreementHash == AGREEMENT, "migration lost agreement hash");
        require(status == LockInEscrow.BookingStatus.DPPaid, "migration did not seed DP");
        require(escrow.recordedPayments(DP_PAYMENT), "migrated DP ref missing");
        require(escrow.migratedLegacyTransactions(LEGACY_TX), "legacy tx not marked");

        escrow.recordFinalPayment(BOOKING, AGREEMENT, FINAL_PAYMENT);
        (, status,) = escrow.getBooking(BOOKING);
        require(status == LockInEscrow.BookingStatus.FinalPaid, "migrated booking cannot finalize");
    }

    function testLegacyMigrationRejectsDuplicateProofAndPayment() public {
        escrow.migrateLegacyDpPayment(BOOKING, AGREEMENT, DP_PAYMENT, LEGACY_CONTRACT, LEGACY_TX);
        vm.expectRevert(LockInEscrow.AlreadyRecorded.selector);
        escrow.migrateLegacyDpPayment(BOOKING, AGREEMENT, DP_PAYMENT, LEGACY_CONTRACT, keccak256("another-tx"));

        vm.expectRevert(LockInEscrow.LegacyTransactionAlreadyMigrated.selector);
        escrow.migrateLegacyDpPayment(keccak256("other-booking"), AGREEMENT, keccak256("other-payment"), LEGACY_CONTRACT, LEGACY_TX);

        vm.expectRevert(LockInEscrow.AlreadyRecorded.selector);
        escrow.recordDpPayment(keccak256("other-booking"), AGREEMENT, DP_PAYMENT);
    }

    function testLifecycleCannotMoveBackward() public {
        escrow.recordDpPayment(BOOKING, AGREEMENT, DP_PAYMENT);
        vm.expectRevert(LockInEscrow.InvalidBookingState.selector);
        escrow.updateStatus(BOOKING, LockInEscrow.BookingStatus.Completed);

        escrow.recordFinalPayment(BOOKING, AGREEMENT, FINAL_PAYMENT);
        escrow.updateStatus(BOOKING, LockInEscrow.BookingStatus.Completed);
        vm.expectRevert(LockInEscrow.InvalidBookingState.selector);
        escrow.updateStatus(BOOKING, LockInEscrow.BookingStatus.Disputed);
    }

    function testConstructorRejectsZeroWriter() public {
        vm.expectRevert(LockInEscrow.InvalidWriter.selector);
        new LockInEscrow(address(0));
    }
}
