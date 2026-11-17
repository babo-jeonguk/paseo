import fs from "node:fs";
const rows = fs.readdirSync("results").filter((f) => f.endsWith(".json")).sort()
  .map((f) => JSON.parse(fs.readFileSync(`results/${f}`, "utf8")));
console.log("| OS | agent | variant | result | proposed reap | killed process | chain before kill (server → up) |");
console.log("| --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  const chain = (r.chainBeforeKill || []).map((p) => `${p.name}(${p.pid})`).join(" ← ");
  const reap = r.reap ? `${r.reap.method}: found ${r.reap.found.map((f) => f.name).join(",") || "none"} → ${r.reap.portOpenAfterReap || r.reap.serverProcessesAfterReap.length ? "STILL RUNNING" : "reaped"}` : "-";
  console.log(`| ${r.os} | ${r.agent} | ${r.variant}${r.strategy && r.strategy !== "walk" && r.strategy !== "marker" ? ` [${r.strategy}]` : ""} | ${r.status ?? "error"}${r.error ? `: ${r.error}` : ""} | ${reap} | ${r.killed ? `${r.killed.name}(${r.killed.pid})` : "-"} | ${chain} |`);
}
