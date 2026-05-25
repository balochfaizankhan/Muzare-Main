import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SubpageHeader } from "../components/SubpageHeader";
import {
  ensureLocalAccounts,
  makeLocalRecord,
  offlineDb,
  queueMutation,
  type Account,
  type Attendance,
  type Dispatch,
  type Labourer,
  type PartnerEntry,
  type Sale,
  type Voucher,
} from "../lib/offline-db";

export type ModuleKey = "workforce" | "expenses" | "sales" | "dispatch" | "accounts" | "partnerLedger";

const today = () => new Date().toISOString().slice(0, 10);
const money = (amount: number) => new Intl.NumberFormat("en", { style: "currency", currency: "SAR" }).format(amount);

function useData<T>(load: () => Promise<T[]>, setup?: () => Promise<void>) {
  const [records, setRecords] = useState<T[]>([]);
  const refresh = useCallback(async () => {
    if (setup) await setup();
    setRecords(await load());
  }, [load, setup]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return [records, refresh] as const;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="empty-records">{children}</p>;
}

function FormCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="record-panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function WorkforceModule() {
  const loadLabourers = useCallback(() => offlineDb.labourers.orderBy("createdAt").reverse().toArray(), []);
  const loadAttendance = useCallback(() => offlineDb.attendance.orderBy("createdAt").reverse().toArray(), []);
  const [labourers, refreshLabourers] = useData(loadLabourers);
  const [attendance, refreshAttendance] = useData(loadAttendance);
  const [name, setName] = useState("");
  const [group, setGroup] = useState("General");
  const [wage, setWage] = useState("");
  const [labourerId, setLabourerId] = useState("");
  const [date, setDate] = useState(today());
  const [status, setStatus] = useState<Attendance["status"]>("present");

  useEffect(() => {
    if (!labourerId && labourers[0]) setLabourerId(labourers[0].id);
  }, [labourerId, labourers]);

  const addLabourer = async (event: FormEvent) => {
    event.preventDefault();
    const record: Labourer = { ...makeLocalRecord(), name: name.trim(), group: group.trim() || "General", dailyWage: Number(wage) };
    await offlineDb.labourers.add(record);
    await queueMutation("labourer", record);
    setName("");
    setWage("");
    await refreshLabourers();
  };

  const markAttendance = async (event: FormEvent) => {
    event.preventDefault();
    if (!labourerId) return;
    const existing = await offlineDb.attendance.where("labourerId").equals(labourerId).filter((entry) => entry.date === date).first();
    const record: Attendance = existing ? { ...existing, status } : { ...makeLocalRecord(), labourerId, date, status };
    await offlineDb.attendance.put(record);
    await queueMutation("attendance", record);
    await refreshAttendance();
  };

  const names = new Map(labourers.map((labourer) => [labourer.id, labourer.name]));

  return (
    <>
      <div className="form-grid">
        <FormCard title="Add labourer">
          <form className="module-form" onSubmit={(event) => void addLabourer(event)}>
            <input required placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />
            <input required placeholder="Group" value={group} onChange={(event) => setGroup(event.target.value)} />
            <input required min="0" step="0.01" type="number" placeholder="Daily wage" value={wage} onChange={(event) => setWage(event.target.value)} />
            <button type="submit">Add labourer</button>
          </form>
        </FormCard>
        <FormCard title="Daily attendance">
          <form className="module-form" onSubmit={(event) => void markAttendance(event)}>
            <select required value={labourerId} onChange={(event) => setLabourerId(event.target.value)}>
              <option value="">Select labourer</option>
              {labourers.map((labourer) => <option key={labourer.id} value={labourer.id}>{labourer.name}</option>)}
            </select>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            <select value={status} onChange={(event) => setStatus(event.target.value as Attendance["status"])}>
              <option value="present">Present</option>
              <option value="half_day">Half day</option>
              <option value="absent">Absent</option>
            </select>
            <button type="submit" disabled={!labourers.length}>Save attendance</button>
          </form>
        </FormCard>
      </div>
      <section className="record-panel">
        <h2>Labour register</h2>
        {!labourers.length ? <Empty>No labourers recorded yet.</Empty> : (
          <div className="record-list">
            {labourers.map((labourer) => <article key={labourer.id}><strong>{labourer.name}</strong><span>{labourer.group} | {money(labourer.dailyWage)} / day</span></article>)}
          </div>
        )}
      </section>
      <section className="record-panel">
        <h2>Recent attendance</h2>
        {!attendance.length ? <Empty>No attendance marked yet.</Empty> : (
          <div className="record-list">
            {attendance.map((entry) => <article key={entry.id}><strong>{names.get(entry.labourerId) ?? "Labourer"}</strong><span>{entry.date} | {entry.status.replace("_", " ")}</span></article>)}
          </div>
        )}
      </section>
    </>
  );
}

