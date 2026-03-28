import * as http from 'http';
import * as https from 'https';
import { exec, ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { QuotaInfo, UserStatus, DashboardData } from './types';

export { QuotaInfo, UserStatus, DashboardData };

const execAsync = promisify(exec);

async function execWithTimeout(command: string, timeoutMs: number = 8000): Promise<{ stdout: string, stderr: string }> {
    return new Promise((resolve, reject) => {
        let child: ChildProcess;
        const timer = setTimeout(() => {
            child?.kill();
            reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const options = process.platform === 'win32' ? { shell: 'powershell.exe' } : {};
        child = exec(command, options, (error, stdout, stderr) => {
            clearTimeout(timer);
            if (error) {
                (error as any).stdout = stdout;
                (error as any).stderr = stderr;
                reject(error);
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

const API_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';

export class QuotaService {
    private serverInfo: { port: number, token: string } | null = null;
    private discovering: Promise<boolean> | null = null;

    private cachedClaude: UserStatus | null = null;
    private claudeLastFetch: number = 0;
    private cachedCodex: UserStatus | null = null;
    private codexLastFetch: number = 0;
    private readonly CACHE_TTL = 120000; // 120 seconds (OAuth endpoint rate-limits aggressively)

    private logger?: vscode.OutputChannel;

    constructor(logger?: vscode.OutputChannel) {
        this.logger = logger;
    }

    private log(msg: string) {
        this.logger?.appendLine(`[${new Date().toLocaleTimeString()}] [QuotaService] ${msg}`);
    }

    private getClaudeLocalConfig(): { organizationId: string; email: string; displayName: string; subscriptionType: string; usagePeriod: '5-hour' | '7-day' | 'both' } {
        const sqmConfig = vscode.workspace.getConfiguration('sqm');
        let organizationId = sqmConfig.get<string>('claude.organizationId')?.trim() || '';
        let email = '';
        let displayName = '';
        let subscriptionType = '';

        // Read from ~/.claude.json (auto-populated by Claude Code)
        try {
            const claudeConfigPath = path.join(os.homedir(), '.claude.json');
            if (fs.existsSync(claudeConfigPath)) {
                const raw = fs.readFileSync(claudeConfigPath, 'utf8');
                const parsed = JSON.parse(raw);
                const oauth = parsed?.oauthAccount;
                if (oauth) {
                    if (!organizationId && oauth.organizationUuid) {
                        organizationId = oauth.organizationUuid;
                    }
                    email = oauth.emailAddress || '';
                    displayName = oauth.displayName || '';
                }
            }
        } catch (e: any) {
            this.log(`Failed to read ~/.claude.json: ${e?.message}`);
        }

        const usagePeriod =
            (sqmConfig.get<string>('claude.usagePeriod') as '5-hour' | '7-day' | 'both') || 'both';

        return { organizationId, email, displayName, subscriptionType, usagePeriod };
    }

    private async getClaudeOAuthToken(): Promise<{ accessToken: string; expiresAt: number } | null> {
        try {
            if (process.platform === 'darwin') {
                // macOS: read from Keychain
                const { stdout } = await execWithTimeout(
                    'security find-generic-password -s "Claude Code-credentials" -w',
                    5000
                );
                const creds = JSON.parse(stdout.trim());
                const oauth = creds?.claudeAiOauth;
                if (oauth?.accessToken) {
                    return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt || 0 };
                }
            } else {
                // Linux/Windows: read from ~/.claude/.credentials.json
                const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
                if (fs.existsSync(credPath)) {
                    const raw = fs.readFileSync(credPath, 'utf8');
                    const creds = JSON.parse(raw);
                    const oauth = creds?.claudeAiOauth;
                    if (oauth?.accessToken) {
                        return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt || 0 };
                    }
                }
            }
        } catch (e: any) {
            this.log(`OAuth token extraction failed: ${e?.message}`);
        }
        return null;
    }

    private async fetchClaudeUsageOAuth(accessToken: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const options: https.RequestOptions = {
                method: 'GET',
                hostname: 'api.anthropic.com',
                path: '/api/oauth/usage',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'anthropic-beta': 'oauth-2025-04-20',
                    'Content-Type': 'application/json',
                    'User-Agent': 'auto-quota-antigravity/1.4.0'
                },
                timeout: 10000
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 429) {
                        return reject(new Error('RATE_LIMITED'));
                    }
                    if (res.statusCode === 401) {
                        return reject(new Error('OAuth token expired. Run any claude command to refresh.'));
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
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.end();
        });
    }

    private buildClaudeQuotas(usageData: any, usagePeriod: '5-hour' | '7-day' | 'both'): QuotaInfo[] {
        const quotas: QuotaInfo[] = [];
        const five = usageData?.five_hour;
        const seven = usageData?.seven_day;
        const sevenSonnet = usageData?.seven_day_sonnet;
        const sevenOpus = usageData?.seven_day_opus;

        const parseResetTime = (resetsAt: string | undefined): { resetLabel: string; absLabel: string } => {
            if (!resetsAt) return { resetLabel: '', absLabel: '' };
            try {
                const resetDate = new Date(resetsAt);
                const diffMs = resetDate.getTime() - Date.now();
                if (diffMs <= 0) return { resetLabel: 'Refreshing...', absLabel: '' };
                const mins = Math.floor(diffMs / 60000);
                const resetLabel = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
                const absHours = resetDate.getHours().toString().padStart(2, '0');
                const absMins = resetDate.getMinutes().toString().padStart(2, '0');
                return { resetLabel, absLabel: `(${absHours}h${absMins})` };
            } catch {
                return { resetLabel: '', absLabel: '' };
            }
        };

        const pushQuota = (data: any, label: string, color: string, defaultReset: string) => {
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
                style: 'fluid',
                direction: 'up'
            });
        };

        if (usagePeriod === '5-hour' || usagePeriod === 'both') {
            pushQuota(five, 'Session (5hr)', '#FFAB40', '5h');
        }
        if (usagePeriod === '7-day' || usagePeriod === 'both') {
            pushQuota(seven, 'Weekly (7day)', '#FF7043', '7d');
            pushQuota(sevenSonnet, 'Sonnet (7day)', '#FFA726', '7d');
            pushQuota(sevenOpus, 'Opus (7day)', '#AB47BC', '7d');
        }

        return quotas;
    }

    async discoverLocalServer(): Promise<boolean> {
        if (this.discovering) return this.discovering;

        this.discovering = (async () => {
            try {
                let stdout = "";
                if (process.platform === 'win32') {
                    const command = 'powershell -ExecutionPolicy Bypass -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match \'csrf_token\' } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"';
                    const res = await execAsync(command);
                    stdout = res.stdout;
                } else {
                    const command = 'ps -eo pid,command | grep csrf_token | grep -v grep';
                    const res = await execAsync(command);
                    const lines = res.stdout.trim().split('\n');
                    const arr = lines.map(line => {
                        const match = line.trim().match(/^(\d+)\s+(.+)$/);
                        if (match) {
                            return { ProcessId: parseInt(match[1]), CommandLine: match[2] };
                        }
                        return null;
                    }).filter(Boolean);
                    stdout = JSON.stringify(arr);
                }

                if (!stdout || stdout.trim() === "" || stdout.trim() === "[]") return false;

                let processes: any[] = [];
                try {
                    const parsed = JSON.parse(stdout.trim());
                    processes = Array.isArray(parsed) ? parsed : [parsed];
                } catch (e: any) {
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
                console.error('[SQM] Discovery failed:', e);
            } finally {
                this.discovering = null;
            }
            return false;
        })();

        return this.discovering;
    }

    private async getListeningPorts(pid: number): Promise<number[]> {
        try {
            if (process.platform === 'win32') {
                const cmd = `powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique"`;
                const { stdout } = await execAsync(cmd);
                return stdout.trim().split(/\r?\n/).map(p => parseInt(p.trim())).filter(p => !isNaN(p) && p > 1024);
            } else {
                const cmd = `lsof -a -p ${pid} -i4TCP -sTCP:LISTEN -P -n | awk 'NR>1 {print $9}' | awk -F':' '{print $NF}' | sort -u`;
                const { stdout } = await execAsync(cmd);
                return stdout.trim().split(/\r?\n/).map(p => parseInt(p.trim())).filter(p => !isNaN(p) && p > 1024);
            }
        } catch (e: any) {
            this.log(`getListeningPorts failed for PID ${pid}: ${e?.message}`);
            return [];
        }
    }

    private async testConnection(port: number, token: string): Promise<boolean> {
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

    async fetchStatus(): Promise<UserStatus | null> {
        if (!this.serverInfo) {
            const found = await this.discoverLocalServer();
            if (!found) return null;
        }

        try {
            const options = {
                hostname: '127.0.0.1', port: this.serverInfo!.port, path: API_PATH, method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Codeium-Csrf-Token': this.serverInfo!.token,
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
                            try { resolve(this.parseResponse(JSON.parse(data))); } catch (e) { reject(e); }
                        } else { reject(new Error(`HTTP ${res.statusCode}`)); }
                    });
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
                req.write(JSON.stringify({ wrapper_data: {} }));
                req.end();
            });
        } catch (e) {
            this.serverInfo = null;
            return null;
        }
    }

    private parseResponse(resp: any): UserStatus {
        const user = resp.userStatus;
        const modelConfigs = user?.cascadeModelConfigData?.clientModelConfigs || [];
        const quotas: QuotaInfo[] = modelConfigs
            .filter((m: any) => m.quotaInfo)
            .map((m: any) => {
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
                    } else { resetLabel = 'Refreshing...'; }
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
    async fetchClaudeStatus(): Promise<UserStatus | null> {
        const now = Date.now();
        if (this.cachedClaude && (now - this.claudeLastFetch < this.CACHE_TTL)) {
            return this.cachedClaude;
        }
        this.cachedClaude = await this._fetchClaudeStatusImpl();
        this.claudeLastFetch = now;
        return this.cachedClaude;
    }

    private async _fetchClaudeStatusImpl(): Promise<UserStatus | null> {
        this.log("Fetching Claude Status...");
        try {
            // Step 1: Read local config from ~/.claude.json (fast, no API call)
            const localConfig = this.getClaudeLocalConfig();

            // Step 2: Get auth status from CLI (for login check + subscription type)
            let authStatus: any = null;
            try {
                let binPath = "";
                const exeName = process.platform === 'win32' ? 'claude.exe' : 'claude';
                const ext = vscode.extensions.getExtension("anthropic.claude-code");
                if (ext) {
                    const candidate = path.join(ext.extensionPath, 'resources', 'native-binary', exeName);
                    if (fs.existsSync(candidate)) binPath = candidate;
                }
                if (!binPath) {
                    const home = os.homedir();
                    for (const dir of [path.join(home, '.antigravity', 'extensions'), path.join(home, '.vscode', 'extensions')]) {
                        try {
                            const cmd = process.platform === 'win32'
                                ? `powershell.exe -NoProfile -Command "Get-ChildItem -Path '${dir}' -Filter '${exeName}' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName"`
                                : `find "${dir}" -name "${exeName}" -type f 2>/dev/null | head -n 1`;
                            const { stdout } = await execWithTimeout(cmd, 6000);
                            if (stdout?.trim()) { binPath = stdout.trim(); break; }
                        } catch (e: any) {
                            this.log(`Claude binary search in ${dir}: ${e?.message}`);
                        }
                    }
                }
                if (binPath) {
                    const cmd = process.platform === 'win32'
                        ? `powershell.exe -NoProfile -Command "& '${binPath}' auth status --json"`
                        : `"${binPath}" auth status --json`;
                    const { stdout } = await execWithTimeout(cmd, 6000);
                    authStatus = JSON.parse(stdout.trim());
                }
            } catch (e: any) {
                this.log(`Claude CLI auth status failed: ${e?.message}`);
            }

            // Determine auth state
            const isLoggedIn = authStatus?.loggedIn ?? !!localConfig.email;
            const email = authStatus?.email || localConfig.email || '';
            const tier = authStatus?.subscriptionType || localConfig.subscriptionType || 'Unknown';
            const displayName = localConfig.displayName || 'Claude Code';

            if (!isLoggedIn) {
                return { name: "Claude Code", email: "Not logged in", tier: "Guest", quotas: [], isAuthenticated: false };
            }

            // Step 3: Get OAuth token and fetch usage via API
            const oauthToken = await this.getClaudeOAuthToken();
            if (!oauthToken) {
                return {
                    name: displayName, email, tier,
                    quotas: [], isAuthenticated: true,
                    error: "OAuth token not found — run `claude auth login`"
                };
            }

            let usageData: any;
            try {
                usageData = await this.fetchClaudeUsageOAuth(oauthToken.accessToken);
            } catch (e: any) {
                if (e?.message === 'RATE_LIMITED' && this.cachedClaude) {
                    this.log("Rate limited — returning cached Claude data");
                    return this.cachedClaude;
                }
                return {
                    name: displayName, email, tier,
                    quotas: [], isAuthenticated: true,
                    error: e?.message || 'Usage fetch failed'
                };
            }

            const quotas = this.buildClaudeQuotas(usageData, localConfig.usagePeriod);
            return {
                name: displayName, email, tier,
                quotas, isAuthenticated: true,
                error: quotas.length === 0 ? "No usage data returned" : undefined
            };
        } catch (e: any) {
            this.log(`Claude Status error: ${e.message}`);
            return { name: "Claude Code", email: "Check failed", tier: "Error", quotas: [], isAuthenticated: false, error: e.message };
        }
    }

    // ─── [ADDED] Codex Status ────────────────────────────────────────────────
    async fetchCodexStatus(): Promise<UserStatus | null> {
        const now = Date.now();
        if (this.cachedCodex && (now - this.codexLastFetch < this.CACHE_TTL)) {
            return this.cachedCodex;
        }
        this.cachedCodex = await this._fetchCodexStatusImpl();
        this.codexLastFetch = now;
        return this.cachedCodex;
    }

    private async _fetchCodexStatusImpl(): Promise<UserStatus | null> {
        this.log("Fetching Codex Status...");
        try {
            const home = os.homedir();
            const authFile = path.join(home, '.codex', 'auth.json');
            const configFile = path.join(home, '.codex', 'config.toml');

            // Check if Codex is installed (extension or local files)
            const ext = vscode.extensions.getExtension("openai.chatgpt");
            if (!ext && !fs.existsSync(authFile)) {
                return { name: "Codex", email: "Not installed", tier: "N/A", quotas: [], isAuthenticated: false };
            }

            // Read auth info from ~/.codex/auth.json
            if (!fs.existsSync(authFile)) {
                return { name: "Codex", email: "Not logged in", tier: "Guest", quotas: [], isAuthenticated: false };
            }

            let email = '';
            let planType = 'Free';
            let model = 'Unknown';

            try {
                const authData = JSON.parse(fs.readFileSync(authFile, 'utf8'));
                const idToken = authData?.tokens?.id_token;
                if (idToken) {
                    // Decode JWT payload (base64url) to get user info
                    const parts = idToken.split('.');
                    if (parts.length >= 2) {
                        const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
                        const claims = JSON.parse(payload);
                        email = claims.email || '';
                        const authInfo = claims['https://api.openai.com/auth'] || {};
                        planType = authInfo.chatgpt_plan_type || 'free';
                    }
                }
            } catch (e: any) {
                this.log(`Codex JWT decode failed: ${e?.message}`);
            }

            // Read model from config.toml
            try {
                if (fs.existsSync(configFile)) {
                    const configRaw = fs.readFileSync(configFile, 'utf8');
                    const modelMatch = configRaw.match(/^model\s*=\s*"([^"]+)"/m);
                    if (modelMatch) model = modelMatch[1];
                }
            } catch (e: any) {
                this.log(`Codex config read failed: ${e?.message}`);
            }

            this.log(`Codex: ${email} (${planType}), model: ${model}`);
            const tierDisplay = planType.charAt(0).toUpperCase() + planType.slice(1);
            return {
                name: "Codex",
                email,
                tier: tierDisplay,
                quotas: [{
                    label: 'Active Model',
                    remaining: 0,
                    displayValue: model,
                    resetTime: '',
                    themeColor: '#69F0AE',
                    style: 'fluid',
                    direction: 'up'
                }],
                isAuthenticated: true
            };
        } catch (e: any) {
            this.log(`Codex Status error: ${e.message}`);
            return { name: "Codex", email: "Check failed", tier: "Error", quotas: [], isAuthenticated: false, error: e.message };
        }
    }

    async fetchDashboard(): Promise<DashboardData> {
        const [antigravity, claude, codex] = await Promise.all([
            this.fetchStatus(),
            this.fetchClaudeStatus(),
            this.fetchCodexStatus()
        ]);

        return { antigravity, claude, codex };
    }
}
