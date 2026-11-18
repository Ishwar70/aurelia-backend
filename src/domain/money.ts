/** Commerce money is integer paise. Display converts at the edge. */

export function rupeesToMinor(rupees: number): number {
  return Math.round(rupees * 100);
}

export function includedGstMinor(grossMinor: number, rate = 18): number {
  if (grossMinor <= 0) return 0;
  return Math.round((grossMinor * rate) / (100 + rate));
}

export function formatInr(minor: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(minor / 100);
}

/** Split a discount across lines. The last line absorbs the remainder. */
export function allocateDiscount(lineTotals: number[], discount: number): number[] {
  const sum = lineTotals.reduce((total, value) => total + value, 0);
  if (discount <= 0 || sum <= 0) return lineTotals.map(() => 0);
  const capped = Math.min(discount, sum);
  let allocated = 0;
  return lineTotals.map((total, index) => {
    if (index === lineTotals.length - 1) return capped - allocated;
    const share = Math.floor((capped * total) / sum);
    allocated += share;
    return share;
  });
}

export function unitPriceMinor(pricing: { listMinor: number; saleMinor: number | null }): number {
  return pricing.saleMinor ?? pricing.listMinor;
}
