import { Elysia } from 'elysia';
import { t } from 'elysia';
import swagger from '@elysiajs/swagger';
import { ServiceStatus, MonitoringResult, HttpServiceConfig, IcmpServiceConfig, DailyDowntime, CurrentStatus } from './types';
import { Logger } from './utils/logger';
import { StateStorage } from './storage';
import { DiscordAlerter } from './utils/discord';

interface SlaveInfo {
  name: string;
  lastSeen: number;
  services: string[];
}

export class UptimeMaster {
  private services: Map<string, ServiceStatus> = new Map();
  private slaves: Map<string, SlaveInfo> = new Map();
  private logger: Logger;
  private storage: StateStorage;
  private discord: DiscordAlerter;

  private readonly MIN_DOWNTIME_MS = 10000; // Minimum 10 seconds to count as downtime
  private readonly MAX_DOWNTIME_GAP_MS = 30000; // Merge downtimes less than 30 seconds apart
  private readonly CONSENSUS_THRESHOLD = 0.75; // 75% of slaves must agree
  private readonly STALE_RESULT_THRESHOLD = 300000; // 5 minutes
  private readonly DAYS_TO_KEEP = 30; // Number of days to keep in history

  constructor() {
    this.logger = new Logger('MASTER', 'uptime-master');
    this.storage = new StateStorage();
    this.discord = new DiscordAlerter();
    this.loadState();

    // Create the API server
    const app = new Elysia()
      .use(swagger({
        documentation: {
          info: {
            title: 'PingPals Master API',
            version: '1.0.0',
            description: 'Distributed uptime monitoring system - Master node API'
          },
          tags: [
            { name: 'services', description: 'Service management endpoints' },
            { name: 'monitoring', description: 'Monitoring results endpoints' },
            { name: 'slaves', description: 'Slave management endpoints' },
            { name: 'system', description: 'System management endpoints' }
          ]
        }
      }))
      // Add authentication middleware
      .derive(({ request }) => {
        const authHeader = request.headers.get('authorization');
        const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
        return {
          apiKey
        };
      })
      .onError(({ code, error, set }) => {
        if (code === 'VALIDATION' || code === 'NOT_FOUND') {
          set.status = 400;
          return { error: error.message, status: 400 };
        }
        set.status = 500;
        return { error: 'Internal Server Error', status: 500 };
      })
      // Add health check endpoint (no auth required)
      .get('/health', ({ set }) => {
        this.log('Health check requested');
        set.status = 200;
        return { state: 'ok', status: 200 };
      }, {
        detail: {
          tags: ['system'],
          description: 'Health check endpoint'
        }
      })
      // Protected routes
      .guard({
        beforeHandle: ({ apiKey, set }) => {
          if (!this.validateApiKey(apiKey)) {
            set.status = 401;
            return { error: 'Invalid or missing API key', status: 401 };
          }
        }
      }, app => app
        .get('/services', ({ set }) => {
          set.status = 200;
          const services = Array.from(this.services.values()).map(service => ({
            ...service,
            current: service.lastStatus
          }));
          return {
            data: services,
            count: services.length,
            status: 200
          };
        }, {
          detail: {
            tags: ['services'],
            description: 'Get all monitored services'
          }
        })
        .get('/services/:id', ({ params: { id }, set }) => {
          const service = this.services.get(id);
          if (!service) {
            set.status = 404;
            throw new Error(`Service ${id} not found`);
          }
          set.status = 200;
          return { 
            data: {
              ...service,
              current: service.lastStatus
            }, 
            status: 200 
          };
        }, {
          detail: {
            tags: ['services'],
            description: 'Get a specific service by ID'
          }
        })
        .post('/services', async ({ body, set }) => {
          const service = await this.addService(body);
          set.status = 201;
          return { data: service, status: 201 };
        }, {
          body: t.Union([
            t.Object({
              name: t.String(),
              type: t.Literal('http'),
              url: t.String(),
              interval: t.Number(),
              timeout: t.Number()
            }),
            t.Object({
              name: t.String(),
              type: t.Literal('icmp'),
              host: t.String(),
              interval: t.Number(),
              timeout: t.Number()
            })
          ]),
          detail: {
            tags: ['services'],
            description: 'Add a new service to monitor'
          }
        })
        .delete('/services/:id', async ({ params: { id }, set }) => {
          const result = await this.removeService(id);
          set.status = 200;
          return { ...result, status: 200 };
        }, {
          detail: {
            tags: ['services'],
            description: 'Remove a service from monitoring'
          }
        })
        .put('/services/:id', async ({ params: { id }, body, set }) => {
          const service = await this.editService(id, body);
          set.status = 200;
          return { data: service, status: 200 };
        }, {
          body: t.Union([
            t.Object({
              name: t.Optional(t.String()),
              url: t.Optional(t.String()),
              interval: t.Optional(t.Number()),
              timeout: t.Optional(t.Number())
            }),
            t.Object({
              name: t.Optional(t.String()),
              host: t.Optional(t.String()),
              interval: t.Optional(t.Number()),
              timeout: t.Optional(t.Number())
            })
          ]),
          detail: {
            tags: ['services'],
            description: 'Edit a service configuration'
          }
        })
        .post('/heartbeat', ({ headers, set }) => {
          const slaveId = headers['x-slave-id'];
          const slaveName = headers['x-slave-name'] || 'Unknown Slave';
          const services = JSON.parse(headers['x-slave-services'] || '[]');
          
          if (!slaveId) {
            set.status = 400;
            throw new Error('Missing slave ID');
          }
          
          const result = this.handleHeartbeat(slaveId, slaveName, services);
          set.status = 200;
          return { data: result, status: 200 };
        }, {
          detail: {
            tags: ['slaves'],
            description: 'Handle slave heartbeat'
          }
        })
        .post('/report', async ({ body, set }) => {
          await this.handleReport(body.slaveId, body);
          set.status = 200;
          return { status: 200, message: 'Report processed successfully' };
        }, {
          body: t.Object({
            slaveId: t.String(),
            serviceId: t.String(),
            timestamp: t.Number(),
            success: t.Boolean(),
            duration: t.Number(),
            error: t.Union([t.String(), t.Null()])
          }),
          detail: {
            tags: ['monitoring'],
            description: 'Handle monitoring report from slave'
          }
        })
      );

    const port = parseInt(process.env.PORT || '3000');
    app.listen({
      port,
      hostname: process.env.HOST || '0.0.0.0'
    });

    this.log(`🔍 Master is running on port ${port}`);
    this.log(`📚 Swagger documentation available at http://${process.env.HOST || '0.0.0.0'}:${port}/swagger`);

    // Start slave health check loop
    setInterval(() => this.checkSlaveHealth(), 30000);
  }

