export const formatMoney = (amount: number) =>
  new Intl.NumberFormat("en", {
    style: "currency",
    currency: "SAR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
