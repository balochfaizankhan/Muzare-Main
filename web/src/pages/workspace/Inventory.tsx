import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Boxes, Plus, Search, X } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { config } from "../../config";
import { useAuth } from "../../auth/AuthProvider";
import { hasModulePermission } from "../../lib/permissions";
import { getActiveFarmId, getActiveSeasonId, makeLocalRecord, offlineDb, workspaceRecords, type InventoryEntry } from "../../lib/offline-db";
import { persistOperationalRecord } from "../../services/syncService";
import "./Inventory.css";

type Movement = "receive" | "use";
const formatQuantity = (n: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(n);
const normalized = (s: string) => s.trim().replace(/\s+/g, " ");
const keyFor = (name: string) => normalized(name).toLocaleLowerCase();

export function Inventory() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [records, setRecords] = useState<InventoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"stock" | "history">("stock");
  const [editing, setEditing] = useState<InventoryEntry | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [kind, setKind] = useState<Movement>("receive");
  const [date, setDate] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [itemName, setItemName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const canCreate = Boolean(user && hasModulePermission(user, "inventory", "create"));
  const canEdit = Boolean(user && hasModulePermission(user, "inventory", "edit"));
  const farmId = getActiveFarmId();
  const seasonId = getActiveSeasonId();

  const reload = useCallback(async () => {
    try {
      const rows = await workspaceRecords(offlineDb.inventoryEntries);
      setRecords(rows.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)));
      setError("");
    } catch {
      setError(t("inventoryPage.loadError", { defaultValue: "Inventory could not be loaded. Please refresh." }));
    } finally {
      setLoading(false);
    }
  }, [farmId, seasonId, t]);

  useEffect(() => {
    setLoading(true);
    void reload();
    const refresh = () => { void reload(); };
    window.addEventListener("muzare-local-data-change", refresh);
    window.addEventListener("muzare-data-refresh", refresh);
    window.addEventListener("muzare-farm-changed", refresh);
    window.addEventListener("muzare-season-changed", refresh);
    return () => {
      window.removeEventListener("muzare-local-data-change", refresh);
      window.removeEventListener("muzare-data-refresh", refresh);
      window.removeEventListener("muzare-farm-changed", refresh);
      window.removeEventListener("muzare-season-changed", refresh);
    };
  }, [reload]);

  const balances = useMemo(() => {
    const map = new Map<string, { name: string; balance: number; received: number; used: number; movements: number }>();
    for (const record of records) {
      const key = keyFor(record.itemName);
      if (!key) continue;
      const row = map.get(key) ?? { name: normalized(record.itemName), balance: 0, received: 0, used: 0, movements: 0 };
      row.balance += record.quantity;
      if (record.quantity >= 0) row.received += record.quantity;
      else row.used += Math.abs(record.quantity);
      row.movements += 1;
      map.set(key, row);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [records]);
  const filteredBalances = balances.filter((row) => row.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const filteredRecords = records.filter((row) => row.itemName.toLocaleLowerCase().includes(search.toLocaleLowerCase()) || row.notes?.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const pendingCount = records.filter((row) => row.pendingSync).length;
  const usedCount = records.filter((row) => row.quantity < 0).length;

  const openNew = (movement: Movement) => {
    setEditing(null);
    setKind(movement);
    setDate(new Date().toLocaleDateString("en-CA"));
    setItemName("");
    setQuantity("");
    setNotes("");
    setError("");
    setFormOpen(true);
  };
  const openEdit = (record: InventoryEntry) => {
    setEditing(record);
    setKind(record.quantity < 0 ? "use" : "receive");
    setDate(record.date);
    setItemName(record.itemName);
    setQuantity(String(Math.abs(record.quantity)));
    setNotes(record.notes ?? "");
    setError("");
    setFormOpen(true);
  };
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const qty = Number(quantity);
    if (!normalized(itemName) || !date || !Number.isFinite(qty) || qty <= 0) {
      setError(t("inventoryPage.validation", { defaultValue: "Enter an item, date and quantity greater than zero." }));
      return;
    }
    if (editing && !canEdit || !editing && !canCreate) {
      setError(t("inventoryPage.permissionError", { defaultValue: "You do not have permission to save inventory." }));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const record: InventoryEntry = editing
        ? { ...editing, date, itemName: normalized(itemName), quantity: kind === "use" ? -qty : qty, notes: notes.trim() }
        : { ...makeLocalRecord(), date, itemName: normalized(itemName), quantity: kind === "use" ? -qty : qty, notes: notes.trim() };
      await persistOperationalRecord("inventoryEntry", record);
      setFormOpen(false);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("inventoryPage.saveError", { defaultValue: "Unable to save inventory entry." }));
    } finally {
      setSaving(false);
    }
  };

  if (!config.featureInventory) {
    return <main className="shell-page">
      <section className="shell-page__intro">
        <span className="eyebrow">{t("layout.farmOperations")}</span>
        <h1>{t("inventoryPage.disabledTitle")}</h1>
        <p>{t("inventoryPage.disabledDescription")}</p>
      </section>
      <section className="panel admin-empty-panel">
        <h2>{t("inventoryPage.disabledTitle")}</h2>
        <p>{t("inventoryPage.disabledDescription")}</p>
        <Link className="inventory-disabled__action" to="/workspace/dashboard">{t("inventoryPage.backToDashboard")}</Link>
      </section>
    </main>;
  }
  return <main className="shell-page inventory-page">
    <header className="inventory-hero">
      <div>
        <span className="eyebrow">{t("layout.farmOperations")}</span>
        <h1><Boxes size={26} aria-hidden="true" /> {t("layout.inventory", { defaultValue: "Inventory" })}</h1>
        <p>{t("inventoryPage.stockDescription", { defaultValue: "Track farm supplies received and used, by farm and season." })}</p>
      </div>
      {canCreate && <button type="button" className="inventory-primary" onClick={() => openNew("receive")}><Plus size={18} /> {t("inventoryPage.addEntry", { defaultValue: "New entry" })}</button>}
    </header>
    {!farmId || !seasonId ? <section className="panel inventory-empty">{t("inventoryPage.selectContext", { defaultValue: "Select a farm and season to manage inventory." })}</section> : <>
      <section className="inventory-stats" aria-label={t("inventoryPage.overview", { defaultValue: "Inventory overview" })}>
        <article><span>{t("inventoryPage.items", { defaultValue: "Stock items" })}</span><strong>{balances.length}</strong></article>
        <article><span>{t("inventoryPage.movements", { defaultValue: "Movements" })}</span><strong>{records.length}</strong></article>
        <article><span>{t("inventoryPage.usage", { defaultValue: "Usage entries" })}</span><strong>{usedCount}</strong></article>
        <article><span>{t("inventoryPage.pending", { defaultValue: "Pending sync" })}</span><strong>{pendingCount}</strong></article>
      </section>
      <div className="inventory-toolbar">
        <div className="inventory-tabs">
          <button type="button" className={tab === "stock" ? "is-active" : ""} onClick={() => setTab("stock")}>{t("inventoryPage.stock", { defaultValue: "Stock balances" })}</button>
          <button type="button" className={tab === "history" ? "is-active" : ""} onClick={() => setTab("history")}>{t("inventoryPage.history", { defaultValue: "History" })}</button>
        </div>
        <label className="inventory-search"><Search size={17} /><input aria-label={t("common.search", { defaultValue: "Search" })} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("inventoryPage.search", { defaultValue: "Search items…" })} /></label>
      </div>
      {error && !formOpen && <p role="alert" className="inventory-error">{error}</p>}
      {loading ? <section className="panel inventory-empty">{t("common.loading", { defaultValue: "Loading…" })}</section> : tab === "stock" ? (
        <section className="inventory-list" aria-label={t("inventoryPage.stock", { defaultValue: "Stock balances" })}>
          {filteredBalances.length === 0 ? <div className="panel inventory-empty">{t("inventoryPage.noItems", { defaultValue: "No stock items yet. Record supplies received to get started." })}</div> : filteredBalances.map((row) => <article className="inventory-row" key={keyFor(row.name)}>
            <div><strong>{row.name}</strong><small>{row.movements} {t("inventoryPage.movements", { defaultValue: "movements" })}</small></div>
            <div className="inventory-row__balance"><strong className={row.balance < 0 ? "inventory-negative" : ""}>{formatQuantity(row.balance)}</strong><small>{t("inventoryPage.onHand", { defaultValue: "On hand" })}</small></div>
          </article>)}
        </section>
      ) : <section className="inventory-list">
        {filteredRecords.length === 0 ? <div className="panel inventory-empty">{t("inventoryPage.noHistory", { defaultValue: "No inventory entries found." })}</div> : filteredRecords.map((row) => <article className="inventory-row" key={row.id}>
          <div><strong>{row.itemName}</strong><small>{row.date}{row.notes ? ` · ${row.notes}` : ""}{row.pendingSync ? " · Pending sync" : ""}</small></div>
          <div className="inventory-row__balance"><strong className={row.quantity < 0 ? "inventory-negative" : ""}>{row.quantity > 0 ? "+" : "−"}{formatQuantity(Math.abs(row.quantity))}</strong>{canEdit && <button type="button" onClick={() => openEdit(row)}>{t("common.edit", { defaultValue: "Edit" })}</button>}</div>
        </article>)}
      </section>}
      {canCreate && <div className="inventory-quick-actions"><button type="button" onClick={() => openNew("receive")}><ArrowDownToLine size={18}/>{t("inventoryPage.receive", { defaultValue: "Receive stock" })}</button><button type="button" onClick={() => openNew("use")}><ArrowUpFromLine size={18}/>{t("inventoryPage.use", { defaultValue: "Record usage" })}</button></div>}
    </>}
    {formOpen && <div className="inventory-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) setFormOpen(false); }}>
      <section className="inventory-dialog" role="dialog" aria-modal="true" aria-labelledby="inventory-form-title">
        <header><h2 id="inventory-form-title">{editing ? t("inventoryPage.editEntry", { defaultValue: "Edit inventory entry" }) : t("inventoryPage.addEntry", { defaultValue: "New inventory entry" })}</h2><button type="button" aria-label={t("common.close", { defaultValue: "Close" })} onClick={() => setFormOpen(false)} disabled={saving}><X size={20}/></button></header>
        <form onSubmit={(e) => void save(e)}>
          <div className="inventory-tabs"><button type="button" className={kind === "receive" ? "is-active" : ""} onClick={() => setKind("receive")}>{t("inventoryPage.receive", { defaultValue: "Receive stock" })}</button><button type="button" className={kind === "use" ? "is-active" : ""} onClick={() => setKind("use")}>{t("inventoryPage.use", { defaultValue: "Record usage" })}</button></div>
          <label>{t("inventoryPage.itemName", { defaultValue: "Item name" })}<input required maxLength={160} value={itemName} onChange={(e) => setItemName(e.target.value)} list="inventory-item-options" autoComplete="off" placeholder={t("inventoryPage.itemPlaceholder", { defaultValue: "e.g. Fertilizer" })} /></label>
          <datalist id="inventory-item-options">{balances.map((row) => <option value={row.name} key={keyFor(row.name)} />)}</datalist>
          <div className="inventory-form-grid"><label>{t("common.date", { defaultValue: "Date" })}<input required type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label><label>{t("inventoryPage.quantity", { defaultValue: "Quantity" })}<input required type="number" min="0.001" step="any" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label></div>
          <label>{t("common.notes", { defaultValue: "Notes" })}<textarea rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          {error && <p role="alert" className="inventory-error">{error}</p>}
          <div className="inventory-dialog__footer"><button type="button" onClick={() => setFormOpen(false)} disabled={saving}>{t("common.cancel", { defaultValue: "Cancel" })}</button><button type="submit" className="inventory-primary" disabled={saving}>{saving ? t("common.saving", { defaultValue: "Saving…" }) : t("common.save", { defaultValue: "Save entry" })}</button></div>
        </form>
      </section>
    </div>}
  </main>;
}
