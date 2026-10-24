// Only the isolated distribution smoke test uses this loader. Production code
// resolves its real pinned workspace packages through the normal module loader.
const mockURL = new URL("./mock-workspace-dependencies.mjs", import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  // The actual packed consumer entrypoint must go through Node's native package
  // resolution. Only its external workspace dependencies use this test stub.
  if (specifier.startsWith("@red-cup-engineering/") &&
      specifier !== "@red-cup-engineering/hive-auto-ledger-cli") {
    return { url: mockURL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
