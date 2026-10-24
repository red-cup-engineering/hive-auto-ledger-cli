import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  custodyAccountsFor,
  defaultLedgerRecordsPath,
  deriveLedgerForAccount,
  checkLedger,
  runFarolfiReport,
  runHiveAutoLedger,
} from "../hive-auto-ledger-cli.mjs";

test("defaultLedgerRecordsPath: keeps records out of the package and guards unsafe inputs", () => {
  const recordsDirectory = join(tmpdir(), "portable-hive-records");
  const path = defaultLedgerRecordsPath("emsenn0", "2026-09-05", { recordsDirectory, environment: {} });
  assert.equal(path, join(recordsDirectory, "2026-09-05-emsenn0-hive-account-ledger.beancount"));
  assert.throws(() => defaultLedgerRecordsPath("emsenn0", "2026-09-05", { environment: {} }), /specify --out/);
  assert.throws(() => defaultLedgerRecordsPath("../outside", "2026-09-05", { recordsDirectory }), /invalid Hive account/);
  assert.throws(() => defaultLedgerRecordsPath("emsenn0", "2026-02-30", { recordsDirectory }), /valid YYYY-MM-DD/);
  assert.equal(defaultLedgerRecordsPath("emsenn0", "2026-09-05", {
    environment: { METROPLAT_WEB_DATA_DIR: recordsDirectory },
  }), join(recordsDirectory, "records", "hive-account-ledger-records", "2026-09-05-emsenn0-hive-account-ledger.beancount"));
});

test("runHiveAutoLedger: omitted out selects only the configured records directory", async () => {
  const chainAccount = { name: "emsenn0", created: "2026-06-01T00:00:00", balance: "0.000 HIVE", hbd_balance: "0.000 HBD", vesting_shares: "0.000000 VESTS" };
  const recordsDirectory = join(tmpdir(), "hive-records-test");
  let writtenPath = null;
  const result = await runHiveAutoLedger(
    { account: "emsenn0", rangeStart: "2026-06-01", rangeEnd: "2026-09-05", recordsDirectory, environment: {} },
    {
      clientFactory: fakeClientFactory(chainAccount),
      readHiveHistoryImpl: async () => ({ operations: [] }),
      readHiveEngineHistoryImpl: async () => ({ entries: [], fills: [] }),
      fetchHiveEngineBalancesImpl: async () => [],
      writeFileTextImpl: async (path) => { writtenPath = path; },
      checkLedgerImpl: () => ({ ok: true, report: { ok: true } }),
      runFarolfiReportImpl: async (command) => ({ command, exitCode: 0, text: "" }),
    },
  );
  assert.equal(result.out, defaultLedgerRecordsPath("emsenn0", "2026-09-05", { recordsDirectory, environment: {} }));
  assert.equal(writtenPath, result.out);
  assert.equal(result.check.ok, true);
});

test("custodyAccountsFor: capitalizes the account name into the house naming pattern", () => {
  const custody = custodyAccountsFor("michael561");
  assert.equal(custody.hive, "Assets:Digital-Assets:Hive:Custody:Michael561");
  assert.equal(custody.hiveEngine, "Assets:Digital-Assets:HiveEngine:Custody:Michael561");
});

function fakeClientFactory(chainAccount) {
  return () => ({ async getAccounts() { return [chainAccount]; } });
}

test("deriveLedgerForAccount: refuses a provider response for a different Hive account before downstream reads", async () => {
  const requested = "emsenn0";
  const wrongAccount = {
    name: "unrelatedwallet", created: "2026-01-01T00:00:00",
    balance: "9.000 HIVE", hbd_balance: "0.000 HBD", vesting_shares: "0.000000 VESTS",
  };
  let downstreamReads = 0;
  const forbiddenRead = async () => { downstreamReads++; throw new Error("should not query unrelated source"); };
  await assert.rejects(
    deriveLedgerForAccount({ account: requested, rangeEnd: "2026-10-22" }, {
      clientFactory: () => ({ getAccounts: async () => [wrongAccount] }),
      readHiveHistoryImpl: forbiddenRead,
      readHiveEngineHistoryImpl: forbiddenRead,
      fetchHiveEngineBalancesImpl: forbiddenRead,
    }),
    /account identity mismatch/,
  );
  assert.equal(downstreamReads, 0);
});

