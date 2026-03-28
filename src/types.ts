export interface QuotaInfo {
    label: string;
    remaining: number;
    resetTime: string;
    themeColor?: string;
    absResetTime?: string;
    displayValue?: string;
    style?: 'segmented' | 'fluid';
    direction?: 'up' | 'down';
}

export interface UserStatus {
    name: string;
    email: string;
    tier: string;
    quotas: QuotaInfo[];
    isAuthenticated?: boolean;
    error?: string;
}

export interface DashboardData {
    antigravity: UserStatus | null;
    claude: UserStatus | null;
    codex: UserStatus | null;
    autoClick?: AutoClickDiagnostics;
}

export interface AutoClickDiagnostics {
    active: boolean;
    rules: string[];
    total_actions: number;
    metrics: Record<string, number>;
    logs: AutoClickLogEntry[];
}

export interface AutoClickLogEntry {
    ts: string;
    act: string;
    ref: string;
}

export interface AutoClickConfig {
    enabled?: boolean;
    rules?: string[];
}

export type WebviewMessage =
    | { type: 'onRefresh' }
    | { type: 'onAutoClickChange'; config: AutoClickConfig }
    | { type: 'getSettings' }
    | { type: 'saveSettings'; settings: Record<string, unknown> };

export interface ModelGroup {
    id: string;
    title: string;
    models: string[];
}

