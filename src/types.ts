export type MonitorType = 'http' | 'icmp';

export interface BaseServiceConfig {
  id: string;
  name: string;
  interval: number;
  timeout: number;
}

export interface HttpServiceConfig extends BaseServiceConfig {
  type: 'http';
  url: string;
}

export interface IcmpServiceConfig extends BaseServiceConfig {
  type: 'icmp';
  host: string;
}

export type ServiceConfig = HttpServiceConfig | IcmpServiceConfig;

export interface SlaveConfig {
  id: string;
  name?: string;
  port?: number;
  masterUrl: string;
  apiKey: string;
  services: ServiceConfig[];
  host?: string;
  maxConcurrentChecks?: number;
  checkTimeout?: number;
  retryAttempts?: number;
  maxMemoryMb?: number;
  cpuLimit?: number;
}

export interface SlaveStatus {
  id: string;
  name?: string;
  lastHeartbeat: number;
  isActive: boolean;
  services: string[];
  host?: string;
  port?: number;
  region?: string;
  datacenter?: string;
  version?: string;
  stats?: {
    cpuUsage?: number;
    memoryUsage?: number;
    uptime?: number;
  };
}

export interface MonitoringResult {
  serviceId: string;
  timestamp: number;
  success: boolean;
  duration: number;
  error: string | null;
}

export interface DowntimePeriod {
  start: number;
  end: number | null;
}

export interface ServiceStatus {
  id: string;
  name: string;
  type: MonitorType;
  url?: string;
  host?: string;
  interval: number;
  timeout: number;
  createdAt: number;
  lastCheck: number;
  lastStatus: boolean;
  uptimePercentage: number;
  uptimePercentage30d: number;
  assignedSlaves: string[];
  lastDowntime: DowntimePeriod | null;
  downtimePeriods: DowntimePeriod[];
}

export interface UptimeRecord {
  timestamp: number;
  status: 'up' | 'down';
}

export interface MasterConfig {
  port: number;
  host?: string;
  apiKey?: string;
  slaves: SlaveConfig[];
  heartbeatInterval: number;
  stateRetentionPeriod: number;
  maxServicesPerSlave?: number;
  allowedOrigins?: string[];
  rateLimit?: number;
}

export interface StorageData {
  services: {
    configs: ServiceConfig[];
    status: ServiceStatus[];
  };
  slaves: SlaveStatus[];
  lastUpdated: number;
}