test("deriveLedgerForAccount: missing or foreign history sources cannot become zero-activity ledger evidence", async () => {
  const account = "emsenn0";
  const chainAccount = {
    name: account, created: "2026-01-01T00:00:00",
    balance: "0.000 HIVE", hbd_balance: "0.000 HBD", vesting_shares: "0.000000 VESTS",
  };
  const hive = { account, operations: [], refusals: [] };
  const engine = { account, entries: [], fills: [], refusals: [] };
  const cases = [
    [{ ...hive, operations: undefined }, engine, /invalid Hive history/],
    [{ ...hive, account: "anotherwallet" }, engine, /Hive history account identity mismatch/],
    [hive, { ...engine, entries: undefined }, /invalid Hive-Engine history/],
    [hive, { ...engine, fills: undefined }, /invalid Hive-Engine history/],
    [hive, { ...engine, account: "anotherwallet" }, /Hive-Engine history account identity mismatch/],
  ];
  for (const [mainHistory, engineHistory, expected] of cases) {
    await assert.rejects(
      deriveLedgerForAccount({ account, rangeEnd: "2026-10-22" }, {
        clientFactory: fakeClientFactory(chainAccount),
        readHiveHistoryImpl: async () => mainHistory,
        readHiveEngineHistoryImpl: async () => engineHistory,
        fetchHiveEngineBalancesImpl: async () => [],
      }), expected,
    );
  }
  let writes = 0;
  await assert.rejects(runHiveAutoLedger({ account, out: join(tmpdir(), "must-not-publish-unverified-ledger.beancount") }, {
    clientFactory: fakeClientFactory(chainAccount),
    readHiveHistoryImpl: async () => ({ operations: undefined }),
    readHiveEngineHistoryImpl: async () => engine,
    fetchHiveEngineBalancesImpl: async () => [],
    writeFileTextImpl: async () => { writes++; },
  }), /invalid Hive history/);
  assert.equal(writes, 0, "invalid upstream coverage must not reach durable ledger output");
});

test("deriveLedgerForAccount: refuses cross-wallet, unattributed and malformed Hive-Engine balances", async () => {
  const account = "emsenn0";
  const chainAccount = {
    name: account, created: "2026-01-01T00:00:00",
    balance: "0.000 HIVE", hbd_balance: "0.000 HBD", vesting_shares: "0.000000 VESTS",
  };
  const cases = [
    [{ account: "unrelatedwallet", symbol: "MUSIC", balance: "42" }, /Hive-Engine account identity mismatch/],
    [{ symbol: "MUSIC", balance: "42" }, /Hive-Engine account identity mismatch/],
    [null, /Hive-Engine account identity mismatch/],
  ];
  for (const [row, expected] of cases) {
    await assert.rejects(
      deriveLedgerForAccount({ account, rangeEnd: "2026-10-22" }, {
        clientFactory: fakeClientFactory(chainAccount),
        readHiveHistoryImpl: async () => ({ operations: [] }),
        readHiveEngineHistoryImpl: async () => ({ entries: [], fills: [] }),
        fetchHiveEngineBalancesImpl: async (accounts) => {
          assert.deepEqual(accounts, [account]);
          return [row];
        },
      }),
      expected,
    );
  }
  await assert.rejects(
    deriveLedgerForAccount({ account, rangeEnd: "2026-10-22" }, {
      clientFactory: fakeClientFactory(chainAccount),
      readHiveHistoryImpl: async () => ({ operations: [] }),
      readHiveEngineHistoryImpl: async () => ({ entries: [], fills: [] }),
      fetchHiveEngineBalancesImpl: async () => null,
    }),
    /invalid Hive-Engine balances response/,
  );
});

test("deriveLedgerForAccount: back-derives an opening balance for a bounded window from the chain's current balance", async () => {
  const chainAccount = { name: "emsenn0", created: "2021-02-11T21:25:36", balance: "10.000 HIVE", hbd_balance: "0.000 HBD", vesting_shares: "0.000000 VESTS" };
  const composed = await deriveLedgerForAccount(
    { account: "emsenn0", rangeStart: "2026-06-01", rangeEnd: "2026-09-01" },
    {
      clientFactory: fakeClientFactory(chainAccount),
      readHiveHistoryImpl: async () => ({ operations: [
        { index: 1, kind: "transfer", trxId: "t1", timestamp: "2026-06-05T00:00:00", payload: { from: "someone", to: "emsenn0", amount: "3.000 HIVE", memo: "" } },
      ] }),
      readHiveEngineHistoryImpl: async () => ({ entries: [], fills: [] }),
      fetchHiveEngineBalancesImpl: async () => [],
    },
  );
  // window added 3 HIVE; chain now shows 10 HIVE; opening must have been 7 HIVE.
  assert.equal(composed.openingBalances.hive, "7");
  assert.equal(composed.ledgerResult.balanceComparison.find((b) => b.commodity === "HIVE").match, true);
});

