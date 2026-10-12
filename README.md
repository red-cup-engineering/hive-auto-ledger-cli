# @red-cup-engineering/hive-auto-ledger-cli

Composes `@red-cup-engineering/read-hive-account-history-service`, `@red-cup-engineering/read-hive-engine-account-history-service`, and `@red-cup-engineering/derive-hive-account-ledger-service` for one Hive account and range: reads the account's live chain balances and history from both chains, back-derives the range's opening balance from the chain's current balance and the window's own net delta (a two-pass call into the pure derivation service), writes the resulting Beancount ledger, proves it with `bean-check` through the repo's pinned Guix shell, and runs `@red-cup-engineering/farolfi`'s `bal` and `valuation` reports over it directly (no shelling out to farolfi's own CLI; both are apps, so importing one from the other is lawful under the house's import-stratification rule).

## Command

~~~sh
node hive-auto-ledger-cli.mjs --account michael561 --out /path/to/michael561.beancount
node hive-auto-ledger-cli.mjs --account emsenn0 --range-start 2026-06-07 --out /path/to/emsenn0.beancount
~~~

`--range-start` defaults to the account's on-chain creation date (its whole history); `--range-end` defaults to today. Prints one JSON summary (range, transaction/fill counts, the balance comparison against the chain, `bean-check`'s exit code) followed by farolfi's `bal` and `valuation` report text.

## Operations

~~~js
export function custodyAccountsFor(account)
export async function deriveLedgerForAccount(options, deps)
export async function runBeanCheck(ledgerPath, options)
export async function runHiveAutoLedger(options, deps)
~~~

`deriveLedgerForAccount` and `runHiveAutoLedger` accept an injectable `waggleFactory`/`readHiveHistoryImpl`/`readHiveEngineHistoryImpl`/`fetchHiveEngineBalancesImpl`/`runBeanCheckImpl`/`writeFileTextImpl` for tests; production use defaults to the real network reads.
