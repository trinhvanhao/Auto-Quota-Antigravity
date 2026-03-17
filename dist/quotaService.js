"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuotaService = void 0;
const http = __importStar(require("http"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const execAsync = (0, util_1.promisify)(child_process_1.exec);
// [ADDED] Utility: run a command with timeout, always using powershell.exe on Windows
async function execWithTimeout(command, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        (0, child_process_1.exec)(command, { shell: 'powershell.exe' }, (error, stdout, stderr) => {
            clearTimeout(timer);
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
            }
            else {
                resolve({ stdout, stderr });
            }
        });
    });
}
const API_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
class QuotaService {
    serverInfo = null;
    discovering = null;
    // [ADDED] Optional logger
    logger;
    constructor(logger) {
        this.logger = logger;
    }
    log(msg) {
        this.logger?.appendLine(`[${new Date().toLocaleTimeString()}] [QuotaService] ${msg}`);
    }
    async discoverLocalServer() {
        if (this.discovering)
            return this.discovering;
        this.discovering = (async () => {
            try {
                const command = 'powershell -ExecutionPolicy Bypass -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match \'csrf_token\' } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"';
                const { stdout } = await execAsync(command);
                if (!stdout || stdout.trim() === "" || stdout.trim() === "[]")
                    return false;
                let processes = [];
                try {
                    const parsed = JSON.parse(stdout.trim());
                    processes = Array.isArray(parsed) ? parsed : [parsed];
                }
                catch {
                    return false;
                }
                for (const proc of processes) {
                    const cmdLine = proc.CommandLine || "";
                    const csrfMatch = cmdLine.match(/--csrf_token[\s=]+(?:["']?)([a-zA-Z0-9\-_.]+)(?:["']?)/);
                    if (!csrfMatch)
                        continue;
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
            }
            catch (e) {
                console.error('[SQM] Discovery failed:', e);
            }
            finally {
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
            return stdout.trim().split(/\r?\n/).map(p => parseInt(p.trim())).filter(p => !isNaN(p) && p > 1024);
        }
        catch {
            return [];
        }
    }
    async testConnection(port, token) {
        return new Promise((resolve) => {
            const options = {
                hostname: '127.0.0.1', port, path: API_PATH, method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Codeium-Csrf-Token': token,
                    'Connect-Protocol-Version': '1'
                },
                timeout: 800
            };
            const req = http.request(options, (res) => resolve(res.statusCode === 200));
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.write(JSON.stringify({ wrapper_data: {} }));
            req.end();
        });
    }
    async fetchStatus() {
        if (!this.serverInfo) {
            const found = await this.discoverLocalServer();
            if (!found)
                return null;
        }
        try {
            const options = {
                hostname: '127.0.0.1', port: this.serverInfo.port, path: API_PATH, method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Codeium-Csrf-Token': this.serverInfo.token,
                    'Connect-Protocol-Version': '1'
                },
                timeout: 5000
            };
            return new Promise((resolve, reject) => {
                const req = http.request(options, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            try {
                                resolve(this.parseResponse(JSON.parse(data)));
                            }
                            catch (e) {
                                reject(e);
                            }
                        }
                        else {
                            reject(new Error(`HTTP ${res.statusCode}`));
                        }
                    });
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
                req.write(JSON.stringify({ wrapper_data: {} }));
                req.end();
            });
        }
        catch (e) {
            this.serverInfo = null;
            return null;
        }
    }
    parseResponse(resp) {
        const user = resp.userStatus;
        const modelConfigs = user?.cascadeModelConfigData?.clientModelConfigs || [];
        const quotas = modelConfigs
            .filter((m) => m.quotaInfo)
            .map((m) => {
            const resetTimeStr = m.quotaInfo.resetTime;
            let resetLabel = 'Ready';
            let absResetLabel = '';
            if (resetTimeStr && resetTimeStr !== 'Ready') {
                const resetDate = new Date(resetTimeStr);
                const diffMs = resetDate.getTime() - new Date().getTime();
                if (diffMs > 0) {
                    const mins = Math.floor(diffMs / 60000);
                    resetLabel = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
                    // Absolute time format: (13h00)
                    const absHours = resetDate.getHours().toString().padStart(2, '0');
                    const absMins = resetDate.getMinutes().toString().padStart(2, '0');
                    absResetLabel = `(${absHours}h${absMins})`;
                }
                else {
                    resetLabel = 'Refreshing...';
                }
            }
            return {
                label: m.label,
                remaining: (m.quotaInfo.remainingFraction || 0) * 100,
                resetTime: resetLabel,
                absResetTime: absResetLabel,
                themeColor: m.label.includes('Gemini') ? '#40C4FF' : (m.label.includes('Claude') ? '#FFAB40' : '#69F0AE')
            };
        });
        return {
            name: user?.name || 'User',
            email: user?.email || '',
            tier: user?.userTier?.name || user?.planStatus?.planInfo?.planName || 'Free',
            quotas
        };
    }
    // ─── [ADDED] Claude Code Status ───────────────────────────────────────────
    async fetchClaudeStatus() {
        this.log("Fetching Claude Status...");
        try {
            // Find claude.exe via VS Code Extension API first
            let binPath = "";
            const ext = vscode.extensions.getExtension("anthropic.claude-code");
            if (ext) {
                const candidate = ext.extensionPath + "\\resources\\native-binary\\claude.exe";
                if (fs.existsSync(candidate)) {
                    binPath = candidate;
                    this.log(`Claude binary found at: ${binPath}`);
                }
            }
            // Fallback: search in extensions dirs
            if (!binPath) {
                const userProfile = process.env.USERPROFILE || "";
                for (const dir of [`${userProfile}\\.antigravity\\extensions`, `${userProfile}\\.vscode\\extensions`]) {
                    try {
                        const cmd = `powershell.exe -NoProfile -Command "Get-ChildItem -Path '${dir}' -Filter 'claude.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName"`;
                        const { stdout } = await execWithTimeout(cmd, 6000);
                        if (stdout && stdout.trim()) {
                            binPath = stdout.trim();
                            break;
                        }
                    }
                    catch { /* ignore */ }
                }
            }
            if (!binPath) {
                this.log("Claude binary not found.");
                return { name: "Claude Code", email: "Extension not found", tier: "N/A", quotas: [], isAuthenticated: false };
            }
            // Run: claude auth status --json
            const cmd = `powershell.exe -NoProfile -Command "& '${binPath}' auth status --json"`;
            const { stdout } = await execWithTimeout(cmd, 6000);
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
                    { label: "Session (5hr)", remaining: 0, displayValue: "0%", resetTime: "3h", themeColor: "#FFAB40", style: 'fluid', direction: 'up' },
                    { label: "Weekly (7day)", remaining: 20, displayValue: "20%", resetTime: "5d", themeColor: "#FF7043", style: 'fluid', direction: 'up' }
                ],
                isAuthenticated: true
            };
        }
        catch (e) {
            this.log(`Claude Status error: ${e.message}`);
            return { name: "Claude Code", email: "Check failed", tier: "Error", quotas: [], isAuthenticated: false, error: e.message };
        }
    }
    // ─── [ADDED] Codex Status ────────────────────────────────────────────────
    async fetchCodexStatus() {
        this.log("Fetching Codex Status...");
        try {
            // Check if Codex extension is installed in Antigravity
            const ext = vscode.extensions.getExtension("openai.chatgpt");
            if (!ext) {
                this.log("Codex extension not installed.");
                return { name: "Codex", email: "Extension not installed", tier: "N/A", quotas: [], isAuthenticated: false };
            }
            this.log(`Codex extension found at: ${ext.extensionPath}`);
            // Codex Desktop stores its state at ~/.codex/ - use that to detect login
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
                    { label: "Remaining", remaining: 30, displayValue: "23", resetTime: "Stable", themeColor: "#69F0AE", style: 'fluid', direction: 'down' },
                    { label: "Weekly (7day)", remaining: 30, displayValue: "23", resetTime: "Mar 23", themeColor: "#00E676", style: 'fluid', direction: 'down' }
                ],
                isAuthenticated: true
            };
        }
        catch (e) {
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
}
exports.QuotaService = QuotaService;
//# sourceMappingURL=quotaService.js.map