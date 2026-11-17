// Orphan-process probe: does a command started by an agent CLI outlive the agent
// when the agent process itself is killed abruptly?
//
// A mock model server answers the agent's first model request with one shell tool
// call that starts a local HTTP server, then holds every later request open so the
// agent stays busy. Once the server listens, only the agent process is killed
// (SIGKILL / TerminateProcess, no tree kill). After a grace period the probe reports
// whether the server is still alive.
//
// usage: node probe.mjs <claude|codex|opencode|opencode1> <direct|nested> <port>
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const [agent, variant, portArg] = process.argv.slice(2);
const port = Number(portArg);
const isWin = process.platform === "win32";
const resultsDir = path.resolve("results");
fs.mkdirSync(resultsDir, { recursive: true });
// Windows only: "walk" (parent PID after exit), "snapshot" (record descendants while alive), "job" (job object via PowerShell).
const strategy = isWin ? process.env.PROBE_STRATEGY || "walk" : "marker";
const label = `${process.platform}-${agent}-${variant}${isWin && strategy !== "walk" ? `-${strategy}` : ""}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), `probe-${agent}-`));
const agentLog = path.join(resultsDir, `${label}.agent.log`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const serverCmd =
  variant === "direct"
    ? `python -m http.server ${port} --bind 127.0.0.1`
    : `python -c "import subprocess,sys; subprocess.run([sys.executable,'-m','http.server','${port}','--bind','127.0.0.1'])"`;

// ---------- mock model server ----------
const requests = [];
const held = new Set();
let toolCalls = 0;

function hasToolResult(body) {
  const text = JSON.stringify(body);
  return (
    text.includes('"tool_result"') ||
    text.includes('"function_call_output"') ||
    (body.messages || []).some((m) => m.role === "tool")
  );
}
function toolNames(body) {
  return (body.tools || []).map((t) => t.name || t.function?.name).filter(Boolean);
}
function hold(res) {
  held.add(res);
  res.on("close", () => held.delete(res));
}
function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const ev of events) {
    if (ev === "[DONE]") res.write("data: [DONE]\n\n");
    else res.write(`event: ${ev.type ?? "message"}\ndata: ${JSON.stringify(ev)}\n\n`);
  }
  res.end();
}
function json(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function anthropic(body, res) {
  const wantsTool = toolNames(body).includes("Bash") && !hasToolResult(body);
  if (hasToolResult(body)) return hold(res);
  const block = wantsTool
    ? { type: "tool_use", id: `toolu_${++toolCalls}`, name: "Bash", input: {} }
    : { type: "text", text: "" };
  const input = { command: serverCmd, timeout: 600000, description: "Start test server" };
  if (!body.stream) {
    return json(res, {
      id: "msg_mock", type: "message", role: "assistant", model: body.model,
      content: [wantsTool ? { ...block, input } : { type: "text", text: "ok" }],
      stop_reason: wantsTool ? "tool_use" : "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }
  sse(res, [
    { type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: block },
    wantsTool
      ? { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }
      : { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: wantsTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
}

function responses(body, res) {
  if (hasToolResult(body)) return hold(res);
  const names = toolNames(body);
  let call;
  if (names.includes("exec_command")) call = { name: "exec_command", args: { cmd: serverCmd, yield_time_ms: 600000 } };
  else if (names.includes("shell_command")) call = { name: "shell_command", args: { command: serverCmd, timeout_ms: 600000 } };
  else if (names.includes("shell")) call = { name: "shell", args: { command: isWin ? ["powershell", "-Command", serverCmd] : ["bash", "-lc", serverCmd], timeout_ms: 600000 } };
  const item = call
    ? { type: "function_call", call_id: `call_${++toolCalls}`, name: call.name, arguments: JSON.stringify(call.args) }
    : { type: "message", role: "assistant", id: "msg_mock", content: [{ type: "output_text", text: "ok" }] };
  sse(res, [
    { type: "response.created", response: { id: "resp_mock" } },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { id: "resp_mock", usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } },
  ]);
}

// Fill a shell tool's arguments from its JSON schema (command field, optional description/timeout).
function shellArgs(schema) {
  const props = schema?.properties || {};
  const args = {};
  const key = ["command", "cmd", "script"].find((k) => props[k]) || "command";
  args[key] = props[key]?.type === "array" ? (isWin ? ["powershell", "-Command", serverCmd] : ["bash", "-lc", serverCmd]) : serverCmd;
  if (props.description) args.description = "Start test server";
  for (const k of ["timeout", "timeout_ms"]) if (props[k]) args[k] = 600000;
  return args;
}
function chat(body, res) {
  if (hasToolResult(body)) return hold(res);
  const tool = (body.tools || []).find((t) => t.function?.name === "bash") || (body.tools || []).find((t) => t.function?.name === "shell");
  const wantsTool = !!tool;
  const toolName = tool?.function?.name;
  const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model: body.model };
  const args = JSON.stringify(shellArgs(tool?.function?.parameters));
  if (!body.stream) {
    return json(res, {
      id: "chatcmpl-mock", object: "chat.completion", created: 0, model: body.model,
      choices: [{ index: 0, finish_reason: wantsTool ? "tool_calls" : "stop", message: wantsTool
        ? { role: "assistant", content: null, tool_calls: [{ id: `call_${++toolCalls}`, type: "function", function: { name: toolName, arguments: args } }] }
        : { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const write = (v) => res.write(`data: ${JSON.stringify(v)}\n\n`);
  if (wantsTool) {
    write({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${++toolCalls}`, type: "function", function: { name: toolName, arguments: args } }] }, finish_reason: null }] });
    write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  } else {
    write({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] });
    write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

