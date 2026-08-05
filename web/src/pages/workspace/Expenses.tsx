import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { ensureLocalAccounts, offlineDb, workspaceRecords } from "../../lib/offline-db";
import { ModulePage } from "../ModulePage";
import "./ExpensesWarmup.css";

function ExpenseFormWarmup() {
  const location = useLocation();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [formReady, setFormReady] = useState(false);
  const isNewVoucher = location.pathname.endsWith("/new");

  useEffect(() => {
    if (!isNewVoucher) {
      setHost(null);
      setFormReady(false);
      return;
    }

    // Start the IndexedDB/account setup in parallel with session refresh so the real
    // voucher form has less work left when permissions resolve.
    void Promise.allSettled([
      ensureLocalAccounts(),
      workspaceRecords(offlineDb.accounts, { includeImportedAcrossSeasons: true }),
    ]);

    const inspect = () => {
      const nextHost = document.querySelector<HTMLElement>(".expenses-module--form");
      setHost(nextHost);
      setFormReady(Boolean(nextHost?.querySelector(".expense-voucher-form")));
    };

    inspect();
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [isNewVoucher]);

  if (!isNewVoucher || !host || formReady) return null;
  return createPortal(
    <section className="expense-form-warmup" role="status" aria-label="Loading voucher form">
      <div className="expense-form-warmup__heading">
        <span className="expense-form-warmup__skeleton expense-form-warmup__title" />
        <span className="expense-form-warmup__skeleton expense-form-warmup__number" />
      </div>
      <div className="expense-form-warmup__grid">
        <span className="expense-form-warmup__skeleton expense-form-warmup__field" />
        <span className="expense-form-warmup__skeleton expense-form-warmup__field" />
        <span className="expense-form-warmup__skeleton expense-form-warmup__field expense-form-warmup__field--wide" />
        <span className="expense-form-warmup__skeleton expense-form-warmup__field" />
        <span className="expense-form-warmup__skeleton expense-form-warmup__field" />
      </div>
      <div className="expense-form-warmup__item">
        <span className="expense-form-warmup__skeleton expense-form-warmup__line" />
        <span className="expense-form-warmup__skeleton expense-form-warmup__field" />
        <span className="expense-form-warmup__skeleton expense-form-warmup__field" />
      </div>
    </section>,
    host,
  );
}

export function Expenses() {
  return (
    <>
      <ModulePage module="expenses" />
      <ExpenseFormWarmup />
    </>
  );
}
