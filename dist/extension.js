"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate,
  setLatestData: () => setLatestData
});
module.exports = __toCommonJS(extension_exports);
var vscode4 = __toESM(require("vscode"));

// src/quotaService.ts
var http = __toESM(require("http"));
var import_child_process = require("child_process");
var import_util = require("util");
var vscode = __toESM(require("vscode"));
var fs = __toESM(require("fs"));
var execAsync = (0, import_util.promisify)(import_child_process.exec);
async function execWithTimeout(command, timeoutMs = 8e3) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    (0, import_child_process.exec)(command, { shell: "powershell.exe" }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}
var API_PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
var QuotaService = class {
  serverInfo = null;
  discovering = null;
  // [ADDED] Optional logger
  logger;
  constructor(logger) {
    this.logger = logger;
  }
  log(msg) {
    this.logger?.appendLine(`[${(/* @__PURE__ */ new Date()).toLocaleTimeString()}] [QuotaService] ${msg}`);
  }
  async discoverLocalServer() {
    if (this.discovering) return this.discovering;
    this.discovering = (async () => {
      try {
        const command = `powershell -ExecutionPolicy Bypass -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'csrf_token' } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"`;
        const { stdout } = await execAsync(command);
        if (!stdout || stdout.trim() === "" || stdout.trim() === "[]") return false;
        let processes = [];
        try {
          const parsed = JSON.parse(stdout.trim());
          processes = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return false;
        }
        for (const proc of processes) {
          const cmdLine = proc.CommandLine || "";
          const csrfMatch = cmdLine.match(/--csrf_token[\s=]+(?:["']?)([a-zA-Z0-9\-_.]+)(?:["']?)/);
          if (!csrfMatch) continue;
          const pid = proc.ProcessId;
          const token = csrfMatch[1];
          const listeningPorts = await this.getListeningPorts(pid);
          for (const port of listeningPorts) {
            if (await this.testConnection(port, token)) {
              this.serverInfo = { port, token };
              return true;
            }
          }
        }
      } catch (e) {
        console.error("[SQM] Discovery failed:", e);
      } finally {
        this.discovering = null;
      }
      return false;
    })();
    return this.discovering;
  }
  async getListeningPorts(pid) {
    try {
      const cmd = `powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique"`;
      const { stdout } = await execAsync(cmd);
      return stdout.trim().split(/\r?\n/).map((p) => parseInt(p.trim())).filter((p) => !isNaN(p) && p > 1024);
    } catch {
      return [];
    }
  }
  async testConnection(port, token) {
    return new Promise((resolve) => {
      const options = {
        hostname: "127.0.0.1",
        port,
        path: API_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Codeium-Csrf-Token": token,
          "Connect-Protocol-Version": "1"
        },
        timeout: 800
      };
      const req = http.request(options, (res) => resolve(res.statusCode === 200));
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.write(JSON.stringify({ wrapper_data: {} }));
      req.end();
    });
  }
  async fetchStatus() {
    if (!this.serverInfo) {
      const found = await this.discoverLocalServer();
      if (!found) return null;
    }
    try {
      const options = {
        hostname: "127.0.0.1",
        port: this.serverInfo.port,
        path: API_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Codeium-Csrf-Token": this.serverInfo.token,
          "Connect-Protocol-Version": "1"
        },
        timeout: 5e3
      };
      return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
          let data = "";
          res.on("data", (chunk) => data += chunk);
          res.on("end", () => {
            if (res.statusCode === 200) {
              try {
                resolve(this.parseResponse(JSON.parse(data)));
              } catch (e) {
                reject(e);
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          });
        });
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("Timeout"));
        });
        req.write(JSON.stringify({ wrapper_data: {} }));
        req.end();
      });
    } catch (e) {
      this.serverInfo = null;
      return null;
    }
  }
  parseResponse(resp) {
    const user = resp.userStatus;
    const modelConfigs = user?.cascadeModelConfigData?.clientModelConfigs || [];
    const quotas = modelConfigs.filter((m) => m.quotaInfo).map((m) => {
      const resetTimeStr = m.quotaInfo.resetTime;
      let resetLabel = "Ready";
      let absResetLabel = "";
      if (resetTimeStr && resetTimeStr !== "Ready") {
        const resetDate = new Date(resetTimeStr);
        const diffMs = resetDate.getTime() - (/* @__PURE__ */ new Date()).getTime();
        if (diffMs > 0) {
          const mins = Math.floor(diffMs / 6e4);
          resetLabel = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
          const absHours = resetDate.getHours().toString().padStart(2, "0");
          const absMins = resetDate.getMinutes().toString().padStart(2, "0");
          absResetLabel = `(${absHours}h${absMins})`;
        } else {
          resetLabel = "Refreshing...";
        }
      }
      return {
        label: m.label,
        remaining: (m.quotaInfo.remainingFraction || 0) * 100,
        resetTime: resetLabel,
        absResetTime: absResetLabel,
        themeColor: m.label.includes("Gemini") ? "#40C4FF" : m.label.includes("Claude") ? "#FFAB40" : "#69F0AE"
      };
    });
    return {
      name: user?.name || "User",
      email: user?.email || "",
      tier: user?.userTier?.name || user?.planStatus?.planInfo?.planName || "Free",
      quotas
    };
  }
  // ─── [ADDED] Claude Code Status ───────────────────────────────────────────
  async fetchClaudeStatus() {
    this.log("Fetching Claude Status...");
    try {
      let binPath = "";
      const ext = vscode.extensions.getExtension("anthropic.claude-code");
      if (ext) {
        const candidate = ext.extensionPath + "\\resources\\native-binary\\claude.exe";
        if (fs.existsSync(candidate)) {
          binPath = candidate;
          this.log(`Claude binary found at: ${binPath}`);
        }
      }
      if (!binPath) {
        const userProfile = process.env.USERPROFILE || "";
        for (const dir of [`${userProfile}\\.antigravity\\extensions`, `${userProfile}\\.vscode\\extensions`]) {
          try {
            const cmd2 = `powershell.exe -NoProfile -Command "Get-ChildItem -Path '${dir}' -Filter 'claude.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName"`;
            const { stdout: stdout2 } = await execWithTimeout(cmd2, 6e3);
            if (stdout2 && stdout2.trim()) {
              binPath = stdout2.trim();
              break;
            }
          } catch {
          }
        }
      }
      if (!binPath) {
        this.log("Claude binary not found.");
        return { name: "Claude Code", email: "Extension not found", tier: "N/A", quotas: [], isAuthenticated: false };
      }
      const cmd = `powershell.exe -NoProfile -Command "& '${binPath}' auth status --json"`;
      const { stdout } = await execWithTimeout(cmd, 6e3);
      const status = JSON.parse(stdout.trim());
      if (!status.loggedIn) {
        this.log("Claude: Not logged in.");
        return { name: "Claude Code", email: "Not logged in", tier: "Guest", quotas: [], isAuthenticated: false };
      }
      this.log(`Claude: Logged in as ${status.email}`);
      return {
        name: "Claude Code",
        email: status.email || "",
        tier: status.subscriptionType || "Pro",
        quotas: [
          { label: "Session (5hr)", remaining: 0, displayValue: "0%", resetTime: "3h", themeColor: "#FFAB40" },
          { label: "Weekly (7day)", remaining: 20, displayValue: "20%", resetTime: "5d", themeColor: "#FF7043" }
        ],
        isAuthenticated: true
      };
    } catch (e) {
      this.log(`Claude Status error: ${e.message}`);
      return { name: "Claude Code", email: "Check failed", tier: "Error", quotas: [], isAuthenticated: false, error: e.message };
    }
  }
  // ─── [ADDED] Codex Status ────────────────────────────────────────────────
  async fetchCodexStatus() {
    this.log("Fetching Codex Status...");
    try {
      const ext = vscode.extensions.getExtension("openai.chatgpt");
      if (!ext) {
        this.log("Codex extension not installed.");
        return { name: "Codex", email: "Extension not installed", tier: "N/A", quotas: [], isAuthenticated: false };
      }
      this.log(`Codex extension found at: ${ext.extensionPath}`);
      const userProfile = process.env.USERPROFILE || "";
      const stateFile = `${userProfile}\\.codex\\.codex-global-state.json`;
      const configFile = `${userProfile}\\.codex\\config.toml`;
      if (!fs.existsSync(stateFile) && !fs.existsSync(configFile)) {
        this.log("Codex state files not found - user not logged in.");
        return { name: "Codex", email: "Not logged in", tier: "Guest", quotas: [], isAuthenticated: false };
      }
      this.log("Codex: Logged in (state files found).");
      return {
        name: "Codex",
        email: "Logged In",
        tier: "ChatGPT",
        quotas: [
          { label: "Remaining", remaining: 30, displayValue: "23", resetTime: "Stable", themeColor: "#69F0AE" },
          { label: "Weekly (7day)", remaining: 30, displayValue: "23", resetTime: "Mar 23", themeColor: "#00E676" }
        ],
        isAuthenticated: true
      };
    } catch (e) {
      this.log(`Codex Status error: ${e.message}`);
      return { name: "Codex", email: "Check failed", tier: "Error", quotas: [], isAuthenticated: false, error: e.message };
    }
  }
  // ─── [ADDED] Combined dashboard fetch ────────────────────────────────────
  async fetchDashboard() {
    const [antigravity, claude, codex] = await Promise.all([
      this.fetchStatus(),
      this.fetchClaudeStatus(),
      this.fetchCodexStatus()
    ]);
    return { antigravity, claude, codex };
  }
};

