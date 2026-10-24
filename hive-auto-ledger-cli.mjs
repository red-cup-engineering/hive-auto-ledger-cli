#!/usr/bin/env node
/**
 * hive-auto-ledger-cli — composes read-hive-account-history-service,
 * read-hive-engine-account-history-service, and derive-hive-account-ledger-service for one
 * account and range, writes the ledger, checks it with farolfi, and runs farolfi's balance
 * and valuation reports over it.
 */
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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

const DEFAULT_HIVE_NODES = ["https://api.hive.blog", "https://api.openhive.network"];
const DEFAULT_HE_NODES = ["https://accounts.hive-engine.com", "https://history.hive-engine.com"];
const DEFAULT_HE_FILL_NODES = ["https://api.hive-engine.com/rpc", "https://api2.hive-engine.com/rpc"];

function capitalized(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function requireHiveAccount(account) {
  if (typeof account !== "string" || !/^[a-z][a-z0-9.-]{2,15}$/.test(account)) {
    throw new TypeError("hive-auto-ledger-cli: invalid Hive account name for records path");
  }
}

function requireLedgerDate(dateStamp) {
  if (typeof dateStamp !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStamp) ||
      !Number.isFinite(Date.parse(`${dateStamp}T00:00:00.000Z`)) ||
      new Date(`${dateStamp}T00:00:00.000Z`).toISOString().slice(0, 10) !== dateStamp) {
    throw new TypeError("hive-auto-ledger-cli: records date must be a valid YYYY-MM-DD");
  }
}

/**
 * Resolve the dated-record output directory ONLY when an output is requested.
 * The installed package must never infer a writable enterprise records directory from
 * its location in a pnpm/Guix/npm store. An explicit directory wins; otherwise use
 * HIVE_AUTO_LEDGER_RECORDS_DIR or the already-configured MetroPlat web-data records area.
 * @param {string} account - Hive account name, not a filesystem path
 * @param {string} dateStamp - YYYY-MM-DD
 * @param {{ recordsDirectory?: string, environment?: Record<string,string|undefined> }} [options]
 * @returns {string} absolute path
 */
