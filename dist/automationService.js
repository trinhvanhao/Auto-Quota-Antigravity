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
exports.AutomationService = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const crypto = __importStar(require("crypto"));
const child_process_1 = require("child_process");
const http = __importStar(require("http"));
const url = __importStar(require("url"));
/**
 * AutomationService - Hệ thống tự động hóa thông minh cho AG Manager.
 * Thay thế cho các giải pháp cũ, tối ưu hóa hiệu suất và bảo mật.
 */
class AutomationService {
    static SCRIPT_TAG_ID = 'ag-logic-bridge';
    _context;
    _server = null;
    _port = 0;
    // Automation States
    _isActive = true;
    _rules = ['Run', 'Allow', 'Accept', 'Always Allow', 'Keep Waiting', 'Retry', 'Continue', 'Allow Once', 'Accept all'];
    _metrics = {};
    _history = [];
    _config = { scanDelay: 1000, restPeriod: 7000 };
    constructor(context) {
        this._context = context;
        this.syncState();
        this.boot();
    }
    syncState() {
        const store = vscode.workspace.getConfiguration('ag-manager.automation');
        this._isActive = store.get('enabled', true);
        this._rules = store.get('rules', this._rules);
        this._metrics = this._context.globalState.get('automation_metrics', {});
        this._history = this._context.globalState.get('automation_history', []);
    }
    boot() {
        this.launchBridge();
        this.initSystemWatcher();
        if (!this.verifyInjection()) {
            this.deployBridgeScript();
        }
    }
    async patchSettings(patch) {
        if (patch.enabled !== undefined)
            this._isActive = patch.enabled;
        if (patch.rules !== undefined && Array.isArray(patch.rules)) {
            this._rules = patch.rules;
        }
        const store = vscode.workspace.getConfiguration('ag-manager.automation');
        await Promise.all([
            store.update('enabled', this._isActive, vscode.ConfigurationTarget.Global),
            store.update('rules', this._rules, vscode.ConfigurationTarget.Global)
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
        this._server = http.createServer((req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json');
            const endpoint = url.parse(req.url || '', true);
            // System Status Heartbeat
            if (endpoint.pathname === '/system/heartbeat') {
                if (endpoint.query?.delta) {
                    try {
                        const delta = JSON.parse(decodeURIComponent(endpoint.query.delta));
                        Object.keys(delta).forEach(k => this._metrics[k] = (this._metrics[k] || 0) + delta[k]);
                        this._context.globalState.update('automation_metrics', this._metrics);
                    }
                    catch (e) { }
                }
                res.end(JSON.stringify({
                    power: this._isActive,
                    rules: this._rules,
                    timing: this._config
                }));
                return;
            }
            // Action Logger
            if (endpoint.pathname === '/system/log' && req.method === 'POST') {
                let data = '';
                req.on('data', c => data += c);
                req.on('end', () => {
                    try {
                        const payload = JSON.parse(data);
                        this._history.unshift({
                            ts: new Date().toLocaleTimeString(),
                            act: payload.type || 'click',
                            ref: (payload.label || '').substring(0, 50)
                        });
                        if (this._history.length > 50)
                            this._history.pop();
                        this._context.globalState.update('automation_history', this._history);
                        res.end(JSON.stringify({ ok: true }));
                    }
                    catch (e) {
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
            if (p > 48850)
                return;
            this._server?.listen(p, '127.0.0.1', () => {
                this._port = p;
                console.log(`[Automation] Bridge active on port ${p}`);
            }).on('error', (e) => e.code === 'EADDRINUSE' ? bind(p + 1) : null);
        };
        bind(48787);
    }
    initSystemWatcher() {
        if (process.platform !== 'win32')
            return;
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
            if (!this._isActive || !this._rules.includes('Keep Waiting'))
                return;
            (0, child_process_1.execFile)('powershell.exe', ['-NoProfile', '-Command', psCmd], (e, out) => {
                if (out.trim() === 'HIT') {
                    this._metrics['Keep Waiting'] = (this._metrics['Keep Waiting'] || 0) + 1;
                }
            });
        }, 4000);
        this._context.subscriptions.push({ dispose: () => clearInterval(job) });
    }
    getTargetFile() {
        const root = vscode.env.appRoot;
        const paths = [
            path.join(root, 'out/vs/code/electron-sandbox/workbench/workbench.html'),
            path.join(root, 'out/vs/code/electron-browser/workbench/workbench.html'),
            path.join(root, 'out/vs/workbench/workbench.html')
        ];
        return paths.find(p => fs.existsSync(p)) || null;
    }
    verifyInjection() {
        const target = this.getTargetFile();
        return target ? fs.readFileSync(target, 'utf8').includes(AutomationService.SCRIPT_TAG_ID) : false;
    }
    deployBridgeScript() {
        const target = this.getTargetFile();
        if (!target)
            return;
        try {
            const dir = path.dirname(target);
            const src = path.join(this._context.extensionPath, 'src', 'automationCore.js');
            let code = fs.readFileSync(src, 'utf8');
            // Dynamic Config Injection
            code = code.replace('__RULES__', JSON.stringify(this._rules));
            code = code.replace('__STATE__', String(this._isActive));
            const finalScriptPath = path.join(dir, 'ag-automation-bridge.js');
            this.writeSafe(finalScriptPath, code);
            let html = fs.readFileSync(target, 'utf8');
            if (!html.includes(AutomationService.SCRIPT_TAG_ID)) {
                const tag = `\n<!-- ${AutomationService.SCRIPT_TAG_ID}-START -->\n<script src="ag-automation-bridge.js?ts=${Date.now()}"></script>\n<!-- ${AutomationService.SCRIPT_TAG_ID}-END -->`;
                html = html.replace('</html>', tag + '\n</html>');
                this.writeSafe(target, html);
            }
            this.recalculateHashes();
        }
        catch (err) {
            console.error('[Automation] Deploy failed:', err.message);
        }
    }
    writeSafe(p, c) {
        try {
            fs.writeFileSync(p, c, 'utf8');
        }
        catch (e) {
            if (process.platform === 'win32')
                throw new Error("Yêu cầu Administrator để cài đặt tính năng tự động.");
            const tmp = path.join(os.tmpdir(), `ag_tmp_${Date.now()}`);
            fs.writeFileSync(tmp, c);
            const cmd = process.platform === 'darwin'
                ? `osascript -e 'do shell script "cp ${tmp} ${p}" with administrator privileges'`
                : `pkexec cp ${tmp} ${p}`;
            (0, child_process_1.execSync)(cmd);
            fs.unlinkSync(tmp);
        }
    }
    recalculateHashes() {
        try {
            const pJson = path.join(vscode.env.appRoot, 'product.json');
            const data = JSON.parse(fs.readFileSync(pJson, 'utf8'));
            if (!data.checksums)
                return;
            Object.keys(data.checksums).forEach(k => {
                const fullPath = path.join(vscode.env.appRoot, 'out', k.split('/').join(path.sep));
                if (fs.existsSync(fullPath)) {
                    const hash = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('base64').replace(/=+$/, '');
                    data.checksums[k] = hash;
                }
            });
            this.writeSafe(pJson, JSON.stringify(data, null, '\t'));
        }
        catch (e) { }
    }
}
exports.AutomationService = AutomationService;
//# sourceMappingURL=automationService.js.map