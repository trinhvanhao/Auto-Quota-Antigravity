const vscode = acquireVsCodeApi();
const state = vscode.getState() || {};

window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
        case "update":
            renderDashboard(message.data); // Assuming updateUI should call renderDashboard or renderDashboard is renamed
            break;
        case "loading":
            // Don't clear UI, just show a subtle loading if needed
            break;
    }
});

// Request initial data immediately on load
vscode.postMessage({ type: "onRefresh" });

document.getElementById('refresh-btn').addEventListener('click', () => {
    document.getElementById('quota-list').innerHTML = '<div class="loading">Refreshing...</div>';
    vscode.postMessage({ type: 'onRefresh' });
});

// [MODIFIED] renderDashboard: data is now DashboardData {antigravity, claude, codex}
// Old: data was UserStatus directly. New: data.antigravity = UserStatus | null
function renderDashboard(data) {
    if (!data) {
        document.getElementById('user-info').innerHTML = '';
        document.getElementById('quota-list').innerHTML = '<p class="error-msg">⚠️ Local server not found.<br>Ensure Antigravity IDE is running.</p>';
        return;
    }

    // --- Antigravity user card (unchanged logic, uses data.antigravity) ---
    const ag = data.antigravity;
    if (ag) {
        document.getElementById('user-info').innerHTML = `
            <div class="user-card">
                <div class="avatar">${ag.name.charAt(0)}</div>
                <div class="user-details">
                    <div class="user-name">${ag.name}</div>
                    <div class="user-sub">${ag.tier} • ${ag.email}</div>
                </div>
            </div>
        `;
    } else {
        document.getElementById('user-info').innerHTML = '';
    }

    // --- Render all service groups ---
    // [ADDED] renderServiceGroup helper: renders a titled gauge group identical to Antigravity style
    let html = '';
    if (ag) {
        html += renderServiceGroup('ANTIGRAVITY', ag);
    }
    if (data.claude) {
        html += renderServiceGroup('CLAUDE CODE', data.claude);
    }
    if (data.codex) {
        html += renderServiceGroup('CODEX', data.codex);
    }

    document.getElementById('quota-list').innerHTML = html;

    if (data.antigravity && data.antigravity.autoClick) {
        renderAutoClick(data.antigravity.autoClick);
    }
    if (data.autoClick) {
        renderAutoClick(data.autoClick);
    }
}

// [ADDED] Renders a single service group (title + user info row + gauges)
// Uses exact same HTML/CSS structure as original Antigravity rendering
function renderServiceGroup(title, status) {
    if (!status) { return ''; }

    const isAuthenticated = status.isAuthenticated !== false; // true if undefined (backward compat)
    const infoLine = `${status.tier} • ${status.email}`;

    let gaugesHtml = '';
    if (isAuthenticated && status.quotas && status.quotas.length > 0) {
        gaugesHtml = `<div class="gauge-grid">${status.quotas.map(q => createGauge(q)).join('')}</div>`;
    } else if (!isAuthenticated) {
        gaugesHtml = `<p class="error-msg" style="font-size:11px;padding:10px 0;">🔒 ${status.email}</p>`;
    }

    return `
        <div class="service-group">
            <div class="group-header">${title}</div>
            <div class="service-info">${infoLine}</div>
            ${gaugesHtml}
        </div>
    `;
}


