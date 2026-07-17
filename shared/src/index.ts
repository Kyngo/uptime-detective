// === Enums ===

export type MonitorType = 'http' | 'icmp' | 'dns' | 'tls' | 'tcp' | 'heartbeat';
export type MonitorStatus = 'up' | 'down' | 'degraded' | 'maintenance' | 'pending';
export type CheckStatus = 1 | 0 | 2 | 3; // 1=UP, 0=DOWN, 2=DEGRADED, 3=MAINTENANCE
export type HttpMethod = 'GET' | 'POST' | 'HEAD' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS';
export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SOA' | 'SRV';
export type NotificationType = 'webhook' | 'email' | 'slack' | 'discord' | 'telegram';
export type UserRole = 'admin' | 'viewer';

// === Core Models ===

export interface User {
  id: number;
  username: string;
  role: UserRole;
  api_token: string | null;
  created_at: string;
}

export interface Group {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  sort_order: number;
  created_at: string;
}

export interface Monitor {
  id: number;
  name: string;
  type: MonitorType;
  target: string;
  interval: number;
  timeout: number;
  retries: number;
  retry_interval: number;
  config: MonitorConfig;
  group_id: number | null;
  tags: string[];
  active: boolean;
  heartbeat_token: string | null;
  created_at: string;
  updated_at: string;
}

export interface MonitorConfig {
  // HTTP
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
  body_match?: string;
  accepted_status_codes?: string; // e.g. "200-299"
  follow_redirects?: boolean;
  ignoreTls?: boolean; // Ignore invalid/self-signed TLS certificates (default: true)
  // DNS
  dns_record_type?: DnsRecordType;
  dns_resolver?: string;
  dns_expected_value?: string;
  // TLS
  tls_expiry_warning_days?: number;
  // TCP
  port?: number;
}

export interface Check {
  id: number;
  monitor_id: number;
  status: CheckStatus;
  response_time: number | null;
  status_code: number | null;
  message: string | null;
  created_at: string;
}

export interface Incident {
  id: number;
  monitor_id: number;
  started_at: string;
  resolved_at: string | null;
  duration_seconds: number | null;
  cause: string | null;
}

export interface StatusPage {
  id: number;
  title: string;
  slug: string;
  description: string | null;
  logo_url: string | null;
  custom_css: string | null;
  is_public: boolean;
  show_powered_by: boolean;
  created_at: string;
}

export interface StatusPageItem {
  id: number;
  status_page_id: number;
  group_id: number | null;
  monitor_id: number | null;
  sort_order: number;
}

export interface NotificationChannel {
  id: number;
  name: string;
  type: NotificationType;
  config: Record<string, unknown>;
  is_default: boolean;
  created_at: string;
}

export interface MaintenanceWindow {
  id: number;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string;
  recurring: 'daily' | 'weekly' | 'monthly' | null;
  created_at: string;
}

// === API Request/Response Types ===

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: Omit<User, 'api_token'>;
}

export interface CreateMonitorRequest {
  name: string;
  type: MonitorType;
  target: string;
  interval?: number;
  timeout?: number;
  retries?: number;
  retry_interval?: number;
  config?: MonitorConfig;
  group_id?: number | null;
  tags?: string[];
  active?: boolean;
}

export interface UpdateMonitorRequest extends Partial<CreateMonitorRequest> {}

export interface MonitorWithStatus extends Monitor {
  current_status: MonitorStatus;
  last_check: Check | null;
  uptime_24h: number | null;
  avg_response_time: number | null;
}

export interface UptimeResponse {
  monitor_id: number;
  period_days: number;
  uptime_percentage: number;
  total_checks: number;
  successful_checks: number;
}

export interface CheckHistoryQuery {
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

// === Socket.IO Events ===

export interface ServerToClientEvents {
  'monitor:status': (data: { monitor_id: number; status: MonitorStatus; check: Check }) => void;
  'monitor:created': (data: Monitor) => void;
  'monitor:updated': (data: Monitor) => void;
  'monitor:deleted': (data: { monitor_id: number }) => void;
  'incident:created': (data: Incident) => void;
  'incident:resolved': (data: Incident) => void;
}

export interface ClientToServerEvents {
  'subscribe:monitor': (monitor_id: number) => void;
  'unsubscribe:monitor': (monitor_id: number) => void;
}
