import { ping } from './utils/ping';
import { ServiceConfig, MonitoringResult } from './types';
import { Logger } from './utils/logger';

interface MonitorConfig {
  maxConcurrent: number;
  timeout: number;
  retryAttempts: number;
}

export class UptimeMonitor {
  private services: Map<string, ServiceConfig> = new Map();
  private logger: Logger;
  private config: MonitorConfig;

  constructor(config: MonitorConfig) {
    this.config = config;
    this.logger = new Logger('MONITOR', 'uptime-monitor');
  }

  addService(service: ServiceConfig) {
    this.services.set(service.id, service);
  }

  removeService(serviceId: string) {
    this.services.delete(serviceId);
  }

  clearServices() {
    this.services.clear();
  }

  getServices(): ServiceConfig[] {
    return Array.from(this.services.values());
  }

  private async checkHttpService(service: ServiceConfig): Promise<MonitoringResult> {
    const startTime = Date.now();
    let error: string | null = null;
    let success = false;

    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), service.timeout || this.config.timeout);

        const response = await fetch(service.type === 'http' ? service.url : '', {
          signal: controller.signal
        });

        clearTimeout(timeout);
        success = response.ok;
        error = success ? null : `HTTP ${response.status}: ${response.statusText}`;
        break;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        if (attempt === this.config.retryAttempts) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
      }
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    return {
      serviceId: service.id,
      timestamp: Date.now(),
      success,
      duration,
      error
    };
  }

  private async checkIcmpService(service: ServiceConfig): Promise<MonitoringResult> {
    const startTime = Date.now();
    let error: string | null = null;
    let success = false;

    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
      try {
        if (service.type !== 'icmp') throw new Error('Invalid service type');
        
        const result = await ping(service.host, {
          timeout: service.timeout || this.config.timeout
        });

        success = result.alive;
        error = success ? null : 'Host is not responding to ICMP';
        break;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        if (attempt === this.config.retryAttempts) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
      }
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    return {
      serviceId: service.id,
      timestamp: Date.now(),
      success,
      duration,
      error
    };
  }

  async checkService(service: ServiceConfig): Promise<MonitoringResult> {
    this.logger.info(`Checking service ${service.name} (${service.id})`);
    
    try {
      const result = service.type === 'http' 
        ? await this.checkHttpService(service)
        : await this.checkIcmpService(service);

      if (result.success) {
        this.logger.info(`Service ${service.name} is UP (${result.duration}ms)`);
      } else {
        this.logger.warn(`Service ${service.name} is DOWN: ${result.error}`);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to check service ${service.name}: ${errorMessage}`);
      
      return {
        serviceId: service.id,
        timestamp: Date.now(),
        success: false,
        duration: 0,
        error: errorMessage
      };
    }
  }
}
