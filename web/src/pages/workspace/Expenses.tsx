import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { ensureExpenseEntryData } from "../../lib/entryDataQueries";
import { markEntryPerformance, measureEntryPerformance, waitForElement } from "../../lib/entryPerformance";
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

    let cancelled = false;
    let hostObserver: MutationObserver | null = null;
    markEntryPerformance("expenses-navigation-start");

    // Reuse the scope-aware TanStack Query cache. Cached data is returned immediately;
    // stale data revalidates in the background without blocking the form surface.
    void ensureExpenseEntryData();

    void waitForElement<HTMLElement>(".expenses-module--form", { maxFrames: 180 }).then((nextHost) => {
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
