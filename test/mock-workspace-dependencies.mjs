// Test-only substitute for workspace packages when examining a packed import.
// This module is deliberately not included in the published package.
export const writeFileText = async () => {};
export class HiveClient {}
export const readHiveAccountHistory = async () => ({ operations: [] });
export const readHiveEngineAccountHistory = async () => ({ entries: [], fills: [] });
export const deriveHiveAccountLedger = () => ({
  ledgerText: "; isolated smoke only", refusals: [], balanceComparison: [],
  transactionCount: 0, fillsBooked: 0,
});
export const plainDecimal = (value) => String(value);
export const addDecimalStrings = () => "0";
export const negateDecimalString = () => "0";
export const stripUnitSuffix = () => "0";
export class EngineClient {}
export const dispatch = () => ({ text: '{"ok":true}', exitCode: 0 });
export const parseCli = () => ({ command: "check", files: [], options: {} });
