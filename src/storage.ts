import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { ServiceConfig, ServiceStatus, SlaveStatus } from './types';

interface StoredState {
  services: { [key: string]: ServiceStatus };
  slaves: { 
    [key: string]: { 
      name: string; 
      lastSeen: number; 
      services: string[];
    }
  };
}

interface StorageData {
  services: {
    configs: ServiceConfig[];
    status: ServiceStatus[];
  };
  slaves: SlaveStatus[];
  lastUpdated: number;
}

export class Storage {
  private dataPath: string;
  private initialized: boolean = false;
  private data: StorageData = {
    services: {
      configs: [],
      status: []
    },
    slaves: [],
    lastUpdated: Date.now()
  };
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private saveDebounceMs = 5000; // 5 seconds

  private log(message: string) {
    console.log(`[STORAGE] ${message}`);
  }

  constructor(storagePath: string = './data') {
    this.dataPath = storagePath;
  }

  private get filePath(): string {
    return join(this.dataPath, 'monitor-state.json');
  }

  private ensureInitialized() {
    if (!this.initialized) {
      throw new Error('Storage not initialized. Call initialize() first.');
    }
  }

  private initializeEmptyState(): StorageData {
    return {
      services: {
        configs: [],
        status: []
      },
      slaves: [],
      lastUpdated: Date.now()
    };
  }

  async initialize(): Promise<void> {
    try {
      // Create data directory if it doesn't exist
      if (!existsSync(this.dataPath)) {
        await mkdir(this.dataPath, { recursive: true });
        this.log(`📁 Created data directory: ${this.dataPath}`);
      }

      // Try to load existing data
      if (existsSync(this.filePath)) {
        const fileContent = await readFile(this.filePath, 'utf-8');
        try {
          const loadedData = JSON.parse(fileContent);
          // Ensure the loaded data has the correct structure
          this.data = {
            ...this.initializeEmptyState(),
            ...loadedData
          };
          this.log(`📥 Loaded existing monitor state: ${this.data.services.configs.length} services, ${this.data.services.status.length} status, ${this.data.slaves.length} slaves`);
        } catch (parseError) {
          console.warn('⚠️  Failed to parse existing state file, creating new one');
          // Don't save here, will save after initialization
        }
      } else {
        this.data = this.initializeEmptyState();
      }

      // Mark as initialized before first save
      this.initialized = true;

      // Create initial state file if it doesn't exist
      if (!existsSync(this.filePath)) {
        await this.save();
        this.log('📝 Created new monitor state file');
      }
    } catch (error) {
      console.error('❌ Failed to initialize storage:', error);
      throw error;
    }
  }

