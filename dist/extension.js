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
var vscode5 = __toESM(require("vscode"));

// src/quotaService.ts
var http = __toESM(require("http"));
var https = __toESM(require("https"));
var import_child_process = require("child_process");
var import_util = require("util");
var vscode = __toESM(require("vscode"));
var fs = __toESM(require("fs"));
var os = __toESM(require("os"));
var path = __toESM(require("path"));
var execAsync = (0, import_util.promisify)(import_child_process.exec);
async function execWithTimeout(command, timeoutMs = 8e3) {
  return new Promise((resolve, reject) => {
    let child;
    const timer = setTimeout(() => {
      child?.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const options = process.platform === "win32" ? { shell: "powershell.exe" } : {};
    child = (0, import_child_process.exec)(command, options, (error, stdout, stderr) => {
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
  cachedClaude = null;
  claudeLastFetch = 0;
  cachedCodex = null;
  codexLastFetch = 0;
  CACHE_TTL = 12e4;
  // 120 seconds (OAuth endpoint rate-limits aggressively)
  logger;
  constructor(logger) {
    this.logger = logger;
  }
  log(msg) {
    this.logger?.appendLine(`[${(/* @__PURE__ */ new Date()).toLocaleTimeString()}] [QuotaService] ${msg}`);
  }
  getClaudeLocalConfig() {
    const sqmConfig = vscode.workspace.getConfiguration("sqm");
    let organizationId = sqmConfig.get("claude.organizationId")?.trim() || "";
    let email = "";
    let displayName = "";
    let subscriptionType = "";
    try {
      const claudeConfigPath = path.join(os.homedir(), ".claude.json");
      if (fs.existsSync(claudeConfigPath)) {
        const raw = fs.readFileSync(claudeConfigPath, "utf8");
        const parsed = JSON.parse(raw);
        const oauth = parsed?.oauthAccount;
        if (oauth) {
          if (!organizationId && oauth.organizationUuid) {
            organizationId = oauth.organizationUuid;
          }
          email = oauth.emailAddress || "";
          displayName = oauth.displayName || "";
        }
      }
    } catch (e) {
      this.log(`Failed to read ~/.claude.json: ${e?.message}`);
    }
    const usagePeriod = sqmConfig.get("claude.usagePeriod") || "both";
    return { organizationId, email, displayName, subscriptionType, usagePeriod };
  }
  async getClaudeOAuthToken() {
    try {
      if (process.platform === "darwin") {
        const { stdout } = await execWithTimeout(
          'security find-generic-password -s "Claude Code-credentials" -w',
          5e3
        );
        const creds = JSON.parse(stdout.trim());
        const oauth = creds?.claudeAiOauth;
        if (oauth?.accessToken) {
          return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt || 0 };
        }
      } else {
        const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
        if (fs.existsSync(credPath)) {
          const raw = fs.readFileSync(credPath, "utf8");
          const creds = JSON.parse(raw);
          const oauth = creds?.claudeAiOauth;
          if (oauth?.accessToken) {
            return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt || 0 };
          }
        }
      }
    } catch (e) {
      this.log(`OAuth token extraction failed: ${e?.message}`);
    }
    return null;
  }
  async fetchClaudeUsageOAuth(accessToken) {
    return new Promise((resolve, reject) => {
      const options = {
        method: "GET",
        hostname: "api.anthropic.com",
        path: "/api/oauth/usage",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "Content-Type": "application/json",
          "User-Agent": "auto-quota-antigravity/1.4.0"
        },
        timeout: 1e4
      };
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          if (res.statusCode === 429) {
            return reject(new Error("RATE_LIMITED"));
          }
          if (res.statusCode === 401) {
            return reject(new Error("OAuth token expired. Run any claude command to refresh."));
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Timeout"));
      });
      req.end();
    });
  }
  buildClaudeQuotas(usageData, usagePeriod) {
    const quotas = [];
    const five = usageData?.five_hour;
    const seven = usageData?.seven_day;
    const sevenSonnet = usageData?.seven_day_sonnet;
    const sevenOpus = usageData?.seven_day_opus;
    const parseResetTime = (resetsAt) => {
      if (!resetsAt) return { resetLabel: "", absLabel: "" };
      try {
        const resetDate = new Date(resetsAt);
        const diffMs = resetDate.getTime() - Date.now();
        if (diffMs <= 0) return { resetLabel: "Refreshing...", absLabel: "" };
        const mins = Math.floor(diffMs / 6e4);
        const resetLabel = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
        const absHours = resetDate.getHours().toString().padStart(2, "0");
        const absMins = resetDate.getMinutes().toString().padStart(2, "0");
        return { resetLabel, absLabel: `(${absHours}h${absMins})` };
      } catch {
        return { resetLabel: "", absLabel: "" };
      }
    };
    const pushQuota = (data, label, color, defaultReset) => {
      if (!data) return;
      const pct = Math.max(0, Math.min(100, Number(data.utilization || 0)));
      const { resetLabel, absLabel } = parseResetTime(data.resets_at);
      quotas.push({
        label,
        remaining: pct,
        displayValue: `${Math.round(pct)}%`,
        resetTime: resetLabel || defaultReset,
        absResetTime: absLabel,
        themeColor: color,
        style: "fluid",
        direction: "up"
      });
    };
    if (usagePeriod === "5-hour" || usagePeriod === "both") {
      pushQuota(five, "Session (5hr)", "#FFAB40", "5h");
    }
    if (usagePeriod === "7-day" || usagePeriod === "both") {
      pushQuota(seven, "Weekly (7day)", "#FF7043", "7d");
      pushQuota(sevenSonnet, "Sonnet (7day)", "#FFA726", "7d");
      pushQuota(sevenOpus, "Opus (7day)", "#AB47BC", "7d");
    }
    return quotas;
  }
  async discoverLocalServer() {
    if (this.discovering) return this.discovering;
    this.discovering = (async () => {
      try {
        let stdout = "";
        if (process.platform === "win32") {
          const command = `powershell -ExecutionPolicy Bypass -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'csrf_token' } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"`;
          const res = await execAsync(command);
          stdout = res.stdout;
        } else {
          const command = "ps -eo pid,command | grep csrf_token | grep -v grep";
          const res = await execAsync(command);
          const lines = res.stdout.trim().split("\n");
          const arr = lines.map((line) => {
            const match = line.trim().match(/^(\d+)\s+(.+)$/);
            if (match) {
              return { ProcessId: parseInt(match[1]), CommandLine: match[2] };
            }
            return null;
          }).filter(Boolean);
          stdout = JSON.stringify(arr);
        }
        if (!stdout || stdout.trim() === "" || stdout.trim() === "[]") return false;
        let processes = [];
        try {
          const parsed = JSON.parse(stdout.trim());
          processes = Array.isArray(parsed) ? parsed : [parsed];
        } catch (e) {
          this.log(`Process discovery parse error: ${e?.message}`);
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
      if (process.platform === "win32") {
        const cmd = `powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique"`;
        const { stdout } = await execAsync(cmd);
        return stdout.trim().split(/\r?\n/).map((p) => parseInt(p.trim())).filter((p) => !isNaN(p) && p > 1024);
      } else {
        const cmd = `lsof -a -p ${pid} -i4TCP -sTCP:LISTEN -P -n | awk 'NR>1 {print $9}' | awk -F':' '{print $NF}' | sort -u`;
        const { stdout } = await execAsync(cmd);
        return stdout.trim().split(/\r?\n/).map((p) => parseInt(p.trim())).filter((p) => !isNaN(p) && p > 1024);
      }
    } catch (e) {
      this.log(`getListeningPorts failed for PID ${pid}: ${e?.message}`);
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
    const now = Date.now();
    if (this.cachedClaude && now - this.claudeLastFetch < this.CACHE_TTL) {
      return this.cachedClaude;
    }
    this.cachedClaude = await this._fetchClaudeStatusImpl();
    this.claudeLastFetch = now;
    return this.cachedClaude;
  }
  async _fetchClaudeStatusImpl() {
    this.log("Fetching Claude Status...");
    try {
      const localConfig = this.getClaudeLocalConfig();
      let authStatus = null;
      try {
        let binPath = "";
        const exeName = process.platform === "win32" ? "claude.exe" : "claude";
        const ext = vscode.extensions.getExtension("anthropic.claude-code");
        if (ext) {
          const candidate = path.join(ext.extensionPath, "resources", "native-binary", exeName);
          if (fs.existsSync(candidate)) binPath = candidate;
        }
        if (!binPath) {
          const home = os.homedir();
          for (const dir of [path.join(home, ".antigravity", "extensions"), path.join(home, ".vscode", "extensions")]) {
            try {
              const cmd = process.platform === "win32" ? `powershell.exe -NoProfile -Command "Get-ChildItem -Path '${dir}' -Filter '${exeName}' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName"` : `find "${dir}" -name "${exeName}" -type f 2>/dev/null | head -n 1`;
              const { stdout } = await execWithTimeout(cmd, 6e3);
              if (stdout?.trim()) {
                binPath = stdout.trim();
                break;
              }
            } catch (e) {
              this.log(`Claude binary search in ${dir}: ${e?.message}`);
            }
          }
        }
        if (binPath) {
          const cmd = process.platform === "win32" ? `powershell.exe -NoProfile -Command "& '${binPath}' auth status --json"` : `"${binPath}" auth status --json`;
          const { stdout } = await execWithTimeout(cmd, 6e3);
          authStatus = JSON.parse(stdout.trim());
        }
      } catch (e) {
        this.log(`Claude CLI auth status failed: ${e?.message}`);
      }
      const isLoggedIn = authStatus?.loggedIn ?? !!localConfig.email;
      const email = authStatus?.email || localConfig.email || "";
      const tier = authStatus?.subscriptionType || localConfig.subscriptionType || "Unknown";
      const displayName = localConfig.displayName || "Claude Code";
      if (!isLoggedIn) {
        return { name: "Claude Code", email: "Not logged in", tier: "Guest", quotas: [], isAuthenticated: false };
      }
      const oauthToken = await this.getClaudeOAuthToken();
      if (!oauthToken) {
        return {
          name: displayName,
          email,
          tier,
          quotas: [],
          isAuthenticated: true,
          error: "OAuth token not found \u2014 run `claude auth login`"
        };
      }
      let usageData;
      try {
        usageData = await this.fetchClaudeUsageOAuth(oauthToken.accessToken);
      } catch (e) {
        if (e?.message === "RATE_LIMITED" && this.cachedClaude) {
          this.log("Rate limited \u2014 returning cached Claude data");
          return this.cachedClaude;
        }
        return {
          name: displayName,
          email,
          tier,
          quotas: [],
          isAuthenticated: true,
          error: e?.message || "Usage fetch failed"
        };
      }
      const quotas = this.buildClaudeQuotas(usageData, localConfig.usagePeriod);
      return {
        name: displayName,
        email,
        tier,
        quotas,
        isAuthenticated: true,
        error: quotas.length === 0 ? "No usage data returned" : void 0
      };
    } catch (e) {
      this.log(`Claude Status error: ${e.message}`);
      return { name: "Claude Code", email: "Check failed", tier: "Error", quotas: [], isAuthenticated: false, error: e.message };
    }
  }
  // ─── [ADDED] Codex Status ────────────────────────────────────────────────
  async fetchCodexStatus() {
    const now = Date.now();
    if (this.cachedCodex && now - this.codexLastFetch < this.CACHE_TTL) {
      return this.cachedCodex;
    }
    this.cachedCodex = await this._fetchCodexStatusImpl();
    this.codexLastFetch = now;
    return this.cachedCodex;
  }
  async _fetchCodexStatusImpl() {
    this.log("Fetching Codex Status...");
    try {
      const home = os.homedir();
      const authFile = path.join(home, ".codex", "auth.json");
      const configFile = path.join(home, ".codex", "config.toml");
      const ext = vscode.extensions.getExtension("openai.chatgpt");
      if (!ext && !fs.existsSync(authFile)) {
        return { name: "Codex", email: "Not installed", tier: "N/A", quotas: [], isAuthenticated: false };
      }
      if (!fs.existsSync(authFile)) {
        return { name: "Codex", email: "Not logged in", tier: "Guest", quotas: [], isAuthenticated: false };
      }
      let email = "";
      let planType = "Free";
      let model = "Unknown";
      try {
        const authData = JSON.parse(fs.readFileSync(authFile, "utf8"));
        const idToken = authData?.tokens?.id_token;
        if (idToken) {
          const parts = idToken.split(".");
          if (parts.length >= 2) {
            const payload = Buffer.from(parts[1], "base64url").toString("utf8");
            const claims = JSON.parse(payload);
            email = claims.email || "";
            const authInfo = claims["https://api.openai.com/auth"] || {};
            planType = authInfo.chatgpt_plan_type || "free";
          }
        }
      } catch (e) {
        this.log(`Codex JWT decode failed: ${e?.message}`);
      }
      try {
        if (fs.existsSync(configFile)) {
          const configRaw = fs.readFileSync(configFile, "utf8");
          const modelMatch = configRaw.match(/^model\s*=\s*"([^"]+)"/m);
          if (modelMatch) model = modelMatch[1];
        }
      } catch (e) {
        this.log(`Codex config read failed: ${e?.message}`);
      }
      this.log(`Codex: ${email} (${planType}), model: ${model}`);
      const tierDisplay = planType.charAt(0).toUpperCase() + planType.slice(1);
      return {
        name: "Codex",
        email,
        tier: tierDisplay,
        quotas: [{
          label: "Active Model",
          remaining: 0,
          displayValue: model,
          resetTime: "",
          themeColor: "#69F0AE",
          style: "fluid",
          direction: "up"
        }],
        isAuthenticated: true
      };
    } catch (e) {
      this.log(`Codex Status error: ${e.message}`);
      return { name: "Codex", email: "Check failed", tier: "Error", quotas: [], isAuthenticated: false, error: e.message };
    }
  }
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
var crypto = __toESM(require("crypto"));
function getNonce() {
  return crypto.randomBytes(16).toString("hex");
}
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
      } else if (data.type === "getSettings") {
        await this._sendSettings();
      } else if (data.type === "saveSettings") {
        await this._saveSettings(data.settings);
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
  async _sendSettings() {
    const sqm = vscode2.workspace.getConfiguration("sqm");
    const ag = vscode2.workspace.getConfiguration("ag-manager");
    this._view?.webview.postMessage({
      type: "settings",
      settings: {
        "claude.usagePeriod": sqm.get("claude.usagePeriod") || "both",
        "refreshInterval": sqm.get("refreshInterval") || 5,
        "enableNotifications": sqm.get("enableNotifications") !== false,
        "automation.enabled": ag.get("automation.enabled") !== false
      }
    });
  }
  async _saveSettings(settings) {
    const sqm = vscode2.workspace.getConfiguration("sqm");
    const ag = vscode2.workspace.getConfiguration("ag-manager");
    const target = vscode2.ConfigurationTarget.Global;
    for (const [key, value] of Object.entries(settings)) {
      if (key.startsWith("automation.")) {
        await ag.update(key, value, target);
      } else {
        await sqm.update(key, value, target);
      }
    }
    await this._sendSettings();
    this.updateData();
    vscode2.window.showInformationMessage("Settings saved!");
  }
  _getHtmlForWebview(webview) {
    const styleUri = webview.asWebviewUri(vscode2.Uri.joinPath(this._extensionUri, "webview-ui", "style.css"));
    const scriptUri = webview.asWebviewUri(vscode2.Uri.joinPath(this._extensionUri, "webview-ui", "main.js"));
    const nonce = getNonce();
    return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
                <link href="${styleUri}" rel="stylesheet">
            </head>
            <body>
                <div id="app">
                    <div class="header">
                        <h1>Quota Dashboard</h1>
                        <div class="header-actions">
                            <button id="settings-btn" title="Settings">&#9881;</button>
                            <button id="refresh-btn">Refresh</button>
                        </div>
                    </div>
                    <div id="settings-panel" class="settings-container hidden"></div>
                    <div id="user-info"></div>
                    <div id="quota-list">
                        <p class="loading">Establishing connection...</p>
                    </div>
                </div>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
  }
};

// src/automationService.ts
var vscode3 = __toESM(require("vscode"));
var fs2 = __toESM(require("fs"));
var path2 = __toESM(require("path"));
var os2 = __toESM(require("os"));
var crypto2 = __toESM(require("crypto"));
var import_child_process2 = require("child_process");
var http2 = __toESM(require("http"));
var url = __toESM(require("url"));
var AutomationService = class _AutomationService {
  static SCRIPT_TAG_ID = "ag-logic-bridge";
  _context;
  _server = null;
  _port = 0;
  _logger;
  _authToken = crypto2.randomBytes(32).toString("hex");
  // Automation States
  _isActive = true;
  _rules = ["Run", "Allow", "Accept", "Always Allow", "Keep Waiting", "Retry", "Continue", "Allow Once", "Accept all"];
  _metrics = {};
  _history = [];
  _config = { scanDelay: 1e3, restPeriod: 7e3 };
  constructor(context, logger) {
    this._context = context;
    this._logger = logger;
    this.syncState();
    this.boot();
  }
  log(msg) {
    this._logger?.appendLine(`[${(/* @__PURE__ */ new Date()).toLocaleTimeString()}] [Automation] ${msg}`);
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
    this.requestConsentAndDeploy();
  }
  async requestConsentAndDeploy() {
    const consented = this._context.globalState.get("automation_consent", false);
    if (consented) {
      this.deployBridgeScript();
      return;
    }
    if (this.verifyInjection()) {
      await this._context.globalState.update("automation_consent", true);
      this.deployBridgeScript();
      return;
    }
    const choice = await vscode3.window.showWarningMessage(
      "AG Manager Automation needs to inject a script into VS Code workbench to enable auto-click. This modifies VS Code internal files. Continue?",
      "Allow",
      "Deny"
    );
    if (choice === "Allow") {
      await this._context.globalState.update("automation_consent", true);
      this.deployBridgeScript();
    } else {
      this.log("User denied automation injection consent");
    }
  }
  removeBridgeScript() {
    const target = this.getTargetFile();
    if (!target) return;
    try {
      let html = fs2.readFileSync(target, "utf8");
      const startTag = `<!-- ${_AutomationService.SCRIPT_TAG_ID}-START -->`;
      const endTag = `<!-- ${_AutomationService.SCRIPT_TAG_ID}-END -->`;
      const startIdx = html.indexOf(startTag);
      const endIdx = html.indexOf(endTag);
      if (startIdx !== -1 && endIdx !== -1) {
        html = html.substring(0, startIdx) + html.substring(endIdx + endTag.length);
        html = html.replace(/\n\s*\n/g, "\n");
        this.writeSafe(target, html);
        this.recalculateHashes();
        this.log("Bridge script removed from workbench.html");
      }
      const dir = path2.dirname(target);
      const bridgeFile = path2.join(dir, "ag-automation-bridge.js");
      if (fs2.existsSync(bridgeFile)) {
        fs2.unlinkSync(bridgeFile);
      }
    } catch (err) {
      this.log(`Failed to remove bridge script: ${err.message}`);
    }
  }
  dispose() {
    this._server?.close();
    this._server = null;
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
      res.setHeader("Content-Type", "application/json");
      const authHeader = req.headers["authorization"] || "";
      const queryToken = url.parse(req.url || "", true).query?.token;
      const token = authHeader.replace("Bearer ", "") || queryToken || "";
      if (token !== this._authToken) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
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
      if (p > 48850) {
        this.log("Failed to bind bridge server: all ports 48787-48850 in use");
        vscode3.window.showWarningMessage("AG Automation: Could not start bridge server \u2014 all ports in use.");
        return;
      }
      this._server?.listen(p, "127.0.0.1", () => {
        this._port = p;
        this.log(`Bridge active on port ${p}`);
      }).on("error", (e) => {
        if (e.code === "EADDRINUSE") {
          bind(p + 1);
        } else {
          this.log(`Bridge bind error on port ${p}: ${e.message}`);
        }
      });
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
      path2.join(root, "out/vs/code/electron-sandbox/workbench/workbench.html"),
      path2.join(root, "out/vs/code/electron-browser/workbench/workbench.html"),
      path2.join(root, "out/vs/workbench/workbench.html")
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
      const dir = path2.dirname(target);
      const src = path2.join(this._context.extensionPath, "src", "automationCore.js");
      let code = fs2.readFileSync(src, "utf8");
      code = code.replace("__RULES__", JSON.stringify(this._rules));
      code = code.replace("__STATE__", String(this._isActive));
      code = code.replace("__AUTH_TOKEN__", JSON.stringify(this._authToken));
      const finalScriptPath = path2.join(dir, "ag-automation-bridge.js");
      this.writeSafe(finalScriptPath, code);
      let html = fs2.readFileSync(target, "utf8");
      const scriptTag = `<script src="ag-automation-bridge.js?ts=${Date.now()}"></script>`;
      if (html.includes(_AutomationService.SCRIPT_TAG_ID)) {
        const startTag = `<!-- ${_AutomationService.SCRIPT_TAG_ID}-START -->`;
        const endTag = `<!-- ${_AutomationService.SCRIPT_TAG_ID}-END -->`;
        const startIdx = html.indexOf(startTag);
        const endIdx = html.indexOf(endTag);
        if (startIdx !== -1 && endIdx !== -1) {
          html = html.substring(0, startIdx) + `${startTag}
${scriptTag}
${endTag}` + html.substring(endIdx + endTag.length);
          this.writeSafe(target, html);
        }
      } else {
        const tag = `
<!-- ${_AutomationService.SCRIPT_TAG_ID}-START -->
${scriptTag}
<!-- ${_AutomationService.SCRIPT_TAG_ID}-END -->`;
        html = html.replace("</html>", tag + "\n</html>");
        this.writeSafe(target, html);
      }
      this.recalculateHashes();
    } catch (err) {
      this.log(`Deploy failed: ${err.message}`);
      vscode3.window.showErrorMessage(`AG Automation: Failed to deploy bridge script \u2014 ${err.message}`);
    }
  }
  writeSafe(p, c) {
    try {
      fs2.writeFileSync(p, c, "utf8");
    } catch (e) {
      if (process.platform === "win32") throw new Error("Administrator privileges required to install automation.");
      const tmp = path2.join(os2.tmpdir(), `ag_tmp_${Date.now()}`);
      fs2.writeFileSync(tmp, c);
      try {
        const cmd = process.platform === "darwin" ? `osascript -e 'do shell script "cp ${tmp} ${p}" with administrator privileges'` : `pkexec cp ${tmp} ${p}`;
        (0, import_child_process2.execSync)(cmd);
      } finally {
        try {
          fs2.unlinkSync(tmp);
        } catch {
        }
      }
    }
  }
  recalculateHashes() {
    try {
      const pJson = path2.join(vscode3.env.appRoot, "product.json");
      const data = JSON.parse(fs2.readFileSync(pJson, "utf8"));
      if (!data.checksums) return;
      Object.keys(data.checksums).forEach((k) => {
        const fullPath = path2.join(vscode3.env.appRoot, "out", k.split("/").join(path2.sep));
        if (fs2.existsSync(fullPath)) {
          const hash = crypto2.createHash("sha256").update(fs2.readFileSync(fullPath)).digest("base64").replace(/=+$/, "");
          data.checksums[k] = hash;
        }
      });
      this.writeSafe(pJson, JSON.stringify(data, null, "	"));
    } catch (e) {
      this.log(`Hash recalculation failed: ${e?.message}`);
    }
  }
};

// src/updater.ts
var vscode4 = __toESM(require("vscode"));
var https2 = __toESM(require("https"));
var REPO_OWNER = "trinhvanhao";
var REPO_NAME = "Auto-Quota-Antigravity";
var API_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
async function checkForUpdates(context) {
  try {
    const currentVersion = context.extension.packageJSON.version;
    if (!currentVersion) return;
    const options = {
      headers: {
        "User-Agent": "VSCode-Auto-Quota-Antigravity-Extension"
      }
    };
    https2.get(API_URL, options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            const release = JSON.parse(data);
            const latestTag = release.tag_name;
            if (!latestTag) return;
            const latestVersion = latestTag.replace(/^v/, "");
            if (isNewerVersion(currentVersion, latestVersion)) {
              showUpdateNotification(latestVersion, release.html_url);
            }
          } catch (e) {
            console.error("Failed to parse GitHub release data", e);
          }
        }
      });
    }).on("error", (e) => {
      console.error("Error checking for updates:", e);
    });
  } catch (err) {
    console.error("Auto-Updater error:", err);
  }
}
function isNewerVersion(current, latest) {
  const currentParts = current.split(".").map(Number);
  const latestParts = latest.split(".").map(Number);
  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
    const c = currentParts[i] || 0;
    const l = latestParts[i] || 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}
