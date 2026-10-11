// Lets the tests import text modules (.md, .txt, .py) the way Wrangler bundles them for the Worker: as a string.
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
import { readFile } from "node:fs/promises";
export async function load(url, context, next) {
  if (/\\.(md|txt|py)$/.test(new URL(url).pathname)) return { format: "module", shortCircuit: true, source: "export default " + JSON.stringify(await readFile(new URL(url), "utf8")) + ";" };
  return next(url, context);
}`));
