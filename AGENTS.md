# ShopLedger onboarding

## Architecture overview

ShopLedger is an internal point-of-sale app for a wholesale and retail shop. Staff use it to price carts, record cash and UPI sales, track inventory, print GST invoices, and manage khata (customer credit and repayments).

The stack is Node.js with CommonJS, Express 4, and `body-parser`. The frontend is plain HTML, CSS, and browser JavaScript with no build step. The browser calls JSON endpoints under `/api`. The app stores operational data in a single JSON file.

Start reading at `server.js` for HTTP wiring, `public/js/app.js` for browser behavior, and `routes/orders.js` for checkout. The printable invoice is served separately at `GET /orders/:id/invoice`.

## Module directory

| Path | Responsibility |
| --- | --- |
| `server.js` | Parses JSON, serves `public/`, mounts API routers, and serves printable invoices. Listens when run directly. |
| `config.js` | Port, shop identity, GST defaults and HSN slabs, coupons, and inventory settings. Contains a hardcoded export key. |
| `public/` | Point of sale, order register, khata, and audit screens. `js/app.js` wires UI actions to the API. |
| `routes/` | `products.js` serves catalog and coupons. `orders.js` handles order reads, placement, and cancellation. `customers.js` handles accounts and settlements. `reports.js` serves price preview, dashboard, GST reconciliation, and export. |
| `lib/` | `pricing.js`, `tax.js`, and `coupons.js` calculate checkout totals. `orders.js`, `inventory.js`, and `ledger.js` manage business state. `invoice.js` renders invoices. `reports.js` aggregates and reconciles totals. `dates.js` formats dates and `store.js` handles persistence and audit entries. |
| `data/` | `db.json` holds products, orders, customers, settlements, audit entries, and ID counters. It is tracked in Git and doubles as the runtime store. |

## Critical business workflows

1. **Preview and place an order.** The browser calls `POST /api/pricing/preview` for estimates, then submits to `POST /api/orders`. Checkout reloads the store, resolves product details and prices from the catalog, parses quantities, checks stock, and validates the coupon. Pricing allocates the discount across lines and computes GST on discounted amounts. A khata sale charges the registered customer's account after checking their credit limit.
2. **Deduct stock and persist.** Sellable stock is physical stock minus reserved units, floored at zero. Despite its name, `inventory.reserve()` deducts physical stock immediately, including for pending-dispatch orders. Checkout assigns an order ID, records the sale and its totals, appends an audit entry, rewrites the store, and returns HTTP 201.
3. **Open a printable invoice.** The invoice route loads the saved order and passes it to `lib/invoice.js`, which recomputes tax and discount before rendering HTML. Checkout uses HSN rates and taxes discounted lines. The invoice taxes gross lines, falls back to the default rate when the saved line lacks an explicit rate, and consults current coupon settings. Use the GST reconciliation report to compare the printed figures with the stored order totals.

## Dangerous traps and technical debt

- **Hardcoded secret and limited access control.** `config.js` contains `adminKey`. The export handler accepts it in the URL query, where it can end up in logs or history. Treat the value as exposed and keep it out of examples and logs. The app itself has no login protecting routine reads or writes. The order register also renders saved customer names as raw HTML.
- **Synchronous, non-atomic writes with no concurrency control.** `lib/store.js` rewrites all of `data/db.json` with `writeFileSync`. Independent processes can overwrite each other's changes. Interruption during a write can damage the file.
- **Zero existing automated tests.** `npm test` is a placeholder that exits with an error. Record the specific checks performed when changing business logic.
- **Stock edge cases.** The stock check rejects a request for exactly the remaining sellable quantity and checks repeated product lines individually. Cancellation looks up `productId` while checkout saves `id`, and the release path adjusts reservations instead of restoring physical stock.
- **Settlement arithmetic.** The browser sends the settlement amount as a string, and adding it directly to `totalSettled` can concatenate values instead of adding them numerically.
- **Date ordering.** The order register sorts and filters day-first date strings lexicographically. Results can be wrong across month or year boundaries.

## Golden rules for agents and developers

- **Run in an isolated copy.** Use a disposable checkout or copy with its own scrubbed `data/db.json` for local smoke tests and write flows. The store path is relative to the source, so changing the working directory alone won't redirect it. Run one process in that copy on a trusted local machine. With dependencies present, `npm start` runs `node server.js`. The port defaults to `3000` and can be set with `PORT`. The startup log says localhost, but the code does not bind explicitly to loopback.
- **Keep dependency changes deliberate.** Use `npm ci` in the isolated copy when an install is needed and permitted. Review `package.json` and `package-lock.json` together for intentional upgrades. Avoid broad installs or automatic audit fixes during unrelated work. Check the team's deployed Node version before changing dependencies because the manifest has no `engines` field.
- **Keep the tracked database untouched.** Leave `data/db.json` out of edits, staging, and commits. Exercise checkout, cancellation, and settlement against disposable data. Check `git status --short` and `git diff HEAD -- data/db.json` before handing off or committing changes.
- **Verify the downstream effects of business changes.** For checkout or cancellation changes, compare the persisted order, physical stock, khata balance, and audit entry. For pricing changes, compare preview, checkout, and invoice figures, including mixed GST rates and coupons.