const mock = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch {}
  const shellTool = (body.tools || []).find((t) => ["bash", "shell", "Bash", "exec_command", "shell_command"].includes(t.name || t.function?.name));
  if (shellTool && !requests.some((r) => r.startsWith("schema"))) requests.push(`schema ${JSON.stringify(shellTool).slice(0, 600)}`);
  requests.push(`${req.method} ${req.url} tools=[${toolNames(body).slice(0, 40).join(",")}] toolResult=${hasToolResult(body)} stream=${!!body.stream}`);
  const url = req.url || "";
  if (url.includes("count_tokens")) return json(res, { input_tokens: 10 });
  if (req.method === "POST" && url.includes("/messages")) return anthropic(body, res);
  if (req.method === "POST" && url.includes("/responses")) return responses(body, res);
  if (req.method === "POST" && url.includes("/chat/completions")) return chat(body, res);
  if (url.includes("/models")) return json(res, { object: "list", data: [{ id: "mock-model", object: "model", type: "model", display_name: "mock", created: 0, owned_by: "mock" }], models: [] });
  json(res, {});
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const mockUrl = `http://127.0.0.1:${mock.address().port}`;

// ---------- agent launch ----------
// Marker inherited by the agent and its descendants; used by the proposed reap step.
const marker = `probe-${crypto.randomUUID()}`;
const env = { ...process.env, NO_COLOR: "1", ORPHAN_PROBE_MARKER: marker };
let command;
let args;
if (agent === "claude") {
  const configDir = path.join(work, "claude-config");
  fs.mkdirSync(configDir, { recursive: true });
  Object.assign(env, {
    ANTHROPIC_BASE_URL: mockUrl, ANTHROPIC_API_KEY: "sk-ant-mock", CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1",
  });
  command = "claude";
  args = ["-p", "go", "--permission-mode", "bypassPermissions", "--model", "claude-sonnet-4-5"];
} else if (agent === "codex") {
  const home = path.join(work, "codex-home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.toml"), [
    'model = "mock-model"', 'model_provider = "mock"', "",
    "[model_providers.mock]", 'name = "mock"', `base_url = "${mockUrl}/v1"`, 'wire_api = "responses"', 'env_key = "MOCK_API_KEY"', "",
  ].join("\n"));
  Object.assign(env, { CODEX_HOME: home, MOCK_API_KEY: "mock" });
  command = "codex";
  args = ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "go"];
} else if (agent === "opencode" || agent === "opencode1") {
  const config = path.join(work, "opencode.json");
  fs.writeFileSync(config, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: { mock: { npm: "@ai-sdk/openai-compatible", name: "Mock", options: { baseURL: `${mockUrl}/v1`, apiKey: "mock" }, models: { "mock-model": { name: "mock" } } } },
    model: "mock/mock-model", small_model: "mock/mock-model",
    permission: { bash: "allow", edit: "allow", external_directory: "allow" },
    autoupdate: false, share: "disabled",
  }));
  // Separate data/state per run so OpenCode 1 and 2 do not share a database.
  Object.assign(env, { OPENCODE_CONFIG: config, XDG_DATA_HOME: path.join(work, "data"), XDG_STATE_HOME: path.join(work, "state") });
  // "opencode" is OpenCode 2 (@opencode/cli); "opencode1" is OpenCode 1 (opencode-ai), installed separately.
  command = agent === "opencode1" ? process.env.OPENCODE1_BIN : "opencode";
  args = ["run", "--model", "mock/mock-model", "go"];
} else {
  throw new Error(`unknown agent ${agent}`);
}

