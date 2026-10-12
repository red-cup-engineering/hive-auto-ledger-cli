#!/usr/bin/env node
/**
 * hive-auto-ledger-cli — composes read-hive-account-history-service,
 * read-hive-engine-account-history-service, and derive-hive-account-ledger-service for one
 * account and range, writes the ledger, checks it with farolfi, and runs farolfi's balance
 * and valuation reports over it.
 */
import { parseArgs } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileText } from "@red-cup-engineering/computer-file-engineering-services-section/write-file";
import { HiveClient } from "@red-cup-engineering/hive-blockchain-client-service";
import { readHiveAccountHistory } from "@red-cup-engineering/read-hive-account-history-service";
import { readHiveEngineAccountHistory } from "@red-cup-engineering/read-hive-engine-account-history-service";
import { deriveHiveAccountLedger, plainDecimal } from "@red-cup-engineering/derive-hive-account-ledger-service";
import {
  addDecimalStrings,
  negateDecimalString,
  stripUnitSuffix,
} from "@red-cup-engineering/exact-number-data-service/decimal-string";
import { EngineClient } from "@red-cup-engineering/hive-blockchain-client-service/engine.mjs";
import { dispatch, parseCli } from "@red-cup-engineering/farolfi";

/** This app's owning section root (apps/ -> hive-ledger-services-section -> services -> hive-services-section). */
const SECTION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFAULT_HIVE_NODES = ["https://api.hive.blog", "https://api.openhive.network"];
const DEFAULT_HE_NODES = ["https://accounts.hive-engine.com", "https://history.hive-engine.com"];
const DEFAULT_HE_FILL_NODES = ["https://api.hive-engine.com/rpc", "https://api2.hive-engine.com/rpc"];

