import fs from "node:fs";
const rows = fs.readdirSync("results").filter((f) => f.endsWith(".json")).sort()
  .map((f) => JSON.parse(fs.readFileSync(`results/${f}`, "utf8")));
console.log("| OS | agent | variant | result | killed process | chain before kill (server → up) |");
console.log("| --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  const chain = (r.chainBeforeKill || []).map((p) => `${p.name}(${p.pid})`).join(" ← ");
  console.log(`| ${r.os} | ${r.agent} | ${r.variant} | ${r.status ?? "error"}${r.error ? `: ${r.error}` : ""} | ${r.killed ? `${r.killed.name}(${r.killed.pid})` : "-"} | ${chain} |`);
}
