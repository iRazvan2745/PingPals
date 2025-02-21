import { mkdir, appendFile } from 'fs/promises';
import { join } from 'path';

export class Logger {
  private logDir: string;
  private component: string;
  private instanceId: string;
  private logFile: string;

  constructor(component: string, instanceId: string) {
    this.component = component;
    this.instanceId = instanceId;
    this.logDir = join(process.cwd(), 'logs');
    
    // Create log filename with date
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    this.logFile = join(this.logDir, `${dateStr}-${component}-${instanceId}.log`);
    
    // Ensure log directory exists
    this.init();
  }

  private async init() {
    try {
      await mkdir(this.logDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create logs directory:', error);
    }
  }

  async log(message: string, level: 'info' | 'warn' | 'error' = 'info') {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${level.toUpperCase()}] [${this.component}:${this.instanceId}] ${message}\n`;
    
    // Write to console
    console.log(logEntry.trim());
    
    try {
      // Write to file
      await appendFile(this.logFile, logEntry);
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  async info(message: string) {
    return this.log(message, 'info');
  }

  async warn(message: string) {
    return this.log(message, 'warn');
  }

  async error(message: string) {
    return this.log(message, 'error');
  }
}
