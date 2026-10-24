import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = (command, args, options) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 20000, maxBuffer: 2 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};

test("packed Hive ledger package imports without a repo root and writes only to a selected records destination", async () => {
  const temp = await mkdtemp(join(tmpdir(), "hive-ledger-pack-"));
  try {
    const output = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], { cwd: root });
    const [packed] = JSON.parse(output);
    assert.equal(packed.name, "@red-cup-engineering/hive-auto-ledger-cli");
    assert.equal(packed.version, "0.1.12");
    assert.ok(packed.files.some((file) => file.path === "hive-auto-ledger-cli.mjs"));
    assert.ok(!packed.files.some((file) => file.path.startsWith("test/")), "test stubs must never be published");

    run("tar", ["-xzf", join(temp, packed.filename), "-C", temp], { cwd: temp });
    const manifest = JSON.parse(await readFile(join(temp, "package", "package.json"), "utf8"));
    assert.equal(manifest.exports, "./hive-auto-ledger-cli.mjs");
    // Exercise Node\u0027s real bare-package resolver from an unrelated consumer\u0027s
    // node_modules layout, not a privileged direct file:// import from the tarball.
    // Workspace dependencies remain deliberately mocked by the isolated loader.
    const consumer = join(temp, "consumer");
    const packageScope = join(consumer, "node_modules", "@red-cup-engineering");
    await mkdir(packageScope, { recursive: true });
    await rename(join(temp, "package"), join(packageScope, "hive-auto-ledger-cli"));

    const probe = `
      import assert from "node:assert/strict";
      import { join, resolve } from "node:path";
      const ledger = await import("@red-cup-engineering/hive-auto-ledger-cli");
      assert.equal(ledger.custodyAccountsFor("emsenn0").hive, "Assets:Digital-Assets:Hive:Custody:Emsenn0");
      for (const name of ["checkLedger", "runFarolfiReport", "deriveLedgerForAccount", "runHiveAutoLedger", "defaultLedgerRecordsPath"])
        assert.equal(typeof ledger[name], "function", "published API missing: " + name);
      assert.throws(() => ledger.defaultLedgerRecordsPath("emsenn0", "2026-10-22", { environment: {} }), /specify --out/);
      assert.throws(() => ledger.defaultLedgerRecordsPath("../escape", "2026-10-22", { recordsDirectory: process.env.LEDGER_TMP }), /invalid Hive account/);
      assert.throws(() => ledger.defaultLedgerRecordsPath("emsenn0", "2026-02-30", { recordsDirectory: process.env.LEDGER_TMP }), /valid YYYY-MM-DD/);
      const derived = ledger.defaultLedgerRecordsPath("emsenn0", "2026-10-22", {
        environment: { METROPLAT_WEB_DATA_DIR: process.env.LEDGER_TMP }
      });
      assert.equal(derived, join(resolve(process.env.LEDGER_TMP), "records", "hive-account-ledger-records", "2026-10-22-emsenn0-hive-account-ledger.beancount"));
      assert.equal(ledger.defaultLedgerRecordsPath("emsenn0", "2026-10-22", {
        recordsDirectory: join(process.env.LEDGER_TMP, "override"),
        environment: { METROPLAT_WEB_DATA_DIR: "/should/not/win" }
      }), join(resolve(process.env.LEDGER_TMP), "override", "2026-10-22-emsenn0-hive-account-ledger.beancount"));
      const fake = { name:"emsenn0",created:"2026-01-01T00:00:00",balance:"0.000 HIVE",hbd_balance:"0.000 HBD",vesting_shares:"0.000000 VESTS" };
      // Refuse an unselected or blank output *before* asking network providers
      // or deriving source-dependent ledger state. A failed write destination
      // must never spend compute or read account history first.
      let invoked = 0;
      const refuseDeps = {
        clientFactory: () => {
          invoked += 1;
          return { getAccounts: async () => [fake] };
        },
        readHiveHistoryImpl: async () => ({operations:[]}),
        readHiveEngineHistoryImpl: async () => ({entries:[],fills:[]}),
        fetchHiveEngineBalancesImpl: async () => [],
        writeFileTextImpl: async () => { throw new Error("must not write"); },
      };
      await assert.rejects(
        ledger.runHiveAutoLedger({account:"emsenn0",rangeEnd:"2026-10-22",environment:{}}, refuseDeps),
        /specify --out/,
      );
      await assert.rejects(
        ledger.runHiveAutoLedger({account:"emsenn0",rangeEnd:"2026-10-22",out:"   ",environment:{}}, refuseDeps),
        /--out must be a nonempty/,
      );
      // A selected output is not authority to query providers using invalid
      // account or date inputs. Both direct derivation consumers and full
      // writers must refuse before making even one RPC constructor call.
      const invalidInputs = [
        [{account:"../escape",rangeEnd:"2026-10-22"}, /invalid Hive account/],
        [{account:"emsenn0",rangeStart:"2026-02-30",rangeEnd:"2026-10-22"}, /valid YYYY-MM-DD/],
        [{account:"emsenn0",rangeStart:"2026-10-23",rangeEnd:"2026-10-22"}, /range start.*after.*end/],
      ];
      for (const [options, message] of invalidInputs) {
        await assert.rejects(ledger.deriveLedgerForAccount(options, refuseDeps), message);
        await assert.rejects(ledger.runHiveAutoLedger({...options,out:join(process.env.LEDGER_TMP,"named.beancount")}, refuseDeps), message);
      }
      assert.equal(invoked, 0, "source provider must not run before valid account, range and write custody");
      // A provider answering with a different account must never be accepted as
      // the requested wallet, even when it returns otherwise plausible balances.
      // The history readers and writer must not run against a mixed identity.
      let incorrectSourceReads = 0;
      const wrongAccount = { ...fake, name: "unrelatedwallet" };
      const mismatchDeps = {
        clientFactory: () => ({ getAccounts: async () => [wrongAccount] }),
        readHiveHistoryImpl: async () => { incorrectSourceReads++; return { operations: [] }; },
        readHiveEngineHistoryImpl: async () => { incorrectSourceReads++; return { entries: [], fills: [] }; },
        fetchHiveEngineBalancesImpl: async () => { incorrectSourceReads++; return []; },
        writeFileTextImpl: async () => { incorrectSourceReads++; },
        checkLedgerImpl: () => ({ ok: true }),
        runFarolfiReportImpl: () => ({ text: "", exitCode: 0 }),
      };
      await assert.rejects(
        ledger.deriveLedgerForAccount({ account: "emsenn0", rangeEnd: "2026-10-22" }, mismatchDeps),
        /account identity mismatch/,
      );
      await assert.rejects(
        ledger.runHiveAutoLedger({ account: "emsenn0", rangeEnd: "2026-10-22", out: join(process.env.LEDGER_TMP, "claimed.beancount") }, mismatchDeps),
        /account identity mismatch/,
      );
      assert.equal(incorrectSourceReads, 0, "mismatched identity must stop before history reads or writing");

      // The Hive-Engine balance endpoint selects by account, but a provider
      // reply must prove that its returned rows belong to the requested wallet.
      // Otherwise unrelated token balances can contaminate exported evidence.
      let engineReads = 0;
      const foreignEngineDeps = {
        clientFactory: () => ({ getAccounts: async () => [fake] }),
        readHiveHistoryImpl: async () => ({ operations: [] }),
        readHiveEngineHistoryImpl: async () => ({ entries: [], fills: [] }),
        fetchHiveEngineBalancesImpl: async (accounts) => {
          engineReads++;
          assert.deepEqual(accounts, ["emsenn0"]);
          return [{ account: "unrelatedwallet", symbol: "MUSIC", balance: "42" }];
        },
        writeFileTextImpl: async () => { throw new Error("must not write foreign wallet evidence"); },
      };
      await assert.rejects(
        ledger.deriveLedgerForAccount({ account: "emsenn0", rangeEnd: "2026-10-22" }, foreignEngineDeps),
        /Hive-Engine account identity mismatch/,
      );
      await assert.rejects(
        ledger.runHiveAutoLedger({ account: "emsenn0", rangeEnd: "2026-10-22", out: join(process.env.LEDGER_TMP, "foreign.beancount") }, foreignEngineDeps),
        /Hive-Engine account identity mismatch/,
      );
      assert.equal(engineReads, 2, "the provider response must be checked on every requested derivation");
      // Unattributed and structurally missing balance responses cannot claim
      // custody merely because the endpoint was queried with the right wallet.
      await assert.rejects(
        ledger.deriveLedgerForAccount({ account: "emsenn0", rangeEnd: "2026-10-22" }, {
          ...foreignEngineDeps,
          fetchHiveEngineBalancesImpl: async () => [{ symbol: "MUSIC", balance: "42" }],
        }),
        /Hive-Engine account identity mismatch/,
      );
      await assert.rejects(
        ledger.deriveLedgerForAccount({ account: "emsenn0", rangeEnd: "2026-10-22" }, {
          ...foreignEngineDeps,
          fetchHiveEngineBalancesImpl: async () => null,
        }),
        /invalid Hive-Engine balances response/,
      );

      // Hive-Engine's balance table is keyed by wallet and token symbol.
      // The actual packaged module must not silently take the last matching
      // row when a provider returns duplicate or unattributed token evidence.
      let ambiguousWrites = 0;
      const symbolEvidence = { account: "emsenn0", symbol: "MUSIC", balance: "1.000" };
      for (const balances of [
        [symbolEvidence, { ...symbolEvidence, balance: "999.000" }],
        [symbolEvidence, { ...symbolEvidence }],
        [{ account: "emsenn0", balance: "12.000" }],
      ]) {
        await assert.rejects(
          ledger.runHiveAutoLedger(
            { account: "emsenn0", rangeEnd: "2026-10-22", out: join(process.env.LEDGER_TMP, "disputed-symbol.beancount") },
            {
              ...foreignEngineDeps,
              fetchHiveEngineBalancesImpl: async () => balances,
              writeFileTextImpl: async () => { ambiguousWrites++; },
            },
          ),
          /duplicate Hive-Engine balance|invalid Hive-Engine balance symbol/,
        );
      }
      assert.equal(ambiguousWrites, 0, "conflicting token evidence must not create a candidate or published ledger");

      // A valid provider query can still return a partial or cross-wallet
      // history: the packed module must never reinterpret that as no activity.
      let partialWrites = 0;
      const historyDeps = {
        clientFactory: () => ({ getAccounts: async () => [fake] }),
        readHiveHistoryImpl: async () => ({ operations: undefined }),
        readHiveEngineHistoryImpl: async () => ({ entries: [], fills: [] }),
        fetchHiveEngineBalancesImpl: async () => [],
        writeFileTextImpl: async () => { partialWrites++; },
      };
      await assert.rejects(ledger.runHiveAutoLedger(
        { account: "emsenn0", out: join(process.env.LEDGER_TMP, "partial.beancount") },
        historyDeps,
      ), /invalid Hive history/);
      await assert.rejects(ledger.deriveLedgerForAccount(
        { account: "emsenn0" },
        { ...historyDeps, readHiveHistoryImpl: async () => ({ operations: [] }),
          readHiveEngineHistoryImpl: async () => ({ account: "anotherwallet", entries: [], fills: [] }) },
      ), /Hive-Engine history account identity mismatch/);
      assert.equal(partialWrites, 0, "partial history cannot overwrite a previous ledger");

      // A real packed import must refuse a source-declared page gap before
      // any candidate write, even if balance and reporting mocks would pass.
      let disputedWrites = 0;
      let disputedChecks = 0;
      await assert.rejects(
        ledger.runHiveAutoLedger(
          { account: "emsenn0", rangeEnd: "2026-10-22", out: join(process.env.LEDGER_TMP, "disputed.beancount") },
          {
            clientFactory: () => ({ getAccounts: async () => [fake] }),
            readHiveHistoryImpl: async () => ({ operations: [], refusals: [{ code: "unread-page" }] }),
            readHiveEngineHistoryImpl: async () => ({ entries: [], fills: [] }),
            fetchHiveEngineBalancesImpl: async () => [],
            writeFileTextImpl: async () => { disputedWrites++; },
            checkLedgerImpl: () => { disputedChecks++; return { ok: true, report: { ok: true } }; },
            runFarolfiReportImpl: () => ({ exitCode: 0, text: "" }),
          },
        ),
        /unresolved source evidence/,
      );
      assert.equal(disputedWrites, 0, "the packaged distribution must preserve accepted output on disputed coverage");
      assert.equal(disputedChecks, 0, "disputed source evidence must stop before accounting checks");

      let written;
      const result = await ledger.runHiveAutoLedger(
        { account:"emsenn0",rangeEnd:"2026-10-22",recordsDirectory:join(process.env.LEDGER_TMP,"written"),environment:{} },
        {
          clientFactory:()=>({getAccounts:async()=>[fake]}),
          readHiveHistoryImpl:async()=>({operations:[]}),
          readHiveEngineHistoryImpl:async()=>({entries:[],fills:[]}),
          fetchHiveEngineBalancesImpl:async()=>[],
          writeFileTextImpl:async(path)=>{written=path;},
          checkLedgerImpl:()=>({ok:true,report:{ok:true}}),
          runFarolfiReportImpl:()=>({text:"",exitCode:0})
        }
      );
      assert.equal(result.out, join(resolve(process.env.LEDGER_TMP), "written", "2026-10-22-emsenn0-hive-account-ledger.beancount"));
      assert.equal(written, result.out);
      // The actual installed-package export, not only the checkout source,
      // must refuse a superficially clean ledger whose financial reports fail.
      for (const failing of ["bal", "valuation"]) {
        const invokedReports = [];
        await assert.rejects(
          ledger.runHiveAutoLedger(
            { account: "emsenn0", rangeEnd: "2026-10-22", out: join(process.env.LEDGER_TMP, "report-refusal.beancount") },
            {
              clientFactory: () => ({ getAccounts: async () => [fake] }),
              readHiveHistoryImpl: async () => ({ operations: [] }),
              readHiveEngineHistoryImpl: async () => ({ entries: [], fills: [] }),
              fetchHiveEngineBalancesImpl: async () => [],
              writeFileTextImpl: async () => {},
              checkLedgerImpl: () => ({ ok: true, report: { ok: true } }),
              runFarolfiReportImpl: async (command) => {
                invokedReports.push(command);
                return { command, exitCode: command === failing ? 5 : 0, text: "" };
              },
            },
          ),
          new RegExp("farolfi " + failing + " report failed.*exit code 5"),
        );
        assert.deepEqual(invokedReports, failing === "bal" ? ["bal"] : ["bal", "valuation"]);
      }
      console.log("packed-import-ok");
    `;
    const printed = run(process.execPath, [
      "--experimental-loader", fileURLToPath(new URL("./mock-workspace-dependencies-loader.mjs", import.meta.url)),
      "--input-type=module", "--eval", probe,
    ], {
      cwd: consumer,
      env: { ...process.env, LEDGER_TMP: temp,
        METROPLAT_WEB_DATA_DIR: "", HIVE_AUTO_LEDGER_RECORDS_DIR: "" },
    });
    assert.match(printed, /packed-import-ok/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