function ExpensesModule() {
  const load = useCallback(() => offlineDb.vouchers.orderBy("createdAt").reverse().toArray(), []);
  const loadAccounts = useCallback(() => offlineDb.accounts.toArray(), []);
  const [vouchers, refresh] = useData(load);
  const [accounts] = useData(loadAccounts, ensureLocalAccounts);
  const [date, setDate] = useState(today());
  const [category, setCategory] = useState("Operations");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("local-cash");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const record: Voucher = {
      ...makeLocalRecord(), voucherNumber: `V-${Date.now().toString().slice(-6)}`, date, category,
      description: description.trim(), amount: Number(amount), accountId,
    };
    await offlineDb.vouchers.add(record);
    await queueMutation("voucher", record);
    setDescription("");
    setAmount("");
    await refresh();
  };
  const total = vouchers.reduce((sum, item) => sum + item.amount, 0);

  return (
    <>
      <FormCard title="New expense voucher">
        <form className="module-form inline-form" onSubmit={(event) => void submit(event)}>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          <input required value={category} placeholder="Category" onChange={(event) => setCategory(event.target.value)} />
          <input required value={description} placeholder="Description" onChange={(event) => setDescription(event.target.value)} />
          <input required min="0.01" step="0.01" type="number" value={amount} placeholder="Amount" onChange={(event) => setAmount(event.target.value)} />
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
          <button type="submit">Save voucher</button>
        </form>
      </FormCard>
      <Summary value={money(total)} label="Total expenses" />
      <RecordTable empty="No vouchers recorded yet." rows={vouchers.map((item) => [item.voucherNumber, item.date, item.category, item.description, money(item.amount)])} />
    </>
  );
}

function DispatchModule() {
  const load = useCallback(() => offlineDb.dispatches.orderBy("createdAt").reverse().toArray(), []);
  const [records, refresh] = useData(load);
  const [date, setDate] = useState(today());
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [driverName, setDriverName] = useState("");
  const [produceType, setProduceType] = useState("");
  const [cartons, setCartons] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const record: Dispatch = { ...makeLocalRecord(), date, vehicleNumber, driverName, produceType, cartons: Number(cartons) };
    await offlineDb.dispatches.add(record);
    await queueMutation("dispatch", record);
    setVehicleNumber(""); setDriverName(""); setProduceType(""); setCartons("");
    await refresh();
  };

  return (
    <>
      <FormCard title="New dispatch">
        <form className="module-form inline-form" onSubmit={(event) => void submit(event)}>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          <input required placeholder="Vehicle number" value={vehicleNumber} onChange={(event) => setVehicleNumber(event.target.value)} />
          <input required placeholder="Driver name" value={driverName} onChange={(event) => setDriverName(event.target.value)} />
          <input required placeholder="Produce type" value={produceType} onChange={(event) => setProduceType(event.target.value)} />
          <input required type="number" min="1" placeholder="Cartons" value={cartons} onChange={(event) => setCartons(event.target.value)} />
          <button type="submit">Save dispatch</button>
        </form>
      </FormCard>
      <Summary label="Total dispatched cartons" value={String(records.reduce((sum, item) => sum + item.cartons, 0))} />
      <RecordTable empty="No dispatches recorded yet." rows={records.map((item) => [item.date, item.vehicleNumber, item.driverName, item.produceType, `${item.cartons} cartons`])} />
    </>
  );
}