test("deriveLedgerForAccount: a whole-history run (no rangeStart) uses a literal zero opening, so the closing assertion is a real check, not tautological", async () => {
  const chainAccount = { name: "michael561", created: "2024-11-28T17:31:09", balance: "5.000 HIVE", hbd_balance: "0.000 HBD", vesting_shares: "0.000000 VESTS" };
  const composed = await deriveLedgerForAccount(
    { account: "michael561" }, // no rangeStart: whole history since creation
    {
      clientFactory: fakeClientFactory(chainAccount),
      // deliberately omits the transfer that would actually explain the 5 HIVE, simulating a
      // real derivation bug (an unhandled or miscounted operation)
      readHiveHistoryImpl: async () => ({ operations: [] }),
      readHiveEngineHistoryImpl: async () => ({ entries: [], fills: [] }),
      fetchHiveEngineBalancesImpl: async () => [],
    },
  );
  assert.equal(composed.openingBalances.hive, "0");
  const hiveRow = composed.ledgerResult.balanceComparison.find((b) => b.commodity === "HIVE");
  assert.equal(hiveRow.computedClosing, "0");
  assert.equal(hiveRow.match, false); // 0 computed vs 5 on chain: correctly caught, not masked
});

test("deriveLedgerForAccount: scopes the Hive-Engine chain comparison to liquid balance alone, never balance+stake (a staked position lives in its own :Staked sub-account)", async () => {
  const chainAccount = { name: "michael561", created: "2024-11-28T17:31:09", balance: "0.000 HIVE", hbd_balance: "0.000 HBD", vesting_shares: "0.000000 VESTS" };
  const composed = await deriveLedgerForAccount(
    { account: "michael561", rangeStart: "2024-11-28", rangeEnd: "2026-09-05" },
    {
      clientFactory: fakeClientFactory(chainAccount),
      readHiveHistoryImpl: async () => ({ operations: [] }),
      readHiveEngineHistoryImpl: async () => ({
        entries: [{ transactionId: "he1", timestamp: "2024-12-01T00:00:00.000Z", operation: "tokens_stake", symbol: "MUSIC", quantity: "0.003817", from: "michael561", to: "michael561", account: "michael561" }],
        fills: [],
      }),
      // the chain currently shows 0 liquid + 0.003817 staked MUSIC (a real michael561 shape)
      fetchHiveEngineBalancesImpl: async () => [{ account: "michael561", symbol: "MUSIC", balance: "0", stake: "0.003817" }],
    },
  );
  assert.equal(composed.chainClosingBalances.hiveEngine.MUSIC, "0");
  const musicRow = composed.ledgerResult.balanceComparison.find((b) => b.commodity === "MUSIC");
  assert.equal(musicRow.match, true);
  assert.equal(musicRow.computedClosing, "0");
});

test("deriveLedgerForAccount: throws when the chain account does not exist", async () => {
  await assert.rejects(() => deriveLedgerForAccount(
    { account: "nobody" },
    { clientFactory: () => ({ async getAccounts() { return [undefined]; } }), readHiveHistoryImpl: async () => ({ operations: [] }), readHiveEngineHistoryImpl: async () => ({ entries: [], fills: [] }), fetchHiveEngineBalancesImpl: async () => [] },
  ), /account not found/);
});

test("checkLedger: evaluates a Beancount file with the current farolfi check API", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-auto-ledger-check-test-"));
  const out = join(dir, "trivial.beancount");
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(out, '2026-01-01 open Assets:Cash\n2026-01-01 open Equity:Opening-Balances\n2026-01-01 * "seed"\n  Assets:Cash  1 USD\n  Equity:Opening-Balances  -1 USD\n');
    const result = checkLedger(out);
    assert.equal(result.ok, true);
    assert.equal(result.report.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runFarolfiReport: unsupported command returns a parser error", () => {
  const result = runFarolfiReport("unknown-ledger-command", "/nonexistent/path.beancount");
  assert.equal(result.exitCode, 2);
  assert.equal(typeof result.text, "string");
  assert.ok(result.text.length > 0);
});

