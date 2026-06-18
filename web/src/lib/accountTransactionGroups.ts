export type AccountTransactionGroupKey = "expenses" | "advances" | "settlements" | "income" | "other";

export type GroupableAccountTransaction = {
  id: string;
  date: string;
  type: string;
  reference: string;
  description: string;
  debit: number;
  credit: number;
  classification?: string;
};

export type AccountTransactionGroup<T extends GroupableAccountTransaction> = {
  groupKey: AccountTransactionGroupKey;
  transactions: T[];
  totalAmount: number;
  debitTotal: number;
  creditTotal: number;
  count: number;
};

export const accountTransactionGroupOrder: AccountTransactionGroupKey[] = [
  "expenses",
  "advances",
  "settlements",
  "income",
  "other",
];

const normalize = (value: string) => value.trim().toLowerCase().replaceAll(/[\s-]+/g, "_");

export const classifyAccountTransaction = (transaction: GroupableAccountTransaction): AccountTransactionGroupKey => {
  const source = normalize(transaction.classification ?? transaction.type ?? "");
  const fallback = normalize(`${transaction.reference} ${transaction.description}`);

  if (/(expense|expenses|voucher|expenditure)/.test(source) || /(expense|voucher|expenditure)/.test(fallback)) return "expenses";
  if (/(advance|labour_advance|worker_advance)/.test(source) || /(advance)/.test(fallback)) return "advances";
  if (/(settlement|partner_settlement|labour_settlement|payment)/.test(source) || /(settlement|payment)/.test(fallback)) return "settlements";
  if (/(sale|sales|income|fund|capital_injection|partner_injection|receipt|contribution)/.test(source)
    || /(sale|sales|income|fund|capital|contribution|receipt)/.test(fallback)) return "income";
  return "other";
};

export function groupAccountTransactions<T extends GroupableAccountTransaction>(transactions: T[]) {
  const groups = new Map<AccountTransactionGroupKey, AccountTransactionGroup<T>>();
  for (const groupKey of accountTransactionGroupOrder) {
    groups.set(groupKey, {
      groupKey,
      transactions: [],
      totalAmount: 0,
      debitTotal: 0,
      creditTotal: 0,
      count: 0,
    });
  }

  for (const transaction of transactions) {
    const groupKey = classifyAccountTransaction(transaction);
    const group = groups.get(groupKey)!;
    group.transactions.push(transaction);
    group.count += 1;
    group.debitTotal += transaction.debit;
    group.creditTotal += transaction.credit;
    group.totalAmount += transaction.credit - transaction.debit;
  }

  return accountTransactionGroupOrder
    .map((groupKey) => groups.get(groupKey)!)
    .map((group) => ({
      ...group,
      transactions: [...group.transactions].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)),
    }));
}

export const defaultTransactionGroupExpansion = (): Record<AccountTransactionGroupKey, boolean> => ({
  expenses: true,
  advances: true,
  settlements: true,
  income: true,
  other: false,
});