function SalesModule() {
  const load = useCallback(() => offlineDb.sales.orderBy("createdAt").reverse().toArray(), []);
  const loadAccounts = useCallback(() => offlineDb.accounts.toArray(), []);
  const [sales, refresh] = useData(load);
  const [accounts] = useData(loadAccounts, ensureLocalAccounts);
  const [date, setDate] = useState(today());
  const [buyerName, setBuyerName] = useState("");
  const [produceType, setProduceType] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [accountId, setAccountId] = useState("local-cash");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const record: Sale = { ...makeLocalRecord(), date, buyerName, produceType, quantity: Number(quantity), unitPrice: Number(unitPrice), amount: Number(quantity) * Number(unitPrice), accountId };
    await offlineDb.sales.add(record);
    await queueMutation("sale", record);
    setBuyerName(""); setProduceType(""); setQuantity(""); setUnitPrice("");
    await refresh();
  };

  return (
    <>
      <FormCard title="New sale entry">
        <form className="module-form inline-form" onSubmit={(event) => void submit(event)}>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          <input required placeholder="Buyer name" value={buyerName} onChange={(event) => setBuyerName(event.target.value)} />
          <input required placeholder="Produce type" value={produceType} onChange={(event) => setProduceType(event.target.value)} />
          <input required type="number" min="1" placeholder="Quantity" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
          <input required type="number" min="0" step="0.01" placeholder="Unit price" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} />
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
          <button type="submit">Save sale</button>
        </form>
      </FormCard>
      <Summary label="Total sales" value={money(sales.reduce((sum, item) => sum + item.amount, 0))} />
      <RecordTable empty="No sales recorded yet." rows={sales.map((item) => [item.date, item.buyerName, item.produceType, `${item.quantity} x ${money(item.unitPrice)}`, money(item.amount)])} />
    </>
  );
}

function PartnerLedgerModule() {
  const load = useCallback(() => offlineDb.partnerEntries.orderBy("createdAt").reverse().toArray(), []);
  const loadAccounts = useCallback(() => offlineDb.accounts.toArray(), []);
  const [entries, refresh] = useData(load);
  const [accounts] = useData(loadAccounts, ensureLocalAccounts);
  const [date, setDate] = useState(today());
  const [partnerName, setPartnerName] = useState("");
  const [type, setType] = useState<PartnerEntry["type"]>("contribution");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [accountId, setAccountId] = useState("local-partner");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const record: PartnerEntry = { ...makeLocalRecord(), date, partnerName, type, amount: Number(amount), notes, accountId };
    await offlineDb.partnerEntries.add(record);
    await queueMutation("partnerEntry", record);
    setPartnerName(""); setAmount(""); setNotes("");
    await refresh();
  };
  const balance = entries.reduce((sum, item) => sum + (item.type === "contribution" ? item.amount : -item.amount), 0);

  return (
    <>
      <FormCard title="Record partner entry">
        <form className="module-form inline-form" onSubmit={(event) => void submit(event)}>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          <input required placeholder="Partner name" value={partnerName} onChange={(event) => setPartnerName(event.target.value)} />
          <select value={type} onChange={(event) => setType(event.target.value as PartnerEntry["type"])}>
            <option value="contribution">Contribution</option>
            <option value="withdrawal">Withdrawal</option>
          </select>
          <input required type="number" min="0.01" step="0.01" placeholder="Amount" value={amount} onChange={(event) => setAmount(event.target.value)} />
          <input placeholder="Notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
          <button type="submit">Save entry</button>
        </form>
      </FormCard>
      <Summary label="Partner balance" value={money(balance)} />
      <RecordTable empty="No partner entries recorded yet." rows={entries.map((item) => [item.date, item.partnerName, item.type, item.notes || "-", money(item.type === "withdrawal" ? -item.amount : item.amount)])} />
    </>
  );
}