  private log(message: string) {
    this.logger.info(message);
  }

  private logError(message: string) {
    this.logger.error(message);
  }

  private logWarn(message: string) {
    this.logger.warn(message);
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  private async loadState() {
    try {
      const state = await this.storage.loadState();
      if (state) {
        // Initialize services with default values for any missing properties
        const services = new Map<string, ServiceStatus>();
        for (const [id, service] of Object.entries(state.services)) {
          services.set(id, {
            id: service.id,
            name: service.name,
            type: service.type,
            url: service.url,
            host: service.host,
            interval: service.interval,
            timeout: service.timeout,
            createdAt: service.createdAt,
            lastCheck: service.lastCheck,
            lastStatus: service.lastStatus,
            uptimePercentage: service.uptimePercentage || 100,
            uptimePercentage30d: service.uptimePercentage30d || 100,
            assignedSlaves: service.assignedSlaves || [],
            currentIncident: service.currentIncident || null,
            downtimeLog: service.downtimeLog || [],
            slaveResults: service.slaveResults ? new Map(Object.entries(service.slaveResults)) : new Map()
          });
        }
        this.services = services;
        
        // Initialize slaves with default values
        this.slaves = new Map(Object.entries(state.slaves || {}));
        this.log('📥 Loaded state from storage');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logError(`Failed to load state: ${errorMessage}`);
      // Initialize with empty state
      this.services = new Map();
      this.slaves = new Map();
    }
  }

  private async saveState() {
    try {
      await this.storage.saveState({
        services: Object.fromEntries(this.services),
        slaves: Object.fromEntries(this.slaves)
      });
      this.log('💾 Saved state to storage');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logError(`Failed to save state: ${errorMessage}`);
    }
  }

  private validateApiKey(apiKey: string | undefined): boolean {
    const masterApiKey = process.env.API_KEY;
    if (!masterApiKey) {
      this.logError('API_KEY environment variable not set');
      return false;
    }
    return apiKey === masterApiKey;
  }

  private async addService(config: Omit<HttpServiceConfig | IcmpServiceConfig, 'id'>): Promise<ServiceStatus> {
    const id = crypto.randomUUID();
    const service: ServiceStatus = {
      ...config,
      id,
      createdAt: Date.now(),
      lastCheck: 0,
      lastStatus: 'UP',
      uptimePercentage: 100,
      uptimePercentage30d: 100,
      assignedSlaves: [],
      currentIncident: null,
      downtimeLog: [],
      slaveResults: new Map()
    };

    this.services.set(id, service);
    this.distributeService(service);
    this.saveState();
    return service;
  }

  private async removeService(id: string): Promise<{ status: string; message: string }> {
    const service = this.services.get(id);
    if (!service) {
      throw new Error(`Service ${id} not found`);
    }

    // Notify slaves to stop monitoring
    const promises = service.assignedSlaves.map(async (slaveId) => {
      const slave = this.slaves.get(slaveId);
      if (slave) {
        try {
          // Update slave's service list
          slave.services = slave.services.filter(s => s !== id);
          this.slaves.set(slaveId, slave);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logError(`Failed to notify slave ${slaveId}: ${errorMessage}`);
        }
      }
    });

    await Promise.all(promises);
    this.services.delete(id);
    await this.saveState();

    this.log(`➖ Removed service: ${service.name} (${service.id})`);
    return { status: 'ok', message: `Service ${id} removed` };
  }

  private async editService(id: string, updates: Partial<Omit<HttpServiceConfig | IcmpServiceConfig, 'id' | 'type'>>): Promise<ServiceStatus> {
    const service = this.services.get(id);
    if (!service) {
      throw new Error(`Service ${id} not found`);
    }

    // Type-specific validation
    if (service.type === 'http' && 'host' in updates) {
      throw new Error('Cannot update host for HTTP service');
    }
    if (service.type === 'icmp' && 'url' in updates) {
      throw new Error('Cannot update url for ICMP service');
    }

    // Update service properties
    if (updates.name) {
      service.name = updates.name;
    }
    if (service.type === 'http' && 'url' in updates && typeof updates.url === 'string') {
      service.url = updates.url;
    }
    if (service.type === 'icmp' && 'host' in updates && typeof updates.host === 'string') {
      service.host = updates.host;
    }
    if (updates.interval) {
      service.interval = updates.interval;
    }
    if (updates.timeout) {
      service.timeout = updates.timeout;
    }

    // Save changes and redistribute service
    await this.saveState();
    await this.distributeService(service);

    this.log(`✏️ Updated service: ${service.name} (${service.id})`);
    return service;
  }

  private async distributeService(service: ServiceStatus): Promise<void> {
    // Get all active slaves
    const activeSlaves = Array.from(this.slaves.entries())
      .filter(([_, slave]) => Date.now() - slave.lastSeen < 60000) // Only slaves seen in the last minute
      .map(([id]) => id);

    if (activeSlaves.length === 0) {
      this.logWarn(`No active slaves available to monitor service ${service.id}`);
      return;
    }

    // Assign to slaves round-robin style
    const assignedSlaves = service.assignedSlaves.filter(id => activeSlaves.includes(id));
    while (assignedSlaves.length < Math.min(3, activeSlaves.length)) {
      const availableSlaves = activeSlaves.filter(id => !assignedSlaves.includes(id));
      if (availableSlaves.length === 0) break;
      
      // Select slave with fewest services
      const slaveWithFewestServices = availableSlaves.reduce((a, b) => {
        const servicesA = this.slaves.get(a)?.services.length || 0;
        const servicesB = this.slaves.get(b)?.services.length || 0;
        return servicesA <= servicesB ? a : b;
      });

      assignedSlaves.push(slaveWithFewestServices);
    }

    // Update service's assigned slaves
    service.assignedSlaves = assignedSlaves;
    
    // Update slaves' service lists and notify them
    const notifyPromises = assignedSlaves.map(async (slaveId) => {
      const slave = this.slaves.get(slaveId);
      if (!slave) return;

      try {
        // Add service to slave's list if not already there
        if (!slave.services.includes(service.id)) {
          slave.services.push(service.id);
          this.slaves.set(slaveId, slave);
        }

        // Notify slave about the new service
        const response = await fetch(`http://localhost:${3001 + parseInt(slaveId.replace('slave', '')) - 1}/service`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(service)
        });

        if (!response.ok) {
          throw new Error(`Failed to notify slave: ${response.statusText}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logError(`Failed to notify slave ${slaveId}: ${errorMessage}`);
      }
    });

    // Remove service from unassigned slaves
    for (const [slaveId, slave] of this.slaves.entries()) {
      if (!assignedSlaves.includes(slaveId)) {
        if (slave.services.includes(service.id)) {
          try {
            // Remove service from slave
            await fetch(`http://localhost:${3001 + parseInt(slaveId.replace('slave', '')) - 1}/service/${service.id}`, {
              method: 'DELETE',
              headers: {
                'Authorization': `Bearer ${process.env.API_KEY}`
              }
            });
            
            slave.services = slave.services.filter(s => s !== service.id);
            this.slaves.set(slaveId, slave);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logError(`Failed to remove service from slave ${slaveId}: ${errorMessage}`);
          }
        }
      }
    }

    await Promise.all(notifyPromises);
    await this.saveState();
    this.log(`📡 Distributed service ${service.id} to ${assignedSlaves.length} slaves`);
  }

