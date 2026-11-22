export function hasCompleteSimulatedFunds({ booking, successfulPayments, heldEntries }) {
  const price = Number(booking?.price);
  const deposit = Math.max(0, Number(booking?.deposit) || 0);
  const expectedFunds = price + deposit;
  const paid = Number(booking?.paid);
  const successfulAmount = successfulPayments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  const heldAmount = heldEntries.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
  const paymentsMatchLedger = successfulPayments.every(payment => {
    const matching = heldEntries.filter(entry => entry.payment_id === payment.id);
    return Boolean(payment.id) && Number(payment.amount) > 0 && matching.length === 1 && Number(matching[0].amount) === Number(payment.amount);
  }) && heldEntries.length === successfulPayments.length && heldEntries.every(entry =>
    Boolean(successfulPayments.find(payment => payment.id === entry.payment_id)) && Number(entry.amount) > 0
  );

  return Number.isSafeInteger(price) && price > 0 && Number.isSafeInteger(expectedFunds) &&
    paid === expectedFunds && successfulAmount === expectedFunds && heldAmount === expectedFunds && paymentsMatchLedger;
}
