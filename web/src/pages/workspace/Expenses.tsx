import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { ensureLocalAccounts } from "../../lib/offline-db";
import { markEntryPerformance, measureEntryPerformance, waitForElement } from "../../lib/entryPerformance";
import { ModulePage } from "../ModulePage";
import "./ExpensesWarmup.css";

let accountsWarmupPromise: Promise<void> | null = null;
const warmAccountsOnce = () => {
  accountsWarmupPromise ??= ensureLocalAccounts().then(() => undefined);
  return accountsWarmupPromise;
};

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

    let cancelled = false;
    let hostObserver: MutationObserver | null = null;
    markEntryPerformance("expenses-navigation-start");

    // Initialise local accounts once. The actual form loader can reuse the same
    // IndexedDB state instead of starting a duplicate full account collection read.
    void warmAccountsOnce();

    void waitForElement<HTMLElement>(".expenses-module--form", { maxFrames: 120 }).then((nextHost) => {
      if (cancelled || !nextHost) return;
      setHost(nextHost);

      const inspect = () => {
        const ready = Boolean(nextHost.querySelector(".expense-voucher-form"));
        setFormReady(ready);
        if (ready) {
          markEntryPerformance("expenses-form-mounted");
          measureEntryPerformance("expenses-navigation-to-form", "expenses-navigation-start", "expenses-form-mounted");
          hostObserver?.disconnect();
        }
      };

      inspect();
      if (!nextHost.querySelector(".expense-voucher-form")) {
        hostObserver = new MutationObserver(inspect);
        hostObserver.observe(nextHost, { childList: true, subtree: true });
      }
    });

    return () => {
      cancelled = true;
      hostObserver?.disconnect();
    };
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
