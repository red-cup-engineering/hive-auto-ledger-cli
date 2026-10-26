# @red-cup-engineering/hive-auto-ledger-cli

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Composes `@red-cup-engineering/read-hive-account-history-service`, `@red-cup-engineering/read-hive-engine-account-history-service`, and `@red-cup-engineering/derive-hive-account-ledger-service` for one Hive account and range: reads the account's live chain balances and history from both chains, back-derives the range's opening balance from the chain's current balance and the window's own net delta (a two-pass call into the pure derivation service), writes the resulting Beancount ledger, validates it with the in-process `@red-cup-engineering/farolfi` `check` operation, and runs farolfi's `bal` and `valuation` reports over it directly (no shelling out to farolfi's own CLI; both are apps, so importing one from the other is lawful under the house's import-stratification rule).

## Command

~~~sh
node hive-auto-ledger-cli.mjs --account michael561 --out /path/to/michael561.beancount
node hive-auto-ledger-cli.mjs --account emsenn0 --range-start 2026-06-07 --records-dir /var/lib/561/hive-ledgers
~~~

`--range-start` defaults to the account's on-chain creation date (its whole history); `--range-end` defaults to today. Prints one JSON summary (range, transaction/fill counts, the balance comparison against the chain, the ledger check result) followed by farolfi's `bal` and `valuation` report text.

## Operations

~~~js
export function custodyAccountsFor(account)
export async function deriveLedgerForAccount(options, deps)
export function checkLedger(ledgerPath)
export function runFarolfiReport(command, ledgerPath, flags)
export async function runHiveAutoLedger(options, deps)
~~~

`deriveLedgerForAccount` and `runHiveAutoLedger` accept injectable `clientFactory`/`readHiveHistoryImpl`/`readHiveEngineHistoryImpl`/`fetchHiveEngineBalancesImpl`; the latter also accepts `writeFileTextImpl`/`checkLedgerImpl`/`runFarolfiReportImpl` for tests. Production defaults use real history reads and the in-process farolfi checker.

## Installed-package portability and write custody

This package may be imported from a registry, pnpm virtual store or Guix store **without a source checkout**. Importing the package does not resolve or create a writable repository path. The `deriveLedgerForAccount` export does not need a ledger-output directory. A full ledger run with `out` omitted resolves its destination at the time the output is requested, in this order:

1. An explicit `recordsDirectory` option (`--records-dir` at the CLI).
2. `HIVE_AUTO_LEDGER_RECORDS_DIR`.
3. `METROPLAT_WEB_DATA_DIR/records/hive-account-ledger-records` when that environment value is set.

With none of these, pass `out` (`--out`) or the run refuses to write. An installed package must **never** write into its own `node_modules` or `/gnu/store` path. The default filename is `YYYY-MM-DD-<account>-hive-account-ledger.beancount`, with account/date values validated before path construction. No implicit source-root search or install-time migration is performed.

For an isolated consumer use:

~~~js
import { deriveLedgerForAccount, runHiveAutoLedger } from "@red-cup-engineering/hive-auto-ledger-cli";
const ledger = await deriveLedgerForAccount({ account: "emsenn0" }); // network reads; no output directory needed
// To write, supply a destination under the consuming service's authorized custody:
const result = await runHiveAutoLedger({ account: "emsenn0", out: "/authorized/records/emsenn0.beancount" });
~~~

`npm run test:portable` builds an npm archive and imports that **packed file** from a temporary directory without any source-tree manifest, using explicit stubbed dependency imports; it tests portability, destination selection and negative cases without network or real ledger writes. This is a distribution-boundary smoke test, **not** a substitute for the original workspace's full accounting/reconciliation tests or the deployed Guix job's readback. After review the owning npm-workspace publication process must release this package, then the Group Operations installation must actually select that release and re-run chain reconciliation before closing the production incident.

### Exact-source release-candidate qualification

The public `package-portability` workflow distinguishes a mock-backed source smoke
test from the `installed-dependency-consumer` job. The latter packs the real
package twice and byte-compares both archives, installs the candidate in a
fresh Node 24 consumer using the house registry and the **exact direct published
dependency versions** in `package.json`, imports the installed package by name,
and runs all original native accounting, negative and security tests against
that same installed dependency closure without a second expensive installation.

Only after those steps pass does the workflow retain the **same tested archive**,
SHA-256 checksum, exact tested Git commit/tree, workflow-run identity, and the
consumer's real `package-lock.json`, which witnesses its *observed transitive*
dependency versions and integrity selections. The independent
`receive-qualified-package` job checks both retained hashes and source/package
identity. Because transitive dependency versions are selected at install time,
the retained lockfile is evidence of **this execution**, not a claim that a
different later install has the same dependency graph. The retained candidate
is **not** a registry publication, immutable Guix installation, reconciled
accounting record, or accepted consumer outcome. Original release and host
owners still need independent review, authorized publication, exact installation
and a real Group Operations reconciliation receipt.
