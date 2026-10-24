import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    const modulePath = join(temp, "package", "hive-auto-ledger-cli.mjs");
    const manifest = JSON.parse(await readFile(join(temp, "package", "package.json"), "utf8"));
    assert.equal(manifest.exports, "./hive-auto-ledger-cli.mjs");

    const probe = `
      import assert from "node:assert/strict";
      import { join, resolve } from "node:path";
      const ledger = await import(process.env.LEDGER_PACKED_FILE_URL);
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
      console.log("packed-import-ok");
    `;
    const printed = run(process.execPath, [
      "--experimental-loader", fileURLToPath(new URL("./mock-workspace-dependencies-loader.mjs", import.meta.url)),
      "--input-type=module", "--eval", probe,
    ], {
      cwd: temp,
      env: { ...process.env, LEDGER_PACKED_FILE_URL: pathToFileURL(modulePath).href, LEDGER_TMP: temp,
        METROPLAT_WEB_DATA_DIR: "", HIVE_AUTO_LEDGER_RECORDS_DIR: "" },
    });
    assert.match(printed, /packed-import-ok/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
