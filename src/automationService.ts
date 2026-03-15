import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync, execFile } from 'child_process';
import * as http from 'http';
import * as url from 'url';

/**
 * AutomationService - Hệ thống tự động hóa thông minh cho AG Manager.
 * Thay thế cho các giải pháp cũ, tối ưu hóa hiệu suất và bảo mật.
 */
export class AutomationService {
    private static readonly SCRIPT_TAG_ID = 'ag-logic-bridge';
    private _context: vscode.ExtensionContext;
    private _server: http.Server | null = null;
    private _port: number = 0;

    // Automation States
    private _isActive: boolean = true;
    private _rules: string[] = ['Run', 'Allow', 'Accept', 'Always Allow', 'Keep Waiting', 'Retry', 'Continue', 'Allow Once', 'Accept all'];
    private _metrics: Record<string, number> = {};
    private _history: any[] = [];
    private _config = { scanDelay: 1000, restPeriod: 7000 };

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
        this.syncState();
        this.boot();
    }

    private syncState() {
        const store = vscode.workspace.getConfiguration('ag-manager.automation');
        this._isActive = store.get('enabled', true);
        this._rules = store.get('rules', this._rules);
        this._metrics = this._context.globalState.get('automation_metrics', {});
        this._history = this._context.globalState.get('automation_history', []);
    }

    private boot() {
        this.launchBridge();
        this.initSystemWatcher();
        if (!this.verifyInjection()) {
            this.deployBridgeScript();
        }
    }

    public async patchSettings(patch: any) {
        if (patch.enabled !== undefined) this._isActive = patch.enabled;
        if (patch.rules !== undefined && Array.isArray(patch.rules)) {
            this._rules = patch.rules;
        }

        const store = vscode.workspace.getConfiguration('ag-manager.automation');
        await Promise.all([
            store.update('enabled', this._isActive, vscode.ConfigurationTarget.Global),
            store.update('rules', this._rules, vscode.ConfigurationTarget.Global)
        ]);
    }

    public dumpDiagnostics() {
        return {
            active: this._isActive,
            rules: this._rules,
            total_actions: Object.values(this._metrics).reduce((a, b) => a + b, 0),
            metrics: this._metrics,
            logs: this._history.slice(0, 8)
        };
    }

    private launchBridge() {
        this._server = http.createServer((req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json');

            const endpoint = url.parse(req.url || '', true);

            // System Status Heartbeat
            if (endpoint.pathname === '/system/heartbeat') {
                if (endpoint.query?.delta) {
                    try {
                        const delta = JSON.parse(decodeURIComponent(endpoint.query.delta as string));
                        Object.keys(delta).forEach(k => this._metrics[k] = (this._metrics[k] || 0) + delta[k]);
                        this._context.globalState.update('automation_metrics', this._metrics);
                    } catch (e) { }
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
                        if (this._history.length > 50) this._history.pop();
                        this._context.globalState.update('automation_history', this._history);
                        res.end(JSON.stringify({ ok: true }));
                    } catch (e) { res.writeHead(400); res.end(); }
                });
                return;
            }
            res.writeHead(404); res.end();
        });

        const bind = (p: number) => {
            if (p > 48850) return;
            this._server?.listen(p, '127.0.0.1', () => {
                this._port = p;
                console.log(`[Automation] Bridge active on port ${p}`);
            }).on('error', (e: any) => e.code === 'EADDRINUSE' ? bind(p + 1) : null);
        };
        bind(48787);
    }

    private initSystemWatcher() {
        if (process.platform !== 'win32') return;
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
            if (!this._isActive || !this._rules.includes('Keep Waiting')) return;
            execFile('powershell.exe', ['-NoProfile', '-Command', psCmd], (e, out) => {
                if (out.trim() === 'HIT') {
                    this._metrics['Keep Waiting'] = (this._metrics['Keep Waiting'] || 0) + 1;
                }
            });
        }, 4000);
        this._context.subscriptions.push({ dispose: () => clearInterval(job) });
    }

    private getTargetFile(): string | null {
        const root = vscode.env.appRoot;
        const paths = [
            path.join(root, 'out/vs/code/electron-sandbox/workbench/workbench.html'),
            path.join(root, 'out/vs/code/electron-browser/workbench/workbench.html'),
            path.join(root, 'out/vs/workbench/workbench.html')
        ];
        return paths.find(p => fs.existsSync(p)) || null;
    }

    private verifyInjection(): boolean {
        const target = this.getTargetFile();
        return target ? fs.readFileSync(target, 'utf8').includes(AutomationService.SCRIPT_TAG_ID) : false;
    }

    private deployBridgeScript() {
        const target = this.getTargetFile();
        if (!target) return;

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
        } catch (err: any) {
            console.error('[Automation] Deploy failed:', err.message);
        }
    }

    private writeSafe(p: string, c: string) {
        try {
            fs.writeFileSync(p, c, 'utf8');
        } catch (e) {
            if (process.platform === 'win32') throw new Error("Yêu cầu Administrator để cài đặt tính năng tự động.");
            const tmp = path.join(os.tmpdir(), `ag_tmp_${Date.now()}`);
            fs.writeFileSync(tmp, c);
            const cmd = process.platform === 'darwin'
                ? `osascript -e 'do shell script "cp ${tmp} ${p}" with administrator privileges'`
                : `pkexec cp ${tmp} ${p}`;
            execSync(cmd);
            fs.unlinkSync(tmp);
        }
    }

    private recalculateHashes() {
        try {
            const pJson = path.join(vscode.env.appRoot, 'product.json');
            const data = JSON.parse(fs.readFileSync(pJson, 'utf8'));
            if (!data.checksums) return;

            Object.keys(data.checksums).forEach(k => {
                const fullPath = path.join(vscode.env.appRoot, 'out', k.split('/').join(path.sep));
                if (fs.existsSync(fullPath)) {
                    const hash = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('base64').replace(/=+$/, '');
                    data.checksums[k] = hash;
                }
            });
            this.writeSafe(pJson, JSON.stringify(data, null, '\t'));
        } catch (e) { }
    }
}
