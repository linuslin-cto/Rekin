import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DemoAdapter, DemoProposer } from "../src/demo.ts";
import { runDomain } from "../src/core/schedule.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "h2-"));
const adapter = new DemoAdapter(root);
const proposer = new DemoProposer(adapter.spec.channels.proposer!);
const result = runDomain("accounting", adapter.tasks(), 1, {
  adapter,
  prop: proposer,
  runsRoot: adapter.spec.runsRoot,
  libraryRoot: path.join(root, "library", "1"),
});
console.log(JSON.stringify(result, null, 2));