test("runFarolfiReport: resolves the real published farolfi bin and reports exit 0 over a trivial ledger", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-auto-ledger-farolfi-test-"));
  const out = join(dir, "trivial.beancount");
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(out, '2026-01-01 open Assets:Cash\n2026-01-01 open Equity:Opening-Balances\n2026-01-01 * "seed"\n  Assets:Cash  1 USD\n  Equity:Opening-Balances  -1 USD\n');
    const result = await runFarolfiReport("bal", out);
    assert.equal(result.exitCode, 0);
    assert.ok(result.text.includes("USD"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runHiveAutoLedger: writes the ledger, runs bean-check, and runs farolfi's balance and valuation reports over the real file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-auto-ledger-test-"));
  const out = join(dir, "ledger.beancount");
  try {
    const chainAccount = { name: "emsenn0", created: "2026-06-01T00:00:00", balance: "1.000 HIVE", hbd_balance: "0.000 HBD", vesting_shares: "0.000000 VESTS" };
    const result = await runHiveAutoLedger(
      { account: "emsenn0", rangeStart: "2026-06-01", rangeEnd: "2026-09-01", out },
      {
        clientFactory: fakeClientFactory(chainAccount),
        readHiveHistoryImpl: async () => ({ operations: [] }),
        readHiveEngineHistoryImpl: async () => ({ entries: [], fills: [] }),
        fetchHiveEngineBalancesImpl: async () => [],
        checkLedgerImpl: () => ({ ok: true, report: { ok: true } }),
      },
    );
    assert.equal(result.check.ok, true);
    assert.ok(result.balanceReport.text.length > 0);
    assert.equal(result.balanceReport.exitCode, 0);
    assert.equal(result.valuationReport.exitCode, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runHiveAutoLedger: a rejected check never replaces the last accepted ledger", async () => {
  const { readFile, writeFile, readdir } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "hive-ledger-receiving-"));
  const out = join(directory, "ledger.beancount");
  const accepted = "; accepted independent financial evidence; retain on refusal\n";
  await writeFile(out, accepted, "utf8");
  let reports = 0;
  try {
    const chainAccount = {
      name: "emsenn0", created: "2026-01-01T00:00:00",
      balance: "0.000 HIVE", hbd_balance: "0.000 HBD", vesting_shares: "0.000000 VESTS",
    };
    await assert.rejects(
      runHiveAutoLedger({ account: chainAccount.name, rangeEnd: "2026-10-22", out }, {
        clientFactory: fakeClientFactory(chainAccount),
        readHiveHistoryImpl: async () => ({ operations: [] }),
        readHiveEngineHistoryImpl: async () => ({ entries: [], fills: [] }),
        fetchHiveEngineBalancesImpl: async () => [],
        checkLedgerImpl: () => ({ ok: false, report: { ok: false, errors: ["adverse fixture"] } }),
        runFarolfiReportImpl: async () => { reports++; return { exitCode: 0, text: "" }; },
      }),
      /ledger check failed/,
    );
    assert.equal(reports, 0, "failed checks cannot proceed to financial reports");
    assert.equal(await readFile(out, "utf8"), accepted);
    assert.deepEqual(await readdir(directory), ["ledger.beancount"], "temporary unaccepted journals must be cleaned");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runHiveAutoLedger: failed farolfi reports refuse delivery instead of returning success", async () => {
  const account = { name: "emsenn0", created: "2026-01-01T00:00:00", balance: "0.000 HIVE", hbd_balance: "0.000 HBD", vesting_shares: "0.000000 VESTS" };
  for (const commandToFail of ["bal", "valuation"]) {
    const commands = [];
    await assert.rejects(
      runHiveAutoLedger({ account: account.name, rangeEnd: "2026-10-23", out: join(tmpdir(), "farolfi-report-failure.beancount") }, {
        clientFactory: fakeClientFactory(account),
        readHiveHistoryImpl: async () => ({ operations: [] }),
        readHiveEngineHistoryImpl: async () => ({ entries: [], fills: [] }),
        fetchHiveEngineBalancesImpl: async () => [],
        writeFileTextImpl: async () => {},
        checkLedgerImpl: () => ({ ok: true, report: { ok: true } }),
        runFarolfiReportImpl: async (command) => {
          commands.push(command);
          return { command, exitCode: command === commandToFail ? 3 : 0, text: "" };
        },
      }),
      new RegExp(`farolfi ${commandToFail} report failed.*exit code 3`),
    );
    assert.deepEqual(commands, commandToFail === "bal" ? ["bal"] : ["bal", "valuation"]);
  }
});