  private async handleReport(slaveId: string, report: MonitoringResult): Promise<void> {
    try {
      const service = this.services.get(report.serviceId);
      if (!service) {
        throw new Error(`Service ${report.serviceId} not found`);
      }

      // Update slave results
      service.slaveResults.set(slaveId, {
        success: report.success,
        timestamp: report.timestamp,
        error: report.error
      });

      // Calculate new status based on consensus
      const newStatus = this.calculateServiceStatus(report.serviceId);
      
      // Handle status change if needed
      if (service.lastStatus !== newStatus) {
        this.handleStatusChange(service, newStatus);
      }

      // Update service check time
      service.lastCheck = Date.now();

      // Save state
      this.saveState();
    } catch (error) {
      this.logError(`Error handling report from slave ${slaveId}: ${error}`);
      throw error;
    }
  }

  private calculateServiceStatus(serviceId: string): CurrentStatus {
    const service = this.services.get(serviceId);
    if (!service) {
      throw new Error(`Service ${serviceId} not found`);
    }

    // Filter out stale results
    const currentTime = Date.now();
    const validResults = Array.from(service.slaveResults.entries())
      .filter(([_, result]) => {
        return (currentTime - result.timestamp) < this.STALE_RESULT_THRESHOLD;
      });

    if (validResults.length === 0) {
      this.logWarn(`No valid results found for service ${serviceId}`);
      return service.lastStatus; // Keep previous status if no valid results
    }

    // Calculate consensus
    const totalValidResults = validResults.length;
    const successfulResults = validResults.filter(([_, result]) => result.success).length;
    const consensusRatio = successfulResults / totalValidResults;

    // Log the consensus calculation
    this.log(`Service ${serviceId} consensus: ${successfulResults}/${totalValidResults} (${(consensusRatio * 100).toFixed(1)}%)`);

    return consensusRatio >= this.CONSENSUS_THRESHOLD ? 'UP' : 'DOWN';
  }

