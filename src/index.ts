import { Elysia } from 'elysia';
import { t } from 'elysia';
import swagger from '@elysiajs/swagger';
import { ServiceStatus, MonitoringResult, HttpServiceConfig, IcmpServiceConfig } from './types';
import { Logger } from './utils/logger';
import { StateStorage } from './storage';

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

  constructor() {
    this.logger = new Logger('MASTER', 'uptime-master');
    this.storage = new StateStorage();
    this.loadState();
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
            lastDowntime: service.lastDowntime || null,
            downtimePeriods: service.downtimePeriods || []
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

  async start(port: number) {
    this.log(`Starting master on port ${port}...`);
    
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
          return { error: error.message };
        }
        set.status = 500;
        return { error: 'Internal Server Error' };
      })
      // Add health check endpoint (no auth required)
      .get('/health', () => {
        this.log('Health check requested');
        return { status: 'ok' };
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
            return { error: 'Invalid or missing API key' };
          }
        }
      }, app => app
        .get('/services', () => {
          return Array.from(this.services.values());
        }, {
          detail: {
            tags: ['services'],
            description: 'Get all monitored services'
          }
        })
        .get('/services/:id', ({ params: { id } }) => {
          const service = this.services.get(id);
          if (!service) {
            throw new Error(`Service ${id} not found`);
          }
          return service;
        }, {
          detail: {
            tags: ['services'],
            description: 'Get a specific service by ID'
          }
        })
        .post('/services', ({ body }) => {
          return this.addService(body);
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
        .delete('/services/:id', ({ params: { id } }) => {
          return this.removeService(id);
        }, {
          detail: {
            tags: ['services'],
            description: 'Remove a service from monitoring'
          }
        })
        .post('/heartbeat', ({ headers }) => {
          const slaveId = headers['x-slave-id'];
          const slaveName = headers['x-slave-name'] || 'Unknown Slave';
          const services = JSON.parse(headers['x-slave-services'] || '[]');
          
          if (!slaveId) {
            throw new Error('Missing slave ID');
          }
          
          return this.handleHeartbeat(slaveId, slaveName, services);
        }, {
          detail: {
            tags: ['slaves'],
            description: 'Handle slave heartbeat'
          }
        })
        .post('/report', ({ body }) => {
          return this.handleReport(body.slaveId, body);
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

    await app.listen(port);
    this.log(`🚀 Master is running on port ${port}`);
    this.log(`📚 Swagger documentation available at http://localhost:${port}/swagger`);

    // Start slave health check loop
    setInterval(() => this.checkSlaveHealth(), 30000);
  }

  private async addService(config: Omit<HttpServiceConfig | IcmpServiceConfig, 'id'>) {
    const id = `service-${Math.random().toString(36).slice(2, 9)}`;
    const now = Date.now();

    let url: string | undefined;
    let host: string | undefined;

    if (config.type === 'http') {
      url = (config as Omit<HttpServiceConfig, 'id'>).url;
    } else {
      host = (config as Omit<IcmpServiceConfig, 'id'>).host;
    }

    const service: ServiceStatus = {
      id,
      name: config.name,
      type: config.type,
      url,
      host,
      interval: config.interval,
      timeout: config.timeout,
      createdAt: now,
      lastCheck: now,
      lastStatus: true,
      uptimePercentage: 100,
      uptimePercentage30d: 100,
      assignedSlaves: [],
      lastDowntime: null,
      downtimePeriods: []
    };

    this.services.set(id, service);
    await this.saveState();
    await this.distributeService(service);

    this.log(`➕ Added new service: ${service.name} (${service.id})`);
    return service;
  }

  private async removeService(id: string) {
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

  private async distributeService(service: ServiceStatus) {
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
    
    // Update slaves' service lists
    for (const [slaveId, slave] of this.slaves.entries()) {
      if (assignedSlaves.includes(slaveId)) {
        if (!slave.services.includes(service.id)) {
          slave.services.push(service.id);
          this.slaves.set(slaveId, slave);
        }
      } else {
        slave.services = slave.services.filter(s => s !== service.id);
        this.slaves.set(slaveId, slave);
      }
    }

    await this.saveState();
    this.log(`📡 Distributed service ${service.id} to ${assignedSlaves.length} slaves`);
  }

  private async handleReport(slaveId: string, result: MonitoringResult) {
    const service = this.services.get(result.serviceId);
    if (!service) {
      this.logWarn(`Received report for unknown service: ${result.serviceId}`);
      return;
    }

    // Update service status
    const now = Date.now();
    service.lastCheck = now;
    service.lastStatus = result.success;
    
    if (!result.success) {
      if (!service.lastDowntime) {
        service.lastDowntime = {
          start: now,
          end: null
        };
      }
    } else if (service.lastDowntime && !service.lastDowntime.end) {
      service.lastDowntime.end = now;
      if (!service.downtimePeriods) {
        service.downtimePeriods = [];
      }
      service.downtimePeriods.push(service.lastDowntime);
      service.lastDowntime = null;
    }

    // Calculate uptime percentage
    if (service.downtimePeriods) {
      const totalDowntime = service.downtimePeriods.reduce((acc, period) => {
        const end = period.end || now;
        return acc + (end - period.start);
      }, 0);
      
      const totalTime = now - service.createdAt;
      service.uptimePercentage = ((totalTime - totalDowntime) / totalTime) * 100;
    } else {
      service.uptimePercentage = 100;
    }

    await this.saveState();
    this.log(`📊 Updated status for service ${result.serviceId}: ${result.success ? 'UP' : 'DOWN'}`);
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
    for (const [slaveId, slave] of this.slaves.entries()) {
      if (now - slave.lastSeen > 60000) { // No heartbeat in last minute
        unhealthySlaves++;
        this.logWarn(`⚠️ Slave ${slave.name} (${slaveId}) appears to be down`);

        // Redistribute its services
        for (const serviceId of slave.services) {
          const service = this.services.get(serviceId);
          if (service) {
            this.distributeService(service).catch(error => {
              const errorMessage = error instanceof Error ? error.message : String(error);
              this.logError(`Failed to redistribute service ${serviceId}: ${errorMessage}`);
            });
          }
        }

        // Remove the slave if it's been down for more than 5 minutes
        if (now - slave.lastSeen > 300000) {
          this.slaves.delete(slaveId);
          this.logWarn(`❌ Removed unresponsive slave ${slave.name} (${slaveId})`);
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
  const port = parseInt(process.env.PORT || '3000');
  const master = new UptimeMaster();
  master.start(port).catch(error => {
    console.error('Failed to start master:', error);
    process.exit(1);
  });
}
