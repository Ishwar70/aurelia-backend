import type { Balance } from "./types";

export const RESERVATION_TTL_MINUTES = 15;

export function recomputeAvailable(balance: Balance): Balance {
  return {
    ...balance,
    availableToSell: Math.max(0, balance.onHand - balance.reserved - balance.safetyStock),
  };
}

/** Returns the next balance, or null when the requested quantity is not available. */
export function reserveQuantity(balance: Balance, qty: number): Balance | null {
  if (qty <= 0 || balance.availableToSell < qty) return null;
  return {
    ...balance,
    reserved: balance.reserved + qty,
    availableToSell: balance.availableToSell - qty,
    version: balance.version + 1,
  };
}

export function commitQuantity(balance: Balance, qty: number): Balance {
  return recomputeAvailable({
    ...balance,
    onHand: balance.onHand - qty,
    reserved: Math.max(0, balance.reserved - qty),
    version: balance.version + 1,
  });
}

export function releaseQuantity(balance: Balance, qty: number): Balance {
  return recomputeAvailable({
    ...balance,
    reserved: Math.max(0, balance.reserved - qty),
    version: balance.version + 1,
  });
}

export function adjustOnHand(balance: Balance, delta: number): Balance | null {
  const onHand = balance.onHand + delta;
  if (onHand < balance.reserved || onHand < 0) return null;
  return recomputeAvailable({ ...balance, onHand, version: balance.version + 1 });
}