const logFd = fs.openSync(agentLog, "w");
const child = spawn(command, args, { cwd: work, env, shell: isWin, stdio: ["ignore", logFd, logFd], windowsHide: true });
let childExit = null;
child.on("exit", (code, signal) => { childExit = { code, signal }; });
let holder;
if (strategy === "job") {
  const holderLog = fs.openSync(path.join(resultsDir, `${label}.jobholder.log`), "w");
  holder = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.resolve("jobholder.ps1"), "-TargetPid", String(child.pid)],
    { stdio: ["ignore", holderLog, holderLog], windowsHide: true });
}

// ---------- proposed reap step ----------
// Linux: /proc/<pid>/environ holds the marker. macOS: `ps -E` shows it.
// Windows: ParentProcessId still names the dead agent; keep only processes created after their parent.
function markerProcesses() {
  if (process.platform === "linux") {
    const found = [];
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      try {
        const entries = fs.readFileSync(`/proc/${name}/environ`).toString("utf8").split("\0");
        if (entries.includes(`ORPHAN_PROBE_MARKER=${marker}`)) found.push(Number(name));
      } catch {}
    }
    return found;
  }
  const out = execFileSync("ps", ["-A", "-ww", "-E", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 << 20 });
  const token = new RegExp(`(^|\\s)ORPHAN_PROBE_MARKER=${marker}(\\s|$)`);
  return out.split("\n").map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter((m) => m && token.test(m[2]))
    .map((m) => Number(m[1])).filter((pid) => pid !== process.pid);
}
function windowsDescendants(agentPid, agentCreated) {
  const table = processes();
  const found = new Map([[agentPid, agentCreated]]);
  // snapshot: start also from remembered descendants that still have the same creation time.
  for (const [pid, created] of known) {
    if (table.some((p) => p.pid === pid && p.created === created)) found.set(pid, created);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of table) {
      if (found.has(p.pid) || !found.has(p.ppid)) continue;
      const parentCreated = found.get(p.ppid);
      if (p.created !== undefined && parentCreated !== undefined && p.created >= parentCreated) {
        found.set(p.pid, p.created);
        changed = true;
      }
    }
  }
  found.delete(agentPid);
  return [...found.keys()];
}
async function reap(agentProc, tableBeforeKill) {
  const method = isWin ? (strategy === "snapshot" ? "snapshot+parent-pid" : strategy === "job" ? "job(after-exit fallback walk)" : "parent-pid+creation-time") : "marker-env";
  const agentCreated = tableBeforeKill.find((p) => p.pid === agentProc.pid)?.created;
  const pids = isWin ? windowsDescendants(agentProc.pid, agentCreated) : markerProcesses();
  const table = new Map(processes().map((p) => [p.pid, p]));
  for (const pid of pids) {
    try {
      if (isWin) execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
      else process.kill(pid, "SIGKILL");
    } catch {}
  }
  await sleep(3000);
  const remaining = processes().filter(isServer);
  return {
    method,
    found: pids.map((pid) => ({ pid, name: base(table.get(pid)?.name || "?") })),
    serverProcessesAfterReap: remaining.map((p) => p.pid),
    portOpenAfterReap: await portOpen(),
  };
}

