const money = (value: number) => Number(value.toFixed(2));

export type FundingAttributionPart = {
  id: string;
  settlementType: "DIRECT_PAYMENT" | "APPLIED_ADVANCE";
  accountId: string | null;
  accountName: string;
  accountType: string | null;
  amount: number;
  voucherId: string | null;
  advanceApplicationId: string | null;
};

export type FundingSourcePart = Pick<FundingAttributionPart, "accountId" | "accountName" | "accountType" | "amount">;

export function groupFundingSources(parts: FundingSourcePart[]): FundingSourcePart[] {
  const grouped = new Map<string, FundingSourcePart>();
  for (const part of parts) {
    const key = part.accountId ? `account:${part.accountId}` : `unresolved:${part.accountName}`;
    const current = grouped.get(key);
    if (current) current.amount = money(current.amount + part.amount);
    else grouped.set(key, { ...part, amount: money(part.amount) });
  }
  return [...grouped.values()].sort((left, right) => left.accountName.localeCompare(right.accountName));
}

export type ExpenseAttributionRow = Omit<FundingAttributionPart, "settlementType"> & {
  dueId: string;
  dueNumber: string | null;
  date: string;
  settlementType: "DIRECT_PAYMENT" | "APPLIED_ADVANCE" | "ACCRUED_PAYABLE";
};

export function attributeLabourExpense(args: {
  dueId: string;
  dueNumber: string | null;
  date: string;
  expenseAmount: number;
  parts: FundingAttributionPart[];
  accruedAccountName?: string;
}): ExpenseAttributionRow[] {
  const grouped = new Map<string, ExpenseAttributionRow>();
  for (const part of args.parts) {
    const key = `${part.settlementType}:${part.accountId ?? part.accountName}`;
    const current = grouped.get(key);
    if (current) current.amount = money(current.amount + part.amount);
    else grouped.set(key, { ...part, dueId: args.dueId, dueNumber: args.dueNumber, date: args.date, amount: money(part.amount) });
  }
  const settled = [...grouped.values()].reduce((sum, row) => sum + row.amount, 0);
  const outstanding = money(Math.max(args.expenseAmount - settled, 0));
  if (outstanding > 0.005) {
    grouped.set("ACCRUED_PAYABLE:canonical", {
      id: `${args.dueId}:accrued`, dueId: args.dueId, dueNumber: args.dueNumber, date: args.date,
      settlementType: "ACCRUED_PAYABLE", accountId: null,
      accountName: args.accruedAccountName ?? "Accrued labour payable", accountType: "liability",
      amount: outstanding, voucherId: null, advanceApplicationId: null,
    });
  }
  return [...grouped.values()];
}

export function fundingAttributionTotal(rows: Array<{ amount: number }>) {
  return money(rows.reduce((sum, row) => sum + row.amount, 0));
}
