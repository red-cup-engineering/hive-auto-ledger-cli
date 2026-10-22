// Only the isolated distribution smoke test uses this loader. Production code
// resolves its real pinned workspace packages through the normal module loader.
const mockURL = new URL("./mock-workspace-dependencies.mjs", import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@red-cup-engineering/")) {
    return { url: mockURL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