// ---------- process table ----------
function processes() {
  if (isWin) {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"],
      { encoding: "utf8", maxBuffer: 64 << 20 });
    return JSON.parse(out).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name || "", args: p.CommandLine || "", created: p.Created ? Date.parse(p.Created) : undefined }));
  }
  const names = new Map(execFileSync("ps", ["-A", "-o", "pid=,comm="], { encoding: "utf8" }).trim().split("\n").map((l) => {
    const m = l.trim().match(/^(\d+)\s+(.*)$/); return [Number(m[1]), m[2]];
  }));
  return execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8", maxBuffer: 64 << 20 }).trim().split("\n").map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return { pid: Number(m[1]), ppid: Number(m[2]), name: names.get(Number(m[1])) || "", args: m[3] };
  });
}
const base = (name) => path.basename(name.replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "");
const isServer = (p) => p.args.includes("http.server") && p.args.includes(String(port)) && !p.args.includes("probe.mjs");
const helper = /^(bash|sh|dash|zsh|fish|cmd|powershell|pwsh|conhost|openconsole|opencode-pty|python|python3|python3\.\d+|py|env|winpty|winpty-agent|login|script)$/;

function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.setTimeout(2000);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.once("timeout", () => { s.destroy(); resolve(false); });
  });
}

const result = { os: process.platform, agent, variant, strategy, port };
// strategy "snapshot": remember descendants (pid + creation time) while the agent is alive.
const known = new Map();
function rememberDescendants() {
  try {
    const table = processes();
    const root = table.find((p) => p.pid === child.pid);
    if (!root) return;
    const seen = new Map([[root.pid, root.created]]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const p of table) {
        if (seen.has(p.pid) || !seen.has(p.ppid)) continue;
        if (p.created === undefined || p.created < seen.get(p.ppid)) continue;
        seen.set(p.pid, p.created); changed = true;
      }
    }
    for (const [pid, created] of seen) if (pid !== child.pid) known.set(pid, created);
  } catch {}
}
const snapshotTimer = strategy === "snapshot" ? setInterval(rememberDescendants, 2000) : undefined;
try {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && !(await portOpen()) && !childExit) await sleep(1000);
  if (!(await portOpen())) {
    result.status = "server-not-started";
    result.childExit = childExit;
    throw new Error("server did not start");
  }
  await sleep(1500);
  const table = processes();
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const servers = table.filter(isServer);
  const top = servers.find((s) => !servers.some((o) => o.pid === s.ppid)) || servers[0];
  const chain = [];
  for (let p = top; p && chain.length < 12; p = byPid.get(p.ppid)) {
    chain.push({ pid: p.pid, ppid: p.ppid, name: base(p.name), args: p.args.slice(0, 160) });
    if (p.pid === process.pid) break;
  }
  result.chainBeforeKill = chain;
  const agentProc = chain.find((p, i) => i > 0 && !helper.test(p.name) && p.pid !== process.pid);
  if (!agentProc) { result.status = "agent-not-found"; throw new Error("agent process not found in chain"); }
  result.killed = agentProc;
  if (snapshotTimer) { rememberDescendants(); clearInterval(snapshotTimer); }
  if (isWin) execFileSync("taskkill", ["/F", "/PID", String(agentProc.pid)], { stdio: "ignore" });
  else process.kill(agentProc.pid, "SIGKILL");
  await sleep(10_000);
  const after = processes().filter(isServer);
  result.serverProcessesAfter = after.map((p) => ({ pid: p.pid, ppid: p.ppid, name: base(p.name) }));
  result.portOpenAfter = await portOpen();
  result.status = after.length || result.portOpenAfter ? "LEFT_RUNNING" : "cleaned_up";
  if (result.status === "LEFT_RUNNING") result.reap = await reap(agentProc, table);
} catch (error) {
  result.error = String(error?.message || error);
} finally {
  result.mockRequests = requests.slice(0, 30);
  fs.writeFileSync(path.join(resultsDir, `${label}.json`), JSON.stringify(result, null, 2));
  console.log(`${label}: ${result.status ?? "error"}${result.error ? ` (${result.error})` : ""}`);
  // cleanup everything we started
  let leftovers = [];
  try { leftovers = processes().filter(isServer); } catch {}
  for (const p of leftovers) {
    try {
      if (isWin) execFileSync("taskkill", ["/F", "/T", "/PID", String(p.pid)], { stdio: "ignore" });
      else process.kill(p.pid, "SIGKILL");
    } catch {}
  }
  try { if (isWin) execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); else child.kill("SIGKILL"); } catch {}
  try { if (holder) execFileSync("taskkill", ["/F", "/T", "/PID", String(holder.pid)], { stdio: "ignore" }); } catch {}
  for (const res of held) res.destroy();
  mock.close();
  setTimeout(() => process.exit(0), 500).unref();
}
