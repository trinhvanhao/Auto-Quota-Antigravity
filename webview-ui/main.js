const vscode = acquireVsCodeApi();
const state = vscode.getState() || {};

function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
        case "update":
            renderDashboard(message.data);
            break;
        case "loading":
            break;
        case "settings":
            renderSettingsData(message.settings);
            break;
    }
});

// Request initial data immediately on load
vscode.postMessage({ type: "onRefresh" });

document.getElementById('refresh-btn').addEventListener('click', () => {
    document.getElementById('quota-list').innerHTML = '<div class="loading">Refreshing...</div>';
    vscode.postMessage({ type: 'onRefresh' });
});

// Settings toggle
document.getElementById('settings-btn').addEventListener('click', () => {
    const panel = document.getElementById('settings-panel');
    const isHidden = panel.classList.toggle('hidden');
    if (!isHidden) {
        vscode.postMessage({ type: 'getSettings' });
    }
});

// [MODIFIED] renderDashboard: data is now DashboardData {antigravity, claude, codex}
// Old: data was UserStatus directly. New: data.antigravity = UserStatus | null
function renderDashboard(data) {
    if (!data) {
        document.getElementById('user-info').innerHTML = '';
        document.getElementById('quota-list').innerHTML = '<p class="error-msg">Local server not found.<br>Ensure Antigravity IDE is running.</p>';
        return;
    }

    // --- Antigravity user card (unchanged logic, uses data.antigravity) ---
    const ag = data.antigravity;
    if (ag) {
        document.getElementById('user-info').innerHTML = `
            <div class="user-card">
                <div class="avatar">${escapeHtml(ag.name.charAt(0))}</div>
                <div class="user-details">
                    <div class="user-name">${escapeHtml(ag.name)}</div>
                    <div class="user-sub">${escapeHtml(ag.tier)} &bull; ${escapeHtml(ag.email)}</div>
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

    if (data.autoClick) {
        renderAutoClick(data.autoClick);
    } else if (data.antigravity && data.antigravity.autoClick) {
        renderAutoClick(data.antigravity.autoClick);
    }
}

// [ADDED] Renders a single service group (title + user info row + gauges)
// Uses exact same HTML/CSS structure as original Antigravity rendering
function renderServiceGroup(title, status) {
    if (!status) { return ''; }

    const isAuthenticated = status.isAuthenticated !== false; // true if undefined (backward compat)
    const infoLine = `${escapeHtml(status.tier)} &bull; ${escapeHtml(status.email)}`;

    let gaugesHtml = '';
    if (status.error) {
        gaugesHtml = `<p class="error-msg" style="font-size:11px;padding:10px 0;">${escapeHtml(status.error)}</p>`;
    } else if (isAuthenticated && status.quotas && status.quotas.length > 0) {
        gaugesHtml = `<div class="gauge-grid">${status.quotas.map(q => createGauge(q)).join('')}</div>`;
    } else if (!isAuthenticated) {
        gaugesHtml = `<p class="error-msg" style="font-size:11px;padding:10px 0;">${escapeHtml(status.email)}</p>`;
    }

    return `
        <div class="service-group">
            <div class="group-header">${escapeHtml(title)}</div>
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
        { id: 'Run', label: 'Run' },
        { id: 'Allow', label: 'Allow' },
        { id: 'Accept', label: 'Accept' },
        { id: 'Always Allow', label: 'Always Allow' },
        { id: 'Retry', label: 'Retry' },
        { id: 'Keep Waiting', label: 'Keep Waiting' },
        { id: 'Accept all', label: 'Accept All' }
    ];

    container.innerHTML = `
        <div class="section-title">Automation Suite</div>
        
        <div class="power-row">
            <span class="power-label">Automation System</span>
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

    // Event delegation — single listener, no re-registration leak
    container.onclick = function(e) {
        const card = e.target.closest('.automation-card');
        if (card) {
            const ruleId = card.getAttribute('data-rule');
            const rulesList = Array.isArray(config.rules) ? config.rules : [];
            let currentRules = [...rulesList];

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
        }
    };
    container.onchange = function(e) {
        if (e.target.id === 'master-power') {
            vscode.postMessage({
                type: 'onAutoClickChange',
                config: { enabled: e.target.checked }
            });
        }
    };
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

    // [MODIFIED] User displayValue if provided (e.g. "23"), otherwise pct%
    const centerText = quota.displayValue !== undefined ? quota.displayValue : `${pct}%`;
    const label = shortLabel(quota.label);
    const time = formatTime(quota.resetTime);
    const barWidth = Math.max(0, Math.min(100, pct));

    return `
        <div class="quota-row">
            <div class="quota-main">
                <div class="quota-label">${escapeHtml(label)}</div>
                <div class="quota-time">${escapeHtml(time)}</div>
                <div class="quota-bar">
                    <div class="quota-bar-fill" style="width: ${barWidth}%; background-color: ${escapeHtml(quota.themeColor || '')};"></div>
                </div>
            </div>
            <div class="quota-value">${escapeHtml(centerText)}</div>
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
        .replace(' (Thinking)', '')
        .replace(' (High)', '↑')
        .replace(' (Low)', '↓')
        .replace(' (Medium)', '');
}

