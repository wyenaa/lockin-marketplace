
 // SPDX-License-Identifier: MIT
 pragma solidity ^0.8.24;

 contract LockInFinalPaymentLog {
     address public immutable authorizedWriter;

     mapping(bytes32 => bool) public recordedPayments;

     event FinalPaymentRecorded(
         bytes32 indexed bookingRefHash,
         bytes32 indexed paymentRefHash,
         bytes32 agreementHash,
         uint256 recordedAt
     );

     error Unauthorized();
     error AlreadyRecorded();
     error InvalidWriter();

     constructor(address writer) {
         if (writer == address(0)) revert InvalidWriter();
         authorizedWriter = writer;
     }

     function recordFinalPayment(
         bytes32 bookingRefHash,
         bytes32 agreementHash,
         bytes32 paymentRefHash
     ) external {
         if (msg.sender != authorizedWriter)
             revert Unauthorized();

         if (recordedPayments[paymentRefHash])
             revert AlreadyRecorded();

         recordedPayments[paymentRefHash] = true;

         emit FinalPaymentRecorded(
             bookingRefHash,
             paymentRefHash,
             agreementHash,
             block.timestamp
         );
     }
 }
