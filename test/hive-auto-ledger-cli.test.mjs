import assert from "node:assert/strict";
import test from "node:test";
import { dayAfter, deriveLedgerForAccount } from "../hive-auto-ledger-cli.mjs";

const NOW = () => new Date("2026-09-05T18:30:00.000Z");

function deps({ chainAccount, operations = [], entries = [], balances = [] }) {
  return {
    now: NOW,
    clientFactory: () => ({ getAccounts: async () => [chainAccount] }),
    readHiveHistoryImpl: async (input) => {
      assert.equal(input.to, undefined, "the history is read to the moment of the balance read, not cut at midnight");
      return { account: "alice", operations, refusals: [] };
    },
    readHiveEngineHistoryImpl: async (input) => {
      assert.equal(input.to, undefined);
      return { account: "alice", entries, fills: [], refusals: [] };
    },
    fetchHiveEngineBalancesImpl: async () => balances,
  };
}

const CHAIN = { name: "alice", created: "2026-01-01T00:00:00", balance: "10.000 HIVE", hbd_balance: "6.000 HBD", vesting_shares: "0.000000 VESTS", savings_balance: "0.000 HIVE", savings_hbd_balance: "4.000 HBD" };

test("the assertion is dated the day after the read, so the read day's operations are inside it", () => {
  assert.equal(dayAfter(NOW()), "2026-09-06");
  assert.equal(dayAfter(new Date("2026-12-31T23:59:59.000Z")), "2027-01-01");
});

test("closing figures are the chain's liquid, savings and Hive-Engine staked figures, asserted on the tree and each part", async () => {
  const result = await deriveLedgerForAccount({ account: "alice" }, deps({
    chainAccount: CHAIN,
    operations: [
      { index: 1, trxId: "a", timestamp: "2026-09-05T10:00:00", kind: "transfer", payload: { from: "bob", to: "alice", amount: "10.000 HIVE", memo: "" } },
      { index: 2, trxId: "b", timestamp: "2026-09-05T11:00:00", kind: "transfer", payload: { from: "bob", to: "alice", amount: "10.000 HBD", memo: "" } },
      { index: 3, trxId: "c", timestamp: "2026-09-05T12:00:00", kind: "transfer_to_savings", payload: { from: "alice", to: "alice", amount: "4.000 HBD", memo: "" } },
    ],
    entries: [
      { transactionId: "e1", timestamp: "2026-09-05T13:00:00.000Z", operation: "distribution_checkPendingDistributions", symbol: "TKN", quantity: "7.5" },
      { transactionId: "e2", timestamp: "2026-09-05T14:00:00.000Z", operation: "tokens_stake", symbol: "TKN", quantity: "2.5" },
    ],
    balances: [{ account: "alice", symbol: "TKN", balance: "5", stake: "2.5", pendingUnstake: "0", delegationsOut: "0" }],
  }));
  const { ledgerResult } = result;
  assert.equal(ledgerResult.balanceDate, "2026-09-06");
  assert.ok(ledgerResult.balanceComparison.every((row) => row.match), JSON.stringify(ledgerResult.balanceComparison.filter((r) => !r.match)));
  assert.match(ledgerResult.ledgerText, /2026-09-06 balance Assets:Digital-Assets:Hive:Custody:Alice:Savings 4\.000 HBD/u);
  assert.match(ledgerResult.ledgerText, /2026-09-06 balance Assets:Digital-Assets:HiveEngine:Custody:Alice:Staked 2\.5 TKN/u);
  assert.equal(result.coverage.unresolved.length, 0);
});

test("a bounded window opens every sub-account from the chain figure less the window's own change", async () => {
  const result = await deriveLedgerForAccount({ account: "alice", rangeStart: "2026-09-01" }, deps({
    chainAccount: CHAIN,
    operations: [{ index: 3, trxId: "c", timestamp: "2026-09-05T12:00:00", kind: "transfer_to_savings", payload: { from: "alice", to: "alice", amount: "1.000 HBD", memo: "" } }],
    balances: [],
  }));
  assert.equal(result.openingBalances.hbdSavings, "3");
  assert.equal(result.openingBalances.hbd, "7");
  assert.ok(result.ledgerResult.balanceComparison.every((row) => row.match));
});

test("a range end before today is refused: the closing balances are read live", async () => {
  await assert.rejects(deriveLedgerForAccount({ account: "alice", rangeEnd: "2026-08-01" }, deps({ chainAccount: CHAIN })), RangeError);
});