  async loadState(): Promise<StorageData | null> {
    try {
      const content = await readFile(this.filePath, 'utf-8');
      const state = JSON.parse(content);
      return {
        ...this.initializeEmptyState(),
        ...state
      };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        // File doesn't exist yet, return empty state
        return this.initializeEmptyState();
      }
      throw error;
    }
  }

  private debouncedSave(state?: StorageData) {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(async () => {
      await this.save(state);
      this.saveTimeout = null;
    }, this.saveDebounceMs);
  }

  async save(state?: StorageData): Promise<void> {
    this.ensureInitialized();
    try {
      const dataToSave = state || this.data;
      dataToSave.lastUpdated = Date.now();
      await writeFile(this.filePath, JSON.stringify(dataToSave, null, 2), 'utf-8');
      this.log('💾 Saved monitor state');
    } catch (error) {
      console.error('❌ Failed to save monitor state:', error);
      throw error;
    }
  }

  async load(): Promise<StorageData> {
    this.ensureInitialized();
    try {
      const fileContent = await readFile(this.filePath, 'utf-8');
      return JSON.parse(fileContent);
    } catch (error) {
      console.error('❌ Failed to load monitor state:', error);
      throw error;
    }
  }

  getServices(): ServiceConfig[] {
    this.ensureInitialized();
    return this.data.services.configs;
  }

  async getServiceStatus(serviceId: string): Promise<ServiceStatus | undefined> {
    this.ensureInitialized();
    const status = this.data.services.status.find(s => s.id === serviceId);
    if (status && !status.downtimePeriods) {
      status.downtimePeriods = [];
    }
    return status;
  }

  async getAllServiceConfigs(): Promise<ServiceConfig[]> {
    const state = await this.load();
    return state.services.configs;
  }

  async getAllServiceStatus(): Promise<ServiceStatus[]> {
    const state = await this.load();
    return state.services.status.map(status => ({
      ...status,
      downtimePeriods: status.downtimePeriods || [],
      uptimePercentage30d: status.uptimePercentage30d || 100
    }));
  }

  async getAllSlaveStatus(): Promise<SlaveStatus[]> {
    const state = await this.load();
    return state.slaves;
  }

  getSlaves(): SlaveStatus[] {
    this.ensureInitialized();
    return this.data.slaves;
  }

  async addService(service: ServiceConfig): Promise<void> {
    const state = await this.load();
    const now = Date.now();

    const serviceStatus: ServiceStatus = {
      id: service.id,
      name: service.name,
      type: service.type,
      url: service.type === 'http' ? service.url : undefined,
      host: service.type === 'icmp' ? service.host : undefined,
      interval: service.interval,
      timeout: service.timeout,
      createdAt: now,
      lastCheck: now,
      lastStatus: true,
      uptimePercentage: 100,
      uptimePercentage30d: 100,
      assignedSlaves: [],
      lastDowntime: null,
      downtimePeriods: []
    };

    state.services.status.push(serviceStatus);
    this.debouncedSave(state);
  }

  async removeService(serviceId: string): Promise<void> {
    const state = await this.load();
    state.services.configs = state.services.configs.filter(s => s.id !== serviceId);
    state.services.status = state.services.status.filter(s => s.id !== serviceId);
    this.debouncedSave(state);
  }

  private calculateUptimePercentages(service: ServiceStatus, currentTime: number): { total: number, last30d: number } {
    const thirtyDaysAgo = currentTime - (30 * 24 * 60 * 60 * 1000); // 30 days in milliseconds
    
    // Calculate total uptime
    const totalTime = currentTime - service.createdAt;
    const totalDowntimeMs = service.downtimePeriods.reduce((acc, period) => {
      const end = period.end || currentTime;
      return acc + (end - period.start);
    }, 0);
    const totalUptimePercentage = ((totalTime - totalDowntimeMs) / totalTime) * 100;

    // Calculate 30-day uptime
    const recent30dDowntimeMs = service.downtimePeriods
      .filter(period => period.start >= thirtyDaysAgo)
      .reduce((acc, period) => {
        const start = Math.max(period.start, thirtyDaysAgo);
        const end = period.end || currentTime;
        return acc + (end - start);
      }, 0);
    
    const timeWindow30d = Math.min(totalTime, currentTime - thirtyDaysAgo);
    const uptime30dPercentage = ((timeWindow30d - recent30dDowntimeMs) / timeWindow30d) * 100;

    return {
      total: Math.max(0, Math.min(100, totalUptimePercentage)),
      last30d: Math.max(0, Math.min(100, uptime30dPercentage))
    };
  }

  async updateServiceStatus(serviceId: string, status: ServiceStatus): Promise<void> {
    this.log(`📝 Updating status for service ${serviceId}`);
    
    const state = await this.load();
    const serviceIndex = state.services.status.findIndex(s => s.id === serviceId);
    if (serviceIndex === -1) {
      state.services.status.push(status);
    } else {
      state.services.status[serviceIndex] = status;
    }
    
    // Update in-memory data as well
    this.data = state;
    this.data.lastUpdated = Date.now();
    
    // Calculate uptime percentages
    const uptimePercentages = this.calculateUptimePercentages(status, Date.now());
    status.uptimePercentage = uptimePercentages.total;
    status.uptimePercentage30d = uptimePercentages.last30d;
    
    this.debouncedSave(this.data);
  }

  async loadServiceStatus(serviceId: string): Promise<ServiceStatus | undefined> {
    const state = await this.load();
    const status = state.services.status.find(s => s.id === serviceId);
    
    if (status) {
      return {
        ...status,
        downtimePeriods: status.downtimePeriods || [],
        uptimePercentage30d: status.uptimePercentage30d || 100
      };
    }
    
    return undefined;
  }

  async updateSlaveStatus(slaveId: string, status: SlaveStatus): Promise<void> {
    const state = await this.load();
    const index = state.slaves.findIndex(s => s.id === slaveId);
    if (index !== -1) {
      state.slaves[index] = status;
    } else {
      state.slaves.push(status);
    }
    this.debouncedSave(state);
  }

  async getSlaveStatus(slaveId: string): Promise<SlaveStatus | null> {
    await this.load();
    return this.data.slaves.find(slave => slave.id === slaveId) || null;
  }
}

export class StateStorage {
  private dataDir: string;
  private stateFile: string;

  constructor() {
    this.dataDir = join(process.cwd(), 'data');
    this.stateFile = join(this.dataDir, 'monitor-state.json');
  }

  async loadState(): Promise<StoredState | null> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      const data = await readFile(this.stateFile, 'utf-8');
      return JSON.parse(data) as StoredState;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        // File doesn't exist yet, return null
        return null;
      }
      throw error;
    }
  }

  async saveState(state: StoredState): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.stateFile, JSON.stringify(state, null, 2), 'utf-8');
  }

  async updateServiceStatus(id: string, status: ServiceStatus): Promise<void> {
    const state = await this.loadState() || { services: {}, slaves: {} };
    state.services[id] = status;
    await this.saveState(state);
  }

  async updateSlaveStatus(id: string, status: { name: string; lastSeen: number; services: string[] }): Promise<void> {
    const state = await this.loadState() || { services: {}, slaves: {} };
    state.slaves[id] = status;
    await this.saveState(state);
  }

  async getAllServiceStatus(): Promise<ServiceStatus[]> {
    const state = await this.loadState();
    if (!state) return [];
    return Object.values(state.services);
  }

  async getServiceStatus(id: string): Promise<ServiceStatus | null> {
    const state = await this.loadState();
    if (!state) return null;
    return state.services[id] || null;
  }
}