function AccountsModule() {
  const loadAccounts = useCallback(() => offlineDb.accounts.orderBy("createdAt").toArray(), []);
  const loadVouchers = useCallback(() => offlineDb.vouchers.toArray(), []);
  const loadSales = useCallback(() => offlineDb.sales.toArray(), []);
  const loadEntries = useCallback(() => offlineDb.partnerEntries.toArray(), []);
  const [accounts, refresh] = useData(loadAccounts, ensureLocalAccounts);
  const [vouchers] = useData(loadVouchers);
  const [sales] = useData(loadSales);
  const [entries] = useData(loadEntries);
  const [name, setName] = useState("");
  const [type, setType] = useState<Account["type"]>("bank");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const record: Account = { ...makeLocalRecord(), name, type };
    await offlineDb.accounts.add(record);
    await queueMutation("account", record);
    setName("");
    await refresh();
  };
  const balance = (id: string) =>
    sales.filter((record) => record.accountId === id).reduce((sum, record) => sum + record.amount, 0)
    - vouchers.filter((record) => record.accountId === id).reduce((sum, record) => sum + record.amount, 0)
    + entries.filter((record) => record.accountId === id).reduce((sum, record) => sum + (record.type === "contribution" ? record.amount : -record.amount), 0);

  return (
    <>
      <FormCard title="Create account">
        <form className="module-form compact-form" onSubmit={(event) => void submit(event)}>
          <input required placeholder="Account name" value={name} onChange={(event) => setName(event.target.value)} />
          <select value={type} onChange={(event) => setType(event.target.value as Account["type"])}>
            <option value="cash">Cash</option><option value="bank">Bank</option><option value="partner">Partner</option>
          </select>
          <button type="submit">Create account</button>
        </form>
      </FormCard>
      <section className="record-panel">
        <h2>Your accounts</h2>
        <div className="account-grid">
          {accounts.map((account) => (
            <article key={account.id}>
              <span>{account.type}</span>
              <strong>{account.name}</strong>
              <b>{money(balance(account.id))}</b>
            </article>
          ))}
        </div>
      </section>
      <Summary
        label="Net operating position"
        value={money(sales.reduce((sum, item) => sum + item.amount, 0) - vouchers.reduce((sum, item) => sum + item.amount, 0))}
      />
    </>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return <section className="summary-card"><span>{label}</span><strong>{value}</strong></section>;
}

function RecordTable({ empty, rows }: { empty: string; rows: string[][] }) {
  return (
    <section className="record-panel">
      <h2>Recent records</h2>
      {!rows.length ? <Empty>{empty}</Empty> : (
        <div className="record-list">
          {rows.map((row, index) => <article key={`${row[0]}-${index}`}>{row.map((cell, item) => item === 0 ? <strong key={cell}>{cell}</strong> : <span key={`${cell}-${item}`}>{cell}</span>)}</article>)}
        </div>
      )}
    </section>
  );
}

const descriptions: Record<ModuleKey, string> = {
  workforce: "Attendance, wages, advances, and labour registers.",
  expenses: "Vouchers, invoices, categories, and expense reporting.",
  sales: "Market revenue and sales collection.",
  dispatch: "Vehicle movement and produce carton dispatch.",
  accounts: "Balances calculated from your local transactions.",
  partnerLedger: "Partner contributions, withdrawals, and running balances.",
};

export function ModulePage({ module }: { module: ModuleKey }) {
  const { t } = useTranslation();

  return (
    <div className="dashboard-page">
      <SubpageHeader title={t(module)} />
      <main className="subpage module-workspace">
        <section className="workspace-intro">
          <div>
            <h2>{t(module)}</h2>
            <p>{descriptions[module]}</p>
          </div>
          <span className="local-pill">Local data</span>
        </section>
        {module === "workforce" && <WorkforceModule />}
        {module === "expenses" && <ExpensesModule />}
        {module === "dispatch" && <DispatchModule />}
        {module === "sales" && <SalesModule />}
        {module === "accounts" && <AccountsModule />}
        {module === "partnerLedger" && <PartnerLedgerModule />}
      </main>
    </div>
  );
}
