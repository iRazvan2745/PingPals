import { spawn } from 'child_process';
import fetch from 'node-fetch';
import { UptimeMaster } from './index';
import { MasterConfig } from './types';

const startProcess = (command: string, env: Record<string, string>) => {
  const proc = spawn('bun', ['run', command], {
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });

  proc.on('error', (error) => {
    console.error(`Process ${command} failed to start:`, error);
  });

  return proc;
};

const waitForPort = async (port: number, retries = 20, delay = 1000): Promise<boolean> => {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Attempt ${i + 1}/${retries} to connect to port ${port}...`);
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) {
        return true;
      }
    } catch (e) {
      console.log(`Master not ready yet, waiting ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  return false;
};

console.log('🚀 Starting Master...');

// Generate a development API key
process.env.NODE_ENV = 'development';
process.env.API_KEY = process.env.API_KEY || 'dev-' + Math.random().toString(36).slice(2);
process.env.PORT = process.env.PORT || '3000';
process.env.HOST = process.env.HOST || 'localhost';

console.log('🔑 Using development API key:', process.env.API_KEY);

// Create master configuration
const config: MasterConfig = {
  port: parseInt(process.env.PORT || '3000'),
  host: process.env.HOST || '0.0.0.0',
  apiKey: process.env.API_KEY,
  slaves: [],
  heartbeatInterval: 30,
  stateRetentionPeriod: 30 * 24 * 60 * 60, // 30 days in seconds
  maxServicesPerSlave: 50,
  allowedOrigins: ['*'],
  rateLimit: 100
};

// Development environment configuration
process.env.NODE_ENV = 'development';
process.env.API_KEY = process.env.API_KEY || 'dev-key';
process.env.PORT = process.env.PORT || '3000';
process.env.HOST = process.env.HOST || '0.0.0.0';
process.env.ALLOWED_ORIGINS = '*';
process.env.STATE_RETENTION_DAYS = '30';
process.env.DATA_DIR = './data';
process.env.SLAVE_HEARTBEAT_INTERVAL = '30';

console.log('🚀 Starting master in development mode...');
console.log(`API Key: ${process.env.API_KEY}`);
console.log(`Listening on: http://${process.env.HOST}:${process.env.PORT}`);

// Start the master
const master = new UptimeMaster();

// Handle graceful shutdown
const cleanup = () => {
  console.log('\n👋 Shutting down master...');
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
