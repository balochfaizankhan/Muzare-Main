# Labour reconciliation architecture audit

This document records the temporary reconciliation surface added under Workforce → Labour Payments. It does not retire or remove any legacy module or model.

## Authoritative sources and storage

| Concept | Storage/entity | Current API |
| --- | --- | --- |
| Individual, group, foreman/leader, task, piece-rate, lump-sum, imported and Labour Work Ledger earnings | `operational_records`, `entity_type = 'labourEarning'`; scope and historical snapshots are held in `payload` | Operational sync `/v1/workspace/operational-records`; history `/v1/workspace/:workspaceId/labour-reconciliation/earnings` |
| Attendance source rows and locks | `operational_records`, `entity_type = 'attendance'`; canonical attendance also uses `attendance_entries` | Operational sync and attendance APIs |
| Attendance, labour-work, and mixed settlement headers; embedded member/detail snapshots | `operational_records`, `entity_type = 'labourWageSettlement'`; `payload.includedLabourRows`, `sourceAttendanceIds`, and linked earning IDs carry historical detail | `/v1/workspace/:workspaceId/labour-wage-settlements/*`; history `/v1/workspace/:workspaceId/labour-reconciliation/settlements` |
| Legacy settlement advance allocation | `labour_wage_settlement_advance_allocations` | Settlement create/void APIs; cleanup preview/execute |
| Settlement idempotency/create lifecycle | `labour_wage_settlement_create_requests` | Settlement create/status APIs; cleanup preview/execute |
| Unified payable obligations created by migration 0035 or current posting | `labour_dues` | `/v1/workspace/:workspaceId/labour-payments/dues` and reconciliation APIs |
| Labour payment, advance, refund and reversal vouchers | `labour_payment_vouchers` | `/v1/workspace/:workspaceId/labour-payments/*` |
| Due payment allocations | `labour_payment_allocations` | Labour Payments posting/void APIs |
| Advance applications | `labour_advance_applications` | Labour Payments posting/void APIs |
| Normalized labour subledger postings | `labour_accounting_entries` | Labour Payments and reconciliation APIs |
| Cash/bank/partner account effects | `account_transactions` joined to `accounts`; partner positions are derived from partner accounts and operational partner entries | Account and accounting reconciliation APIs |
| Legacy settlement-generated generic vouchers | `operational_records`, `entity_type = 'voucher'`; older normalized voucher headers/details also exist in `vouchers` and `voucher_items` | Operational sync and expense search; cleanup follows settlement-linked operational vouchers |
| Offline queued writes | Browser IndexedDB `pendingMutations`, with cached `labourEarnings` and `labourWageSettlements` stores | `syncService` and operational sync |
| Permanent anti-recreation markers | `labour_cleanup_tombstones` | Checked by operational sync; migration 0035 cannot backfill a hard-deleted source because its source query no longer finds the operational record |
| Minimal hard-delete trace | `labour_cleanup_logs` | Cleanup execute only; intentionally excluded from business reports |

Voided and reversed state is represented both by source payload status/deletion fields and normalized `payment_status`, voucher `status`, allocation/application `status`, reversal references, and reversal accounting entries. History queries intentionally use left joins and include null legacy farm/season fields so inactive or missing recipients remain inspectable.

## Reconciliation and cleanup APIs

- `GET .../labour-reconciliation/earnings`: authoritative, filtered, server-paginated earning history and integrity summary.
- `GET .../labour-reconciliation/settlements`: authoritative, filtered, server-paginated settlement history and dependency summary.
- `GET .../labour-reconciliation/cleanup/selection`: resolves all matching or source-only-eligible IDs on the server; it never presents a loaded page as the full selection.
- `POST .../labour-reconciliation/cleanup/preview`: resolves dependencies and classifies delete, unlock, remain, cascade, and blocking effects on the server.
- `POST .../labour-reconciliation/cleanup/execute`: owner or explicit `wages.delete` permission, advisory lock, typed confirmations, and one database transaction.

Full cascade refuses shared payment vouchers. It deletes allocations before exclusively linked vouchers and dues, removes only advance-application rows (preserving independent advance vouchers and their original cash effects), removes settlement create requests, preserves and unlocks attendance, preserves unselected earnings, writes cleanup logs and tombstones, and then removes selected sources. Any failure rolls back the transaction.

## Payments Due deduplication

`Payments Due` reads normalized `labour_dues`, not raw earnings plus settlements. A source can contribute at most one due through the unique source-record constraint and migration idempotency key. The query excludes voided/reversed/deleted sources, voided or fully cleared dues, missing source rows, and cleanup tombstones. An earning linked to a settlement is represented only through the settlement due; an approved standalone earning is represented through its own due. Therefore the same economic obligation is never added once as an earning and again as a settlement.

## Scope note

The historical counts requested for a production-like copy must be collected from the target database after migration 0037. This repository contains no production database credentials or bundled production snapshot. The integration database is isolated and test-generated, so its post-suite totals are not presented as business-data audit results.
