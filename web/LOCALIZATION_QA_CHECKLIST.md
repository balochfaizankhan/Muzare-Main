# Muzare Localization QA Checklist

## Languages
- English (`en`)
- Arabic (`ar`, RTL)
- Urdu (`ur`, RTL)

## Global Checks (All Pages)
- Confirm no visible hardcoded English strings in UI controls, headings, cards, modals, toasts, and empty states.
- Confirm language switch updates text without reload.
- Confirm missing translation keys show readable fallback and are logged in development console.
- Confirm `dir="rtl"` for Arabic/Urdu and layout remains usable.
- Confirm dates follow selected locale formatting.
- Confirm SAR amounts render with locale-aware number grouping.

## Page-by-Page

### Authentication
- Login page labels, placeholders, validation, and errors translated.
- Signup flow translated end-to-end.

### Dashboard
- Hero content translated.
- Metric card labels translated.
- Quick actions and operational module cards translated.
- Empty season/farm messages translated.

### Workforce / Attendance
- Daily attendance toolbar and filters translated.
- Labour register search/empty states translated.
- Labour detail actions and success/error toasts translated.
- Attendance report and advance report labels/actions translated.

### Accounts / Partner Ledger
- Headings, forms, tables, empty states translated.
- Financial summary labels translated.

### Expenses / Sales / Dispatch / Inventory
- Form labels and validation translated.
- List/table headers and empty states translated.
- Report/export labels translated.

### Reports / Imports
- Attendance report modal, preview, export actions translated.
- CSV import step labels, warnings, and confirm messages translated.

### Admin
- Admin dashboard labels translated.
- Approvals screen labels, statuses, and action titles translated.

### Settings / Team
- All navigation labels and section labels translated.

## Regression Checks
- Mobile widths `360px` and `390px`: no clipped translated text.
- Long Urdu/Arabic labels do not overlap buttons/icons.
- Print/export views remain readable in each language.