function renderSettingsData(settings) {
    const fields = [
        { key: 'claude.usagePeriod', label: 'Usage Period', type: 'select', options: [
            { value: '5-hour', label: '5 Hour' },
            { value: '7-day', label: '7 Day' },
            { value: 'both', label: 'Both' }
        ]},
        { key: 'refreshInterval', label: 'Refresh Interval (min)', type: 'select', options: [
            { value: 1, label: '1' }, { value: 2, label: '2' }, { value: 5, label: '5' },
            { value: 10, label: '10' }, { value: 15, label: '15' }, { value: 30, label: '30' }
        ]},
        { key: 'enableNotifications', label: 'Notifications', type: 'toggle' },
    ];

    const panel = document.getElementById('settings-panel');
    let html = '<div class="section-title">Settings</div>';

    fields.forEach(f => {
        const val = settings[f.key] ?? '';
        html += '<div class="settings-row">';
        html += `<label class="settings-label">${f.label}</label>`;

        if (f.type === 'password' || f.type === 'text') {
            const masked = f.type === 'password' && val ? '••••••••' : '';
            html += `<div class="settings-input-wrap">
                <input class="settings-input" type="${f.type === 'password' ? 'password' : 'text'}"
                    data-key="${f.key}" value="${val}" placeholder="${f.placeholder || ''}"
                    autocomplete="off" spellcheck="false">
                ${f.type === 'password' ? '<button class="settings-eye" data-key="' + f.key + '">Show</button>' : ''}
            </div>`;
        } else if (f.type === 'select') {
            html += `<select class="settings-select" data-key="${f.key}">`;
            f.options.forEach(opt => {
                const sel = String(val) === String(opt.value) ? 'selected' : '';
                html += `<option value="${opt.value}" ${sel}>${opt.label}</option>`;
            });
            html += '</select>';
        } else if (f.type === 'toggle') {
            html += `<label class="switch"><input type="checkbox" data-key="${f.key}" ${val ? 'checked' : ''}><span class="slider"></span></label>`;
        }

        html += '</div>';
    });

    html += '<button class="settings-save" id="save-settings-btn">Save</button>';
    panel.innerHTML = html;

    // Eye toggle for password fields
    panel.querySelectorAll('.settings-eye').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.getAttribute('data-key');
            const input = panel.querySelector(`input[data-key="${key}"]`);
            if (input.type === 'password') {
                input.type = 'text';
                btn.textContent = 'Hide';
            } else {
                input.type = 'password';
                btn.textContent = 'Show';
            }
        });
    });

    // Save button
    document.getElementById('save-settings-btn').addEventListener('click', () => {
        const result = {};
        panel.querySelectorAll('[data-key]').forEach(el => {
            if (el.tagName === 'BUTTON') return;
            const key = el.getAttribute('data-key');
            if (el.type === 'checkbox') {
                result[key] = el.checked;
            } else {
                let v = el.value.trim();
                // Convert numeric selects
                if (key === 'refreshInterval') v = parseInt(v);
                result[key] = v;
            }
        });
        vscode.postMessage({ type: 'saveSettings', settings: result });
    });
}