async function showUpdateNotification(newVersion, url2) {
  const action = "T\u1EA3i V\u1EC1 Ngay";
  const message = `M\u1ED9t phi\xEAn b\u1EA3n m\u1EDBi c\u1EE7a Auto Quota Antigravity (v${newVersion}) \u0111\xE3 s\u1EB5n s\xE0ng!`;
  const result = await vscode4.window.showInformationMessage(message, action);
  if (result === action) {
    vscode4.env.openExternal(vscode4.Uri.parse(url2));
  }
}

// src/utils.ts
function formatTime(t) {
  const hMatch = t.match(/(\d+)h/);
  const mMatch = t.match(/(\d+)m/);
  if (!hMatch && !mMatch) return t;
  let h = hMatch ? parseInt(hMatch[1]) : 0;
  let m = mMatch ? parseInt(mMatch[1]) : 0;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h ${m}m`;
  return `0d ${h}h ${m}m`;
}
function getQuotaColor(pct, direction = "down") {
  if (direction === "up") {
    if (pct < 80) return { hex: "#FFAB40", dot: "\u{1F7E0}" };
    return { hex: "#ef4444", dot: "\u{1F534}" };
  } else {
    if (pct > 50) return { hex: "#10b981", dot: "\u{1F7E2}" };
    if (pct > 20) return { hex: "#f59e0b", dot: "\u{1F7E1}" };
    return { hex: "#ef4444", dot: "\u{1F534}" };
  }
}

// src/extension.ts
var statusBarItem;
var latestQuotaData = null;
var latestDataHash = "";
var latestAutoHash = "";
var globalSidebarProvider = null;
var automationService = null;
var refreshTimer = null;
var notifiedModels = /* @__PURE__ */ new Set();
function autoDetectGroups(quotas) {
  const groupMap = /* @__PURE__ */ new Map();
  for (const q of quotas) {
    const label = q.label;
    let groupKey;
    if (label.startsWith("Gemini")) {
      const match = label.match(/^(Gemini [\d.]+ \w+)/);
      groupKey = match ? match[1] : "Gemini";
    } else {
      groupKey = "Claude/GPT";
    }
    if (!groupMap.has(groupKey)) groupMap.set(groupKey, []);
    groupMap.get(groupKey).push(label);
  }
  return Array.from(groupMap.entries()).map(([key, models], i) => ({
    id: `g${i}`,
    title: key.toUpperCase(),
    models
  }));
}
function activate(context) {
  const logger = vscode5.window.createOutputChannel("Auto Quota Antigravity");
  context.subscriptions.push(logger);
  const quotaService = new QuotaService(logger);
  globalSidebarProvider = new SidebarProvider(context.extensionUri, quotaService);
  automationService = new AutomationService(context, logger);
  context.subscriptions.push(
    vscode5.window.registerWebviewViewProvider("sqm.sidebar", globalSidebarProvider)
  );
  statusBarItem = vscode5.window.createStatusBarItem(vscode5.StatusBarAlignment.Right, 100);
  statusBarItem.command = "sqm.sidebar.focus";
  statusBarItem.text = "$(dashboard) Auto Quota Antigravity";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  context.subscriptions.push(
    vscode5.commands.registerCommand("sqm.refresh", async () => {
      if (globalSidebarProvider) await globalSidebarProvider.updateData();
    })
  );
  context.subscriptions.push(
    vscode5.commands.registerCommand("ag-manager.updateAutoClick", async (config) => {
      if (automationService) {
        await automationService.patchSettings(config);
        if (latestQuotaData) setLatestData(latestQuotaData);
      }
    })
  );
  setTimeout(() => {
    if (globalSidebarProvider) globalSidebarProvider.updateData();
  }, 2e3);
  startAutoRefresh();
  context.subscriptions.push(vscode5.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("sqm.refreshInterval")) {
      startAutoRefresh();
    }
  }));
  setTimeout(() => {
    checkForUpdates(context);
  }, 1e4);
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
      const color = getQuotaColor(pct, q.direction || "down");
      const time = formatTime(q.resetTime);
      contentHtml += `<rect x="${padding - 5}" y="${currentY}" width="${width - padding * 2 + 10}" height="${rowHeight - 4}" rx="6" fill="#FFFFFF" fill-opacity="0.03"/>`;
      contentHtml += `<circle cx="${padding + 8}" cy="${currentY + 13}" r="3.5" fill="${color.hex}"/>`;
      const cleanName = q.label.replace(" (Thinking)", "").replace(" (Medium)", "");
      contentHtml += `<text x="${padding + 22}" y="${currentY + 17}" font-family="sans-serif" font-size="11" font-weight="600" fill="#9CA3AF">${cleanName}</text>`;
      const barX = 180;
      const barWidth = 60;
      if (q.style === "fluid") {
        const fillWidth = pct / 100 * barWidth;
        contentHtml += `<rect x="${barX}" y="${currentY + 12}" width="${barWidth}" height="4" rx="2" fill="#FFFFFF" fill-opacity="0.1"/>`;
        contentHtml += `<rect x="${barX}" y="${currentY + 12}" width="${fillWidth}" height="4" rx="2" fill="${q.themeColor || "#4B5563"}" fill-opacity="0.9"/>`;
      } else {
        const segWidth = 10;
        const segGap = 2;
        const filled = Math.min(5, Math.ceil(pct / 20));
        for (let i = 0; i < 5; i++) {
          const opacity = i < filled ? 0.9 : 0.15;
          contentHtml += `<rect x="${barX + i * (segWidth + segGap)}" y="${currentY + 12}" width="${segWidth}" height="4" rx="1" fill="${q.themeColor || "#4B5563"}" fill-opacity="${opacity}"/>`;
        }
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
    const groups = autoDetectGroups(data.antigravity.quotas);
    groups.forEach((group) => {
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
    const groups = autoDetectGroups(latestQuotaData.antigravity.quotas);
    groupsText += groups.map((g) => {
      const members = latestQuotaData.antigravity.quotas.filter((q) => g.models.includes(q.label));
      if (members.length === 0) return "";
      const avg = members.reduce((acc, curr) => acc + curr.remaining, 0) / members.length;
      const shortName = g.title.replace("GEMINI ", "G").replace(" PRO", "P").replace(" FLASH", "F").split("/")[0];
      const dot = avg > 50 ? "\u{1F7E2}" : avg > 20 ? "\u{1F7E1}" : "\u{1F534}";
      return `${dot} ${shortName} ${Math.round(avg)}%`;
    }).filter((t) => t !== "").join("  |  ");
  }
  if (latestQuotaData.claude?.isAuthenticated && latestQuotaData.claude.quotas?.length > 0) {
    const cQuota = latestQuotaData.claude.quotas[0];
    const color = getQuotaColor(cQuota.remaining, cQuota.direction || "up");
    groupsText += `  Claude ${color.dot}`;
  }
  if (latestQuotaData.codex?.isAuthenticated && latestQuotaData.codex.quotas?.length > 0) {
    const cxQuota = latestQuotaData.codex.quotas[0];
    const color = getQuotaColor(cxQuota.remaining, cxQuota.direction || "down");
    groupsText += `  Codex ${color.dot}`;
  }
  statusBarItem.text = `$(dashboard)  ${groupsText || "Auto Quota Antigravity"}`;
  const svg = buildTooltipSVG(latestQuotaData);
  const base64 = Buffer.from(svg).toString("base64");
  const tooltip = new vscode5.MarkdownString();
  tooltip.appendMarkdown(`![Quota Info](data:image/svg+xml;base64,${base64})

`);
  const name = latestQuotaData.antigravity?.name || "User";
  tooltip.appendMarkdown(`&nbsp;&nbsp;&nbsp;&nbsp;**${name}** \xB7 [Dashboard](command:sqm.sidebar.focus)`);
  tooltip.isTrusted = true;
  statusBarItem.tooltip = tooltip;
}
function setLatestData(data) {
  const autoStatus = automationService?.dumpDiagnostics() ?? null;
  const dataStr = JSON.stringify(data);
  const autoStr = JSON.stringify(autoStatus);
  if (dataStr === latestDataHash && autoStr === latestAutoHash) {
    return;
  }
  latestQuotaData = data;
  latestDataHash = dataStr;
  latestAutoHash = autoStr;
  refreshStatusBar();
  if (globalSidebarProvider && data) {
    globalSidebarProvider.syncToWebview({ ...data, autoClick: autoStatus ?? void 0 });
  }
  checkNotifications(data);
}
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const config = vscode5.workspace.getConfiguration("sqm");
  const intervalMins = config.get("refreshInterval") || 5;
  refreshTimer = setInterval(() => {
    if (globalSidebarProvider) globalSidebarProvider.updateData();
  }, intervalMins * 60 * 1e3);
}
function checkNotifications(data) {
  const config = vscode5.workspace.getConfiguration("sqm");
  if (!config.get("enableNotifications")) return;
  const checkQuota = (serviceName, quotas) => {
    if (!quotas) return;
    quotas.forEach((q) => {
      const modelKey = `${serviceName}-${q.label}`;
      const isUp = q.direction === "up";
      const pct = Math.round(q.remaining);
      const isUnhealthy = isUp ? pct >= 80 : pct <= 20;
      if (!isUnhealthy) {
        notifiedModels.delete(modelKey);
        return;
      }
      if (notifiedModels.has(modelKey)) return;
      const message = isUp ? `${serviceName} [${q.label}] usage is high (${pct}%).` : `${serviceName} [${q.label}] quota is low (${pct}% remaining).`;
      vscode5.window.showWarningMessage(message, "Dashboard").then((selection) => {
        if (selection === "Dashboard") {
          vscode5.commands.executeCommand("sqm.sidebar.focus");
        }
      });
      notifiedModels.add(modelKey);
    });
  };
  if (data.antigravity?.quotas) checkQuota("Antigravity", data.antigravity.quotas);
  if (data.claude?.quotas) checkQuota("Claude", data.claude.quotas);
  if (data.codex?.quotas) checkQuota("Codex", data.codex.quotas);
}
function deactivate() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (automationService) {
    automationService.dispose();
    automationService = null;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate,
  setLatestData
});
//# sourceMappingURL=extension.js.map