  private getDateString(timestamp: number): string {
    return new Date(timestamp).toISOString().split('T')[0];
  }

  private pruneOldDowntimeLogs(service: ServiceStatus): void {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.DAYS_TO_KEEP);
    const cutoffDateStr = this.getDateString(cutoffDate.getTime());
    
    service.downtimeLog = service.downtimeLog.filter(log => log.date >= cutoffDateStr);
  }

  private getDailyDowntime(service: ServiceStatus, date: string): DailyDowntime {
    let log = service.downtimeLog.find(l => l.date === date);
    if (!log) {
      log = {
        date,
        downtimeMs: 0,
        incidents: []
      };
      service.downtimeLog.push(log);
      // Sort logs by date to keep them in chronological order
      service.downtimeLog.sort((a, b) => a.date.localeCompare(b.date));
    }
    return log;
  }

  private updateUptimePercentages(service: ServiceStatus): void {
    const now = Date.now();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
    
    // Calculate total downtime for all time
    const totalDowntime = service.downtimeLog.reduce((acc, log) => acc + log.downtimeMs, 0);
    const totalTime = now - service.createdAt;
    service.uptimePercentage = ((totalTime - totalDowntime) / totalTime) * 100;

    // Calculate 30-day downtime
    const recentDowntime = service.downtimeLog
      .filter(log => new Date(log.date).getTime() >= thirtyDaysAgo)
      .reduce((acc, log) => acc + log.downtimeMs, 0);
    const thirtyDayTime = Math.min(totalTime, 30 * 24 * 60 * 60 * 1000);
    service.uptimePercentage30d = ((thirtyDayTime - recentDowntime) / thirtyDayTime) * 100;
  }

  private handleStatusChange(service: ServiceStatus, newStatus: CurrentStatus): void {
    const currentTime = Date.now();
    const currentDate = this.getDateString(currentTime);
    
    // Status is changing to DOWN
    if (newStatus === 'DOWN' && service.lastStatus === 'UP') {
      service.currentIncident = {
        start: currentTime,
        error: this.getSlaveErrors(service)
      };
      
      // Alert about downtime
      this.discord.sendAlert({
        type: 'down',
        service: service.name,
        timestamp: currentTime,
        details: service.currentIncident.error || 'No specific error details available'
      });

      this.log(`🔴 Service ${service.name} is DOWN`);
    } 
    // Status is changing to UP
    else if (newStatus === 'UP' && service.lastStatus === 'DOWN' && service.currentIncident) {
      const downtimeDuration = currentTime - service.currentIncident.start;
      
      // Only record downtime if it exceeds minimum threshold
      if (downtimeDuration >= this.MIN_DOWNTIME_MS) {
        const dailyLog = this.getDailyDowntime(service, currentDate);
        
        // Add the incident
        dailyLog.incidents.push({
          start: service.currentIncident.start,
          end: currentTime,
          error: service.currentIncident.error
        });
        
        // Update total downtime for the day
        dailyLog.downtimeMs += downtimeDuration;
        
        // Prune old logs and update uptime percentages
        this.pruneOldDowntimeLogs(service);
        this.updateUptimePercentages(service);
        
        // Alert about recovery
        this.discord.sendAlert({
          type: 'up',
          service: service.name,
          timestamp: currentTime,
          duration: downtimeDuration
        });

        this.log(`🟢 Service ${service.name} is UP after ${this.formatDuration(downtimeDuration)}`);
      }
      
      // Clear current incident
      service.currentIncident = null;
    }

    // Update service status
    service.lastStatus = newStatus;
  }

  private getSlaveErrors(service: ServiceStatus): string {
    const errors = Array.from(service.slaveResults.entries())
      .filter(([_, result]) => !result.success && result.error)
      .map(([slaveId, result]) => `${slaveId}: ${result.error}`)
      .join(', ');
    
    return errors || 'No specific error details available';
  }

  private async handleHeartbeat(slaveId: string, name: string, services: string[]) {
    const now = Date.now();
    
    // Update or create slave record
    this.slaves.set(slaveId, {
      name,
      lastSeen: now,
      services
    });

    // Check for services that need to be redistributed
    for (const [serviceId, service] of this.services.entries()) {
      const needsRedistribution = 
        // Service has no assigned slaves
        service.assignedSlaves.length === 0 ||
        // Service is assigned to this slave but not in its service list
        (service.assignedSlaves.includes(slaveId) && !services.includes(serviceId)) ||
        // Service has fewer than desired number of slaves
        service.assignedSlaves.length < Math.min(3, this.slaves.size);

      if (needsRedistribution) {
        await this.distributeService(service);
      }
    }

    this.log(`💓 Received heartbeat from slave ${name} (${slaveId})`);
    await this.saveState();
  }

  private checkSlaveHealth() {
    const now = Date.now();
    let unhealthySlaves = 0;

    // Check each slave's last heartbeat
    for (const [slaveId, info] of this.slaves.entries()) {
      if (now - info.lastSeen > 60000) { // No heartbeat in last minute
        unhealthySlaves++;
        this.logWarn(`⚠️ Slave ${info.name} (${slaveId}) appears to be down`);

        // Redistribute its services
        for (const serviceId of info.services) {
          const service = this.services.get(serviceId);
          if (service) {
            this.distributeService(service).catch(error => {
              const errorMessage = error instanceof Error ? error.message : String(error);
              this.logError(`Failed to redistribute service ${serviceId}: ${errorMessage}`);
            });
          }
        }

        // Remove the slave if it's been down for more than 5 minutes
        if (now - info.lastSeen > 300000) {
          this.slaves.delete(slaveId);
          this.logWarn(`❌ Removed unresponsive slave ${info.name} (${slaveId})`);
          this.discord.sendSlaveOfflineAlert(slaveId, info.name);
        }
      }
    }

    if (unhealthySlaves > 0) {
      this.saveState().catch(error => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logError(`Failed to save state after health check: ${errorMessage}`);
      });
    }
  }
}

// Start the master if this is the main module
if (import.meta.main) {
  const master = new UptimeMaster();
}