function renderAutoClick(config) {
    let container = document.getElementById('automation-module');
    if (!container) {
        container = document.createElement('div');
        container.id = 'automation-module';
        container.className = 'automation-container';
        document.getElementById('app').appendChild(container);
    }

    const rules = [
        { id: 'Run', label: 'Bot Chạy (Run)' },
        { id: 'Allow', label: 'Quyền (Allow)' },
        { id: 'Accept', label: 'Chấp nhận (Accept)' },
        { id: 'Always Allow', label: 'Luôn cho phép' },
        { id: 'Retry', label: 'Thử lại (Retry)' },
        { id: 'Keep Waiting', label: 'Bỏ qua chờ' },
        { id: 'Accept all', label: 'Duyệt hết (Accept All)' }
    ];

    container.innerHTML = `
        <div class="section-title">Automation Suite</div>
        
        <div class="power-row">
            <span class="power-label">Hệ thống Tự động</span>
            <label class="switch">
                <input type="checkbox" id="master-power" ${config.active ? 'checked' : ''}>
                <span class="slider"></span>
            </label>
        </div>

        <div class="automation-grid ${!config.active ? 'system-off' : ''}">
            ${rules.map(rule => {
        const rulesList = Array.isArray(config.rules) ? config.rules : [];
        const isRuleOn = rulesList.includes(rule.id);
        const isActuallyActive = config.active && isRuleOn;
        return `
                    <div class="automation-card ${isActuallyActive ? 'active' : ''} ${!config.active ? 'disabled' : ''}" data-rule="${rule.id}">
                        <div class="glow-ring"></div>
                        <div class="automation-label">${rule.label}</div>
                        <div class="automation-status">${isActuallyActive ? 'Active' : (config.active ? 'Idle' : 'Paused')}</div>
                    </div>
                `;
    }).join('')}
        </div>
    `;

    // Events
    document.getElementById('master-power').addEventListener('change', (e) => {
        vscode.postMessage({
            type: 'onAutoClickChange',
            config: { enabled: e.target.checked }
        });
    });

    container.querySelectorAll('.automation-card').forEach(card => {
        card.addEventListener('click', () => {
            const ruleId = card.getAttribute('data-rule');
            const rulesList = Array.isArray(config.rules) ? config.rules : [];
            let currentRules = [...rulesList];

            // Visual feedback
            card.style.opacity = '0.5';
            card.style.pointerEvents = 'none';

            if (currentRules.includes(ruleId)) {
                currentRules = currentRules.filter(r => r !== ruleId);
            } else {
                currentRules.push(ruleId);
            }

            vscode.postMessage({
                type: 'onAutoClickChange',
                config: { rules: currentRules }
            });
        });
    });
}

function formatTime(t) {
    if (!t) return '';
    const hMatch = t.match(/(\d+)h/);
    const mMatch = t.match(/(\d+)m/);
    if (!hMatch && !mMatch) return t;
    let h = hMatch ? parseInt(hMatch[1]) : 0;
    let m = mMatch ? parseInt(mMatch[1]) : 0;
    if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h ${m}m`;
    return `0d ${h}h ${m}m`;
}

function createGauge(quota) {
    const pct = Math.round(quota.remaining);
    const R = 30;
    const C = 2 * Math.PI * R;           // circumference
    const filled = C * (pct / 100);
    const dash = `${filled} ${C}`;

    // [MODIFIED] User displayValue if provided (e.g. "23"), otherwise pct%
    const centerText = quota.displayValue !== undefined ? quota.displayValue : `${pct}%`;

    return `
        <div class="gauge-item">
            <svg class="gauge-svg" viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
                <circle class="gauge-track" cx="40" cy="40" r="${R}"/>
                <circle class="gauge-arc" cx="40" cy="40" r="${R}"
                    stroke="${quota.themeColor}"
                    stroke-dasharray="${dash}"
                    stroke-dashoffset="0"
                    transform="rotate(-90 40 40)"/>
                <text class="gauge-pct" x="40" y="40">${centerText}</text>
            </svg>
            <div class="gauge-label">${shortLabel(quota.label)}</div>
            <div class="gauge-time">${formatTime(quota.resetTime)}</div>
        </div>
    `;
}

function shortLabel(label) {
    // Rút gọn tên model cho compact display
    return label
        .replace('Gemini 3.1', 'G3.1')
        .replace('Gemini 3', 'G3')
        .replace('Gemini 2', 'G2')
        .replace('Claude Sonnet', 'Sonnet')
        .replace('Claude Opus', 'Opus')
        .replace('Claude Haiku', 'Haiku')
        .replace('GPT-OSS', 'GPT')
        .replace(' (Thinking)', ' 🧠')
        .replace(' (High)', '↑')
        .replace(' (Low)', '↓')
        .replace(' (Medium)', '');
}