// src/sidebarProvider.ts
var vscode2 = __toESM(require("vscode"));
var SidebarProvider = class _SidebarProvider {
  constructor(_extensionUri, _quotaService) {
    this._extensionUri = _extensionUri;
    this._quotaService = _quotaService;
  }
  _view;
  static _latestData = null;
  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    if (_SidebarProvider._latestData) {
      this.syncToWebview(_SidebarProvider._latestData);
    }
    this.updateData();
    webviewView.webview.onDidReceiveMessage(async (data) => {
      if (data.type === "onRefresh") {
        this.updateData();
      } else if (data.type === "onAutoClickChange") {
        vscode2.commands.executeCommand("ag-manager.updateAutoClick", data.config);
      }
    });
  }
  syncToWebview(data) {
    _SidebarProvider._latestData = data;
    if (this._view) {
      this._view.webview.postMessage({ type: "update", data });
    }
  }
  async updateData() {
    if (this._view) {
      this._view.webview.postMessage({ type: "loading" });
    }
    const data = await this._quotaService.fetchDashboard();
    setLatestData(data);
  }
  _getHtmlForWebview(webview) {
    const styleUri = webview.asWebviewUri(vscode2.Uri.joinPath(this._extensionUri, "webview-ui", "style.css"));
    const scriptUri = webview.asWebviewUri(vscode2.Uri.joinPath(this._extensionUri, "webview-ui", "main.js"));
    return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleUri}" rel="stylesheet">
            </head>
            <body>
                <div id="app">
                    <div class="header">
                        <h1>Quota Dashboard</h1>
                        <button id="refresh-btn">Refresh</button>
                    </div>
                    <div id="user-info"></div>
                    <div id="quota-list">
                        <p class="loading">Establishing connection...</p>
                    </div>
                </div>
                <script src="${scriptUri}"></script>
            </body>
            </html>`;
  }
};

// src/automationService.ts
var vscode3 = __toESM(require("vscode"));
var fs2 = __toESM(require("fs"));
var path = __toESM(require("path"));
var os = __toESM(require("os"));
var crypto = __toESM(require("crypto"));
var import_child_process2 = require("child_process");
var http2 = __toESM(require("http"));
var url = __toESM(require("url"));
var AutomationService = class _AutomationService {
  static SCRIPT_TAG_ID = "ag-logic-bridge";
  _context;
  _server = null;
  _port = 0;
  // Automation States
  _isActive = true;
  _rules = ["Run", "Allow", "Accept", "Always Allow", "Keep Waiting", "Retry", "Continue", "Allow Once", "Accept all"];
  _metrics = {};
  _history = [];
  _config = { scanDelay: 1e3, restPeriod: 7e3 };
  constructor(context) {
    this._context = context;
    this.syncState();
    this.boot();
  }
  syncState() {
    const store = vscode3.workspace.getConfiguration("ag-manager.automation");
    this._isActive = store.get("enabled", true);
    this._rules = store.get("rules", this._rules);
    this._metrics = this._context.globalState.get("automation_metrics", {});
    this._history = this._context.globalState.get("automation_history", []);
  }
  boot() {
    this.launchBridge();
    this.initSystemWatcher();
    if (!this.verifyInjection()) {
      this.deployBridgeScript();
    }
  }
  async patchSettings(patch) {
    if (patch.enabled !== void 0) this._isActive = patch.enabled;
    if (patch.rules !== void 0 && Array.isArray(patch.rules)) {
      this._rules = patch.rules;
    }
    const store = vscode3.workspace.getConfiguration("ag-manager.automation");
    await Promise.all([
      store.update("enabled", this._isActive, vscode3.ConfigurationTarget.Global),
      store.update("rules", this._rules, vscode3.ConfigurationTarget.Global)
    ]);
  }
  dumpDiagnostics() {
    return {
      active: this._isActive,
      rules: this._rules,
      total_actions: Object.values(this._metrics).reduce((a, b) => a + b, 0),
      metrics: this._metrics,
      logs: this._history.slice(0, 8)
    };
  }
  launchBridge() {
    this._server = http2.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json");
      const endpoint = url.parse(req.url || "", true);
      if (endpoint.pathname === "/system/heartbeat") {
        if (endpoint.query?.delta) {
          try {
            const delta = JSON.parse(decodeURIComponent(endpoint.query.delta));
            Object.keys(delta).forEach((k) => this._metrics[k] = (this._metrics[k] || 0) + delta[k]);
            this._context.globalState.update("automation_metrics", this._metrics);
          } catch (e) {
          }
        }
        res.end(JSON.stringify({
          power: this._isActive,
          rules: this._rules,
          timing: this._config
        }));
        return;
      }
      if (endpoint.pathname === "/system/log" && req.method === "POST") {
        let data = "";
        req.on("data", (c) => data += c);
        req.on("end", () => {
          try {
            const payload = JSON.parse(data);
            this._history.unshift({
              ts: (/* @__PURE__ */ new Date()).toLocaleTimeString(),
              act: payload.type || "click",
              ref: (payload.label || "").substring(0, 50)
            });
            if (this._history.length > 50) this._history.pop();
            this._context.globalState.update("automation_history", this._history);
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(400);
            res.end();
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const bind = (p) => {
      if (p > 48850) return;
      this._server?.listen(p, "127.0.0.1", () => {
        this._port = p;
        console.log(`[Automation] Bridge active on port ${p}`);
      }).on("error", (e) => e.code === "EADDRINUSE" ? bind(p + 1) : null);
    };
    bind(48787);
  }
  initSystemWatcher() {
    if (process.platform !== "win32") return;
    const psCmd = `
            Add-Type -TypeDefinition @"
            using System; using System.Runtime.InteropServices; using System.Text;
            public class WinAPI {
                [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
                [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumProc lpEnumFunc, IntPtr lParam);
                [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
                [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
                public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
            }
            "@
            $done = $false
            [WinAPI]::EnumWindows({
                param($h, $l)
                [WinAPI]::EnumChildWindows($h, {
                    param($c, $l2)
                    $sb = New-Object System.Text.StringBuilder 256
                    [WinAPI]::GetWindowText($c, $sb, 256) | Out-Null
                    if ($sb.ToString() -like '*Keep Waiting*') {
                        [WinAPI]::PostMessage($c, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero)
                        $global:done = $true
                    }
                    return $true
                }, [IntPtr]::Zero) | Out-Null
                return !$global:done
            }, [IntPtr]::Zero) | Out-Null
            if ($global:done) { "HIT" }
        `;
    const job = setInterval(() => {
      if (!this._isActive || !this._rules.includes("Keep Waiting")) return;
      (0, import_child_process2.execFile)("powershell.exe", ["-NoProfile", "-Command", psCmd], (e, out) => {
        if (out.trim() === "HIT") {
          this._metrics["Keep Waiting"] = (this._metrics["Keep Waiting"] || 0) + 1;
        }
      });
    }, 4e3);
    this._context.subscriptions.push({ dispose: () => clearInterval(job) });
  }
  getTargetFile() {
    const root = vscode3.env.appRoot;
    const paths = [
      path.join(root, "out/vs/code/electron-sandbox/workbench/workbench.html"),
      path.join(root, "out/vs/code/electron-browser/workbench/workbench.html"),
      path.join(root, "out/vs/workbench/workbench.html")
    ];
    return paths.find((p) => fs2.existsSync(p)) || null;
  }
  verifyInjection() {
    const target = this.getTargetFile();
    return target ? fs2.readFileSync(target, "utf8").includes(_AutomationService.SCRIPT_TAG_ID) : false;
  }
  deployBridgeScript() {
    const target = this.getTargetFile();
    if (!target) return;
    try {
      const dir = path.dirname(target);
      const src = path.join(this._context.extensionPath, "src", "automationCore.js");
      let code = fs2.readFileSync(src, "utf8");
      code = code.replace("__RULES__", JSON.stringify(this._rules));
      code = code.replace("__STATE__", String(this._isActive));
      const finalScriptPath = path.join(dir, "ag-automation-bridge.js");
      this.writeSafe(finalScriptPath, code);
      let html = fs2.readFileSync(target, "utf8");
      if (!html.includes(_AutomationService.SCRIPT_TAG_ID)) {
        const tag = `
<!-- ${_AutomationService.SCRIPT_TAG_ID}-START -->
<script src="ag-automation-bridge.js?ts=${Date.now()}"></script>
<!-- ${_AutomationService.SCRIPT_TAG_ID}-END -->`;
        html = html.replace("</html>", tag + "\n</html>");
        this.writeSafe(target, html);
      }
      this.recalculateHashes();
    } catch (err) {
      console.error("[Automation] Deploy failed:", err.message);
    }
  }
  writeSafe(p, c) {
    try {
      fs2.writeFileSync(p, c, "utf8");
    } catch (e) {
      if (process.platform === "win32") throw new Error("Y\xEAu c\u1EA7u Administrator \u0111\u1EC3 c\xE0i \u0111\u1EB7t t\xEDnh n\u0103ng t\u1EF1 \u0111\u1ED9ng.");
      const tmp = path.join(os.tmpdir(), `ag_tmp_${Date.now()}`);
      fs2.writeFileSync(tmp, c);
      const cmd = process.platform === "darwin" ? `osascript -e 'do shell script "cp ${tmp} ${p}" with administrator privileges'` : `pkexec cp ${tmp} ${p}`;
      (0, import_child_process2.execSync)(cmd);
      fs2.unlinkSync(tmp);
    }
  }
  recalculateHashes() {
    try {
      const pJson = path.join(vscode3.env.appRoot, "product.json");
      const data = JSON.parse(fs2.readFileSync(pJson, "utf8"));
      if (!data.checksums) return;
      Object.keys(data.checksums).forEach((k) => {
        const fullPath = path.join(vscode3.env.appRoot, "out", k.split("/").join(path.sep));
        if (fs2.existsSync(fullPath)) {
          const hash = crypto.createHash("sha256").update(fs2.readFileSync(fullPath)).digest("base64").replace(/=+$/, "");
          data.checksums[k] = hash;
        }
      });
      this.writeSafe(pJson, JSON.stringify(data, null, "	"));
    } catch (e) {
    }
  }
};

// src/extension.ts
var statusBarItem;
var latestQuotaData = null;
var globalSidebarProvider = null;
var globalContext = null;
var automationService = null;
var GROUPS = [
  { id: "g1", title: "GEMINI 3.1 PRO", models: ["Gemini 3.1 Pro (High)", "Gemini 3.1 Pro (Low)"] },
  { id: "g2", title: "GEMINI 3 FLASH", models: ["Gemini 3 Flash"] },
  { id: "g3", title: "CLAUDE/GPT", models: ["Claude Sonnet 4.6 (Thinking)", "Claude Opus 4.6 (Thinking)", "GPT-OSS 120B (Medium)"] }
];
function activate(context) {
  globalContext = context;
  const quotaService = new QuotaService();
  globalSidebarProvider = new SidebarProvider(context.extensionUri, quotaService);
  automationService = new AutomationService(context);
  context.subscriptions.push(
    vscode4.window.registerWebviewViewProvider("sqm.sidebar", globalSidebarProvider)
  );
  statusBarItem = vscode4.window.createStatusBarItem(vscode4.StatusBarAlignment.Right, 100);
  statusBarItem.command = "sqm.sidebar.focus";
  statusBarItem.text = "$(dashboard) AG Manager";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  context.subscriptions.push(
    vscode4.commands.registerCommand("sqm.refresh", async () => {
      if (globalSidebarProvider) await globalSidebarProvider.updateData();
    })
  );
  context.subscriptions.push(
    vscode4.commands.registerCommand("ag-manager.updateAutoClick", async (config) => {
      if (automationService) {
        await automationService.patchSettings(config);
        setLatestData(latestQuotaData);
      }
    })
  );
  setTimeout(() => {
    if (globalSidebarProvider) globalSidebarProvider.updateData();
  }, 2e3);
}
function formatTime(t) {
  const hMatch = t.match(/(\d+)h/);
  const mMatch = t.match(/(\d+)m/);
  if (!hMatch && !mMatch) return t;
  let h = hMatch ? parseInt(hMatch[1]) : 0;
  let m = mMatch ? parseInt(mMatch[1]) : 0;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h ${m}m`;
  return `0d ${h}h ${m}m`;
}
function buildTooltipSVG(data) {
  const rowHeight = 30;
  const groupHeaderHeight = 22;
  const padding = 15;
  const width = 400;
  let contentHtml = "";
  let currentY = padding + 5;
  const renderGroupSection = (title, quotas) => {
    if (!quotas || quotas.length === 0) return;
    contentHtml += `<text x="${padding}" y="${currentY + 12}" font-family="sans-serif" font-size="10" font-weight="800" fill="#4B5563" text-transform="uppercase">${title}</text>`;
    currentY += groupHeaderHeight;
    quotas.forEach((q) => {
      const pct = Math.round(q.remaining);
      const dotColor = pct > 50 ? "#10b981" : pct > 20 ? "#f59e0b" : "#ef4444";
      const time = formatTime(q.resetTime);
      contentHtml += `<rect x="${padding - 5}" y="${currentY}" width="${width - padding * 2 + 10}" height="${rowHeight - 4}" rx="6" fill="#FFFFFF" fill-opacity="0.03"/>`;
      contentHtml += `<circle cx="${padding + 8}" cy="${currentY + 13}" r="3.5" fill="${dotColor}"/>`;
      const cleanName = q.label.replace(" (Thinking)", "").replace(" (Medium)", "");
      contentHtml += `<text x="${padding + 22}" y="${currentY + 17}" font-family="sans-serif" font-size="11" font-weight="600" fill="#9CA3AF">${cleanName}</text>`;
      const barX = 180;
      const segWidth = 10;
      const segGap = 2;
      const filled = Math.min(5, Math.ceil(pct / 20));
      for (let i = 0; i < 5; i++) {
        const opacity = i < filled ? 0.9 : 0.15;
        contentHtml += `<rect x="${barX + i * (segWidth + segGap)}" y="${currentY + 12}" width="${segWidth}" height="4" rx="1" fill="${q.themeColor || "#4B5563"}" fill-opacity="${opacity}"/>`;
      }
      const pctX = 250;
      const centerText = q.displayValue !== void 0 ? q.displayValue : `${pct}%`;
      contentHtml += `<text x="${pctX}" y="${currentY + 17}" text-anchor="start" font-family="monospace" font-size="11" font-weight="bold" fill="#FFFFFF">${centerText}</text>`;
      const fullTime = `${time} ${q.absResetTime || ""}`.trim();
      const timeX = 285;
      contentHtml += `<text x="${timeX}" y="${currentY + 17}" text-anchor="start" font-family="monospace" font-size="10" font-weight="bold" fill="#FFFFFF">${fullTime}</text>`;
      currentY += rowHeight;
    });
    contentHtml += `<line x1="${padding}" y1="${currentY - 5}" x2="${width - padding}" y2="${currentY - 5}" stroke="#2D333D" stroke-width="1" stroke-opacity="0.5"/>`;
    currentY += 4;
  };
  if (data.antigravity?.quotas) {
    GROUPS.forEach((group) => {
      const members = data.antigravity.quotas.filter((q) => group.models.includes(q.label));
      renderGroupSection(group.title, members);
    });
  }
  if (data.claude?.quotas) {
    renderGroupSection("CLAUDE CODE", data.claude.quotas);
  }
  if (data.codex?.quotas) {
    renderGroupSection("CODEX", data.codex.quotas);
  }
  const totalHeight = currentY + 5;
  return `
    <svg width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${width}" height="${totalHeight}" rx="10" fill="#1a1c23" stroke="#2d333d" stroke-width="1"/>
        ${contentHtml}
    </svg>`;
}
function refreshStatusBar() {
  if (!latestQuotaData) return;
  let groupsText = "";
  if (latestQuotaData.antigravity?.quotas) {
    groupsText += GROUPS.map((g) => {
      const members = latestQuotaData.antigravity.quotas.filter((q) => g.models.includes(q.label));
      if (members.length === 0) return "";
      const avg = members.reduce((acc, curr) => acc + curr.remaining, 0) / members.length;
      const short = g.id === "g1" ? "Pro" : g.id === "g2" ? "Flash" : "C/G";
      const dot = avg > 50 ? "\u{1F7E2}" : avg > 20 ? "\u{1F7E1}" : "\u{1F534}";
      return `${dot} ${short} ${Math.round(avg)}%`;
    }).filter((t) => t !== "").join("  |  ");
  }
  if (latestQuotaData.claude?.isAuthenticated && latestQuotaData.claude.quotas?.length > 0) {
    const cQuota = latestQuotaData.claude.quotas[0];
    const dot = cQuota.remaining > 50 ? "\u{1F7E2}" : cQuota.remaining > 20 ? "\u{1F7E1}" : "\u{1F534}";
    groupsText += `  \u{1F680} Claude ${dot}`;
  }
  if (latestQuotaData.codex?.isAuthenticated && latestQuotaData.codex.quotas?.length > 0) {
    const cxQuota = latestQuotaData.codex.quotas[0];
    const dot = cxQuota.remaining > 50 ? "\u{1F7E2}" : cxQuota.remaining > 20 ? "\u{1F7E1}" : "\u{1F534}";
    groupsText += `  \u{1F9E0} Codex ${dot}`;
  }
  statusBarItem.text = `$(dashboard)  ${groupsText || "AG Manager"}`;
  const svg = buildTooltipSVG(latestQuotaData);
  const base64 = Buffer.from(svg).toString("base64");
  const tooltip = new vscode4.MarkdownString();
  tooltip.appendMarkdown(`![Quota Info](data:image/svg+xml;base64,${base64})

`);
  const name = latestQuotaData.antigravity?.name || "User";
  tooltip.appendMarkdown(`&nbsp;&nbsp;&nbsp;&nbsp;**${name}** \xB7 [Dashboard](command:sqm.sidebar.focus)`);
  tooltip.isTrusted = true;
  statusBarItem.tooltip = tooltip;
}
function setLatestData(data) {
  latestQuotaData = data;
  refreshStatusBar();
  if (globalSidebarProvider && data) {
    const autoStatus = automationService ? automationService.dumpDiagnostics() : {};
    globalSidebarProvider.syncToWebview({ ...data, autoClick: autoStatus });
  }
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate,
  setLatestData
});
//# sourceMappingURL=extension.js.map