function capitalized(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The lawful dated-records path for one derived Hive account ledger: a derived ledger is a
 * dated record (never a log), so it lands under this owning section's own `data/records/`,
 * never an invented `data/logs/ledgers/` directory.
 * @param {string} account
 * @param {string} dateStamp - YYYY-MM-DD, normally the derivation's rangeEnd.
 * @returns {string} absolute path
 */
export function defaultLedgerRecordsPath(account, dateStamp) {
  return join(SECTION_ROOT, "data", "records", `${dateStamp}-${account}-hive-account-ledger.beancount`);
}

/** The house per-persona custody account names this section's naming pattern already uses. */
export function custodyAccountsFor(account) {
  const cap = capitalized(account);
  return {
    hive: `Assets:Digital-Assets:Hive:Custody:${cap}`,
    hiveEngine: `Assets:Digital-Assets:HiveEngine:Custody:${cap}`,
  };
}

/**
 * Run one farolfi command over a ledger file in process.
 * @param {string} command - a farolfi command (bal, valuation, check, ...)
 * @param {string} ledgerPath
 * @param {string[]} [flags] - extra farolfi flags, e.g. ["--output", "json"]
 * @returns {{ command: string, exitCode: number, text: string }}
 */
export function runFarolfiReport(command, ledgerPath, flags = []) {
  const parsed = parseCli([command, ledgerPath, ...flags]);
  if (parsed.error) return { command, exitCode: 2, text: parsed.error };
  const { text, exitCode } = dispatch(parsed.command, parsed.files, parsed.options);
  return { command, exitCode, text };
}

/**
 * Check a ledger with farolfi: unbalanced transactions, failed balance assertions and malformed
 * lines are held problems; the ledger checks clean when there are none.
 * @param {string} ledgerPath
 * @returns {{ ok: boolean, report: object }}
 */
export function checkLedger(ledgerPath) {
  const { text } = runFarolfiReport("check", ledgerPath, ["--output", "json"]);
  const report = JSON.parse(text);
  return { ok: report.ok === true, report };
}

/**
 * Compose the two history reads, a two-pass opening-balance derivation, and the final ledger
 * for one account and range.
 * @param {{ account: string, rangeStart?: string, rangeEnd?: string, hiveNodes?: string[],
 *   heNodes?: string[], heFillNodes?: string[] }} options
 * @param {{ clientFactory?: (nodes: string[]) => HiveClient, readHiveHistoryImpl?: typeof readHiveAccountHistory,
 *   readHiveEngineHistoryImpl?: typeof readHiveEngineAccountHistory, fetchHiveEngineBalancesImpl?: (accounts: string[]) => Promise<object[]> }} [deps]
 * @returns {Promise<object>}
 */
export async function deriveLedgerForAccount(options, deps = {}) {
  const {
    account, rangeStart: rangeStartInput, rangeEnd: rangeEndInput,
    hiveNodes = DEFAULT_HIVE_NODES, heNodes = DEFAULT_HE_NODES, heFillNodes = DEFAULT_HE_FILL_NODES,
  } = options;
  const {
    clientFactory = (nodes) => new HiveClient({ nodes }),
    readHiveHistoryImpl = readHiveAccountHistory,
    readHiveEngineHistoryImpl = readHiveEngineAccountHistory,
    fetchHiveEngineBalancesImpl = (accounts) => new EngineClient().getBalances(accounts),
  } = deps;

  const waggle = clientFactory([hiveNodes[0]]);
  const [chainAccount] = await waggle.getAccounts([account]);
  if (!chainAccount) throw new Error(`hive-auto-ledger-cli: account not found on chain: ${account}`);

  const rangeStart = rangeStartInput ?? chainAccount.created.slice(0, 10);
  const rangeEnd = rangeEndInput ?? new Date().toISOString().slice(0, 10);
  const from = rangeStartInput ? { time: `${rangeStart}T00:00:00.000Z` } : undefined;
  const to = { time: `${rangeEnd}T00:00:00.000Z` };

  // Independent reads: run concurrently rather than sequentially (a real wall-clock cost cut,
  // not a workaround) — the mainchain history page-walk and the Hive-Engine REST/fill reads
  // share no state.
  const [hiveHistory, heHistory, heBalanceRows] = await Promise.all([
    readHiveHistoryImpl({ account, nodes: hiveNodes, from, to }),
    readHiveEngineHistoryImpl({ account, nodes: heNodes, fillNodes: heFillNodes, from, to }),
    fetchHiveEngineBalancesImpl([account]),
  ]);
  // Liquid balance only: the custody account this service tracks holds the *liquid* position;
  // staked, pending-unstake, and delegated-out quantities move to their own sub-accounts
  // (derive-hive-account-ledger-service's :Staked/:Pending-Unstake/:Delegated-Out), so comparing
  // this scope against the chain's combined balance+stake figure would be a scope mismatch.
  const hiveEngineChainBalances = {};
  for (const row of heBalanceRows) {
    hiveEngineChainBalances[row.symbol] = plainDecimal(row.balance);
  }

  const custody = custodyAccountsFor(account);
  const chainClosingBalances = {
    hive: stripUnitSuffix(chainAccount.balance),
    hbd: stripUnitSuffix(chainAccount.hbd_balance),
    vests: stripUnitSuffix(chainAccount.vesting_shares),
    hiveEngine: hiveEngineChainBalances,
  };

  const baseInput = {
    account, rangeStart, rangeEnd,
    custodyAccount: custody.hive, hiveEngineCustodyAccount: custody.hiveEngine,
    hiveOperations: hiveHistory.operations, hiveEngineEntries: heHistory.entries, hiveEngineFills: heHistory.fills,
  };

  // A genuine whole-history run (no explicit rangeStart: the caller wants the account's whole
  // life since creation) gets a LITERAL zero opening balance — the only independently honest
  // value, and the one that makes the closing-balance assertion a real check. Back-deriving an
  // opening balance from the chain's current total (chainClosing - thisWindow'sOwnNetDelta) is
  // needed ONLY for a genuinely bounded window that does not reach account creation; done
  // unconditionally, the formula makes the closing assertion trivially true by construction
  // (closing = opening + netDelta = (chainClosing - netDelta) + netDelta = chainClosing, always,
  // regardless of whether netDelta reflects the operations correctly) — a real defect found and
  // fixed 2026-09-05 that let a genuine double-booking bug pass this service's own self-check.
  const isWholeHistory = rangeStartInput === undefined || rangeStartInput === null;
  let openingBalances;
  if (isWholeHistory) {
    openingBalances = { hive: "0", hbd: "0", vests: "0", hiveEngine: Object.fromEntries(Object.keys(hiveEngineChainBalances).map((s) => [s, "0"])) };
  } else {
    const zeroPass = deriveHiveAccountLedger({
      ...baseInput,
      openingBalances: { hive: "0", hbd: "0", vests: "0", hiveEngine: {} },
      chainClosingBalances,
    });
    const netDeltaOf = (acct, commodity) => zeroPass.balanceComparison.find((b) => b.account === acct && b.commodity === commodity)?.computedClosing ?? "0";
    openingBalances = {
      hive: addDecimalStrings([chainClosingBalances.hive, negateDecimalString(netDeltaOf(custody.hive, "HIVE"))]),
      hbd: addDecimalStrings([chainClosingBalances.hbd, negateDecimalString(netDeltaOf(custody.hive, "HBD"))]),
      vests: addDecimalStrings([chainClosingBalances.vests, negateDecimalString(netDeltaOf(custody.hive, "VESTS"))]),
      hiveEngine: Object.fromEntries(
        Object.entries(hiveEngineChainBalances).map(([symbol, chainValue]) => [
          symbol, addDecimalStrings([chainValue, negateDecimalString(netDeltaOf(custody.hiveEngine, symbol))]),
        ]),
      ),
    };
  }

  const ledgerResult = deriveHiveAccountLedger({ ...baseInput, openingBalances, chainClosingBalances });
  const composed = { ledgerResult, hiveHistory, heHistory, chainAccount, chainClosingBalances, openingBalances, custody, rangeStart, rangeEnd };
  // An accounting check cannot establish source coverage. Carry read refusals and the
  // source observations with the export rather than leaving them in a transient result.
  const unresolved = [
    ...(composed.hiveHistory.refusals ?? []).map((detail) => ({ source: "hive-history", detail })),
    ...(composed.heHistory.refusals ?? []).map((detail) => ({ source: "hive-engine-history", detail })),
    ...(composed.ledgerResult.refusals ?? []).map((detail) => ({ source: "ledger-derivation", detail })),
    ...composed.ledgerResult.balanceComparison.filter((row) => !row.match).map((detail) => ({ source: "balance-comparison", detail })),
  ];
  const coverage = { status: unresolved.length ? "unresolved" : "not-established", unresolved };
  const evidence = {
    type: "HiveAccountLedgerEvidence", version: 1,
    account: composed.chainAccount.name, rangeStart: composed.rangeStart, rangeEnd: composed.rangeEnd,
    coverage, hiveHistory: composed.hiveHistory, hiveEngineHistory: composed.heHistory,
    chainAccount: composed.chainAccount, chainClosingBalances: composed.chainClosingBalances,
    openingBalances: composed.openingBalances,
  };
  return { ...composed, coverage, evidence };

}

/**
 * Compose the full lot: derive the ledger, write it, check it with farolfi, and run
 * farolfi's balance/valuation reports over it.
 * @param {{ account: string, rangeStart?: string, rangeEnd?: string, out?: string }} options - when
 *   `out` is omitted, the ledger lands at this section's own lawful dated-records path
 *   (`defaultLedgerRecordsPath`) rather than an invented location; pass `out` only to override
 *   for a test or an ad hoc one-off run.
 * @param {object} [deps] see `deriveLedgerForAccount`
 * @returns {Promise<object>} includes `out`, the path actually written.
 */
export async function runHiveAutoLedger(options, deps = {}) {
  const composed = await deriveLedgerForAccount(options, deps);
  const out = options.out ?? defaultLedgerRecordsPath(composed.chainAccount.name, composed.rangeEnd);
  const { coverage, evidence } = composed;
  // Beancount comments preserve the observation carrier in the same delivered artifact;
  // they are evidence, not postings or an assertion that every resource was accounted for.
  const ledgerText = `${composed.ledgerResult.ledgerText}\n; hive-ledger-evidence ${JSON.stringify(evidence)}\n`;
  await (deps.writeFileTextImpl ?? writeFileText)(out, ledgerText);
  const check = (deps.checkLedgerImpl ?? checkLedger)(out);
  const runFarolfi = deps.runFarolfiReportImpl ?? runFarolfiReport;
  const balance = await runFarolfi("bal", out);
  const valuation = await runFarolfi("valuation", out);
  return { ...composed, out, coverage, evidence, ledgerText, check, balanceReport: balance, valuationReport: valuation };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      account: { type: "string" },
      "range-start": { type: "string" },
      "range-end": { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.account) {
    process.stderr.write("usage: hive-auto-ledger-cli --account <name> [--range-start YYYY-MM-DD] [--range-end YYYY-MM-DD] [--out <path>]\n");
    process.stderr.write("  --out defaults to this section's data/records/<rangeEnd>-<account>-hive-account-ledger.beancount\n");
    process.exit(2);
  }
  try {
    const result = await runHiveAutoLedger({
      account: values.account, rangeStart: values["range-start"], rangeEnd: values["range-end"], out: values.out,
    });
    process.stdout.write(`${JSON.stringify({
      account: result.chainAccount.name,
      rangeStart: result.rangeStart,
      rangeEnd: result.rangeEnd,
      out: result.out,
      transactionCount: result.ledgerResult.transactionCount,
      fillsBooked: result.ledgerResult.fillsBooked,
      balanceComparison: result.ledgerResult.balanceComparison,
      coverage: result.coverage,
      refusalCount: result.coverage.unresolved.length,
      ledgerChecksClean: result.check.ok,
    }, null, 2)}\n`);
    process.stdout.write(`${result.balanceReport.text}\n`);
    process.stdout.write(`${result.valuationReport.text}\n`);
    if (result.coverage.unresolved.length || !result.check.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(2);
  }
}
