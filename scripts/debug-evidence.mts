import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DemoAdapter, DemoProposer } from "../src/demo.ts";
import { runDomain } from "../src/core/schedule.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "h2-ev-"));
const adapter = new DemoAdapter(root);
const proposer = new DemoProposer(adapter.spec.channels.proposer!);
runDomain("accounting", adapter.tasks(), 2, {
  adapter,
  prop: proposer,
  runsRoot: adapter.spec.runsRoot,
  libraryRoot: path.join(root, "library", "2"),
});
const work = path.join(adapter.spec.runsRoot, "demo-oc-seq2", "ledger-1");
const reflection = path.join(work, "reflection", "seq2");
const list: string[] = [];
const walk = (d: string) => {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else list.push(path.relative(reflection, p).split(path.sep).join("/"));
  }
};
walk(reflection);
console.log(JSON.stringify({ reflectionExists: fs.existsSync(reflection), files: list.sort() }, null, 2));
const inv1lib = path.join(adapter.spec.runsRoot, "demo-oc-seq2", "ledger-2", "context", "inv1", "library");
console.log("library", fs.existsSync(inv1lib), inv1lib);
if (fs.existsSync(inv1lib)) {
  console.log(fs.readdirSync(inv1lib, { recursive: true }).slice(0, 40));
}