export function defaultLedgerRecordsPath(account, dateStamp, {
  recordsDirectory,
  environment = process.env,
} = {}) {
  requireHiveAccount(account);
  requireLedgerDate(dateStamp);
  const dir = recordsDirectory ?? environment?.HIVE_AUTO_LEDGER_RECORDS_DIR ??
    (environment?.METROPLAT_WEB_DATA_DIR ?
      join(environment.METROPLAT_WEB_DATA_DIR, "records", "hive-account-ledger-records") : undefined);
  if (typeof dir !== "string" || !dir.trim()) {
    throw new TypeError("hive-auto-ledger-cli: specify --out, --records-dir, HIVE_AUTO_LEDGER_RECORDS_DIR, or METROPLAT_WEB_DATA_DIR");
  }
  return join(resolve(dir), `${dateStamp}-${account}-hive-account-ledger.beancount`);
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
  // Invalid account/range inputs must not start a network or history query,
  // including when this API is imported without any output destination.
  requireHiveAccount(account);
  const selectedRangeEnd = rangeEndInput ?? new Date().toISOString().slice(0, 10);
  requireLedgerDate(selectedRangeEnd);
  if (rangeStartInput !== undefined && rangeStartInput !== null) {
    requireLedgerDate(rangeStartInput);
    if (rangeStartInput > selectedRangeEnd) {
      throw new RangeError("hive-auto-ledger-cli: range start is after range end");
    }
  }
  const {
    clientFactory = (nodes) => new HiveClient({ nodes }),
    readHiveHistoryImpl = readHiveAccountHistory,
    readHiveEngineHistoryImpl = readHiveEngineAccountHistory,
    fetchHiveEngineBalancesImpl = (accounts) => new EngineClient().getBalances(accounts),
  } = deps;

  const waggle = clientFactory([hiveNodes[0]]);
  const [chainAccount] = await waggle.getAccounts([account]);
  if (!chainAccount) throw new Error(`hive-auto-ledger-cli: account not found on chain: ${account}`);
  // Do not mix balance evidence for an unrelated wallet with history fetched
  // for the requested identity. Treat mismatched provider responses as refused
  // source admission before the parallel history/Engine reads start.
  if (chainAccount.name !== account) {
    throw new Error("hive-auto-ledger-cli: account identity mismatch from chain provider");
  }

  const rangeStart = rangeStartInput ?? chainAccount.created.slice(0, 10);
  const rangeEnd = selectedRangeEnd;
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
  if (hiveHistory?.account !== undefined && hiveHistory.account !== account) throw new Error("hive-auto-ledger-cli: Hive history account identity mismatch");
  if (heHistory?.account !== undefined && heHistory.account !== account) throw new Error("hive-auto-ledger-cli: Hive-Engine history account identity mismatch");
  if (!Array.isArray(hiveHistory?.operations)) throw new TypeError("hive-auto-ledger-cli: invalid Hive history response");
  if (!Array.isArray(heHistory?.entries) || !Array.isArray(heHistory?.fills)) throw new TypeError("hive-auto-ledger-cli: invalid Hive-Engine history response");
  // Liquid balance only: the custody account this service tracks holds the *liquid* position;
  // staked, pending-unstake, and delegated-out quantities move to their own sub-accounts
  // (derive-hive-account-ledger-service's :Staked/:Pending-Unstake/:Delegated-Out), so comparing
  // this scope against the chain's combined balance+stake figure would be a scope mismatch.
  // Hive Engine's balances table carries an account field on every row.
  // A partial or misrouted provider response must not contaminate this wallet's
  // closing balances or the accounting evidence that will be written to disk.
  if (!Array.isArray(heBalanceRows)) {
    throw new TypeError("hive-auto-ledger-cli: invalid Hive-Engine balances response");
  }
  // The provider's balances table is keyed by (account, symbol). A repeated
  // symbol is disputed source evidence, never an instruction to select the
  // last row as this wallet's closing balance. Use a Map while admitting rows
  // so even JavaScript object-prototype property names cannot defeat the
  // duplicate check or silently disappear from the result.
  const balancesBySymbol = new Map();
  for (const row of heBalanceRows) {
    if (!row || row.account !== account) {
      throw new Error("hive-auto-ledger-cli: Hive-Engine account identity mismatch from balances provider");
    }
    if (typeof row.symbol !== "string" || !row.symbol.trim()) {
      throw new TypeError("hive-auto-ledger-cli: invalid Hive-Engine balance symbol");
    }
    if (balancesBySymbol.has(row.symbol)) {
      throw new Error("hive-auto-ledger-cli: duplicate Hive-Engine balance for one symbol");
    }
    balancesBySymbol.set(row.symbol, plainDecimal(row.balance));
  }
  const hiveEngineChainBalances = Object.fromEntries(balancesBySymbol);

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
 * @param {{ account: string, rangeStart?: string, rangeEnd?: string, out?: string,
 *   recordsDirectory?: string, environment?: Record<string,string|undefined> }} options
 *   Supply `out` or a configured records directory for installation-independent writes.
 * @param {object} [deps] see `deriveLedgerForAccount`
 * @returns {Promise<object>} includes `out`, the path actually written.
 */
export async function runHiveAutoLedger(options, deps = {}) {
  // Refuse an unselected output before provider RPCs, two history page-walks,
  // Hive-Engine balance queries, or ledger derivation. A result with nowhere
  // to go is not an authorized reason to consume those external resources.
  // Reuse the existing source-owned output policy, without changing the
  // eventual filename derived from the independently read chain account.
  if (options?.out === undefined || options.out === null) {
    defaultLedgerRecordsPath(options?.account, options?.rangeEnd ?? new Date().toISOString().slice(0, 10), {
      recordsDirectory: options?.recordsDirectory,
      environment: options?.environment ?? process.env,
    });
  } else if (typeof options.out !== "string" || !options.out.trim()) {
    throw new TypeError("hive-auto-ledger-cli: --out must be a nonempty file path");
  }
  const composed = await deriveLedgerForAccount(options, deps);
  const out = options.out ?? defaultLedgerRecordsPath(composed.chainAccount.name, composed.rangeEnd, {
    recordsDirectory: options.recordsDirectory, environment: options.environment ?? process.env,
  });
  const { coverage, evidence } = composed;
  // Keep the original incomplete-evidence export contract: a NEW file can
  // carry admitted coverage gaps, with the CLI reporting nonzero acceptance.
  // However, an unresolved reading is never authority to REPLACE an earlier
  // independently received ledger. Fail early when one already exists, and
  // retain exclusive-creation semantics for the final write to close races.
  const hasUnresolvedSourceEvidence = coverage.unresolved.length > 0;
  if (hasUnresolvedSourceEvidence && existsSync(out)) {
    const sources = [...new Set(coverage.unresolved.map((item) => item.source))].sort().join(", ");
    throw new Error(`hive-auto-ledger-cli: unresolved source evidence (${coverage.unresolved.length}; ${sources}); refusing to replace existing ledger`);
  }
  // Beancount comments preserve the observation carrier in the same delivered artifact;
  // they are evidence, not postings or an assertion that every resource was accounted for.
  const ledgerText = `${composed.ledgerResult.ledgerText}\n; hive-ledger-evidence ${JSON.stringify(evidence)}\n`;
  // Financial evidence is not accepted merely because it can be written. Both
  // accounting checks and reports must succeed against the exact candidate
  // BEFORE publishing it at the caller's committed destination.
  //
  // Keep the candidate beside the destination: Farolfi includes are resolved
  // relative to the journal, and a source-store ancestor is never implied.
  // The original file writer owns exclusive, durable, atomic file creation.
  const candidate = join(dirname(out), `.${basename(out)}.${randomUUID()}.candidate.beancount`);
  const write = deps.writeFileTextImpl ?? writeFileText;
  const runFarolfi = deps.runFarolfiReportImpl ?? runFarolfiReport;
  let ownsCandidate = false;
  try {
    await write(candidate, ledgerText, { flag: "wx" });
    ownsCandidate = true;
    const check = await (deps.checkLedgerImpl ?? checkLedger)(candidate);
    if (check?.ok !== true) {
      throw new Error("hive-auto-ledger-cli: ledger check failed");
    }
    const balance = await runFarolfi("bal", candidate);
    if (balance?.exitCode !== 0) {
      throw new Error(`hive-auto-ledger-cli: farolfi bal report failed (exit code ${String(balance?.exitCode)})`);
    }
    const valuation = await runFarolfi("valuation", candidate);
    if (valuation?.exitCode !== 0) {
      throw new Error(`hive-auto-ledger-cli: farolfi valuation report failed (exit code ${String(valuation?.exitCode)})`);
    }
    // Use the original source-owned atomic writer for the final replacement:
    // it preserves existing permissions and filesystem durability semantics.
    // Do not rename here and silently bypass that source-owned contract.
    try {
      // If the source is incomplete, only create a NEW observation carrier.
      // Another writer may have published accepted evidence after our early
      // existence check; the original writer's exclusive flag protects it.
      await write(out, ledgerText, hasUnresolvedSourceEvidence ? { flag: "wx" } : undefined);
    } catch (error) {
      if (hasUnresolvedSourceEvidence && error?.code === "EEXIST") {
        throw new Error("hive-auto-ledger-cli: unresolved source evidence; refusing to replace existing ledger", { cause: error });
      }
      throw error;
    }
    return { ...composed, out, coverage, evidence, ledgerText, check, balanceReport: balance, valuationReport: valuation };
  } finally {
    // An unsuccessful exclusive create cannot establish ownership; never
    // delete a path the writer did not explicitly report it had published.
    if (ownsCandidate) await rm(candidate, { force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      account: { type: "string" },
      "range-start": { type: "string" },
      "range-end": { type: "string" },
      out: { type: "string" },
      "records-dir": { type: "string" },
    },
  });
  if (!values.account) {
    process.stderr.write("usage: hive-auto-ledger-cli --account <name> [--range-start YYYY-MM-DD] [--range-end YYYY-MM-DD] [--out <path> | --records-dir <directory>]\n");
    process.stderr.write("  Without --out, set --records-dir, HIVE_AUTO_LEDGER_RECORDS_DIR, or METROPLAT_WEB_DATA_DIR.\n");
    process.exit(2);
  }
  try {
    const result = await runHiveAutoLedger({
      account: values.account, rangeStart: values["range-start"], rangeEnd: values["range-end"],
      out: values.out, recordsDirectory: values["records-dir"],
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
