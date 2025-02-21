import { spawn } from 'child_process';
import fetch from 'node-fetch';

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

console.log('🚀 Starting development cluster...');

// Generate a development API key
const DEV_API_KEY = 'dev-' + Math.random().toString(36).slice(2);
console.log('🔑 Using development API key:', DEV_API_KEY);

// Start master
const master = startProcess('src/master.ts', {
  PORT: '3000',
  HOST: 'localhost',
  API_KEY: DEV_API_KEY,
  NODE_ENV: 'development',
  ALLOWED_ORIGINS: '*',
  STATE_RETENTION_DAYS: '30',
  DATA_DIR: './data',
  SLAVE_HEARTBEAT_INTERVAL: '30'
});

// Start slaves after ensuring master is ready
const startSlaves = async () => {
  console.log('⏳ Waiting for master to start...');
  const masterReady = await waitForPort(3000);
  
  if (!masterReady) {
    console.error('❌ Master failed to start within timeout period');
    cleanup();
    process.exit(1);
  }

  console.log('✅ Master is ready, starting slaves...');

  // Start slaves
  const slave1 = startProcess('src/slave.ts', {
    PORT: '3001',
    HOST: 'localhost',
    SLAVE_ID: 'slave1',
    SLAVE_NAME: 'Local Dev Slave 1',
    MASTER_URL: 'http://localhost:3000',
    API_KEY: DEV_API_KEY,
    NODE_ENV: 'development',
    MAX_CONCURRENT_CHECKS: '50',
    CHECK_TIMEOUT: '30000',
    RETRY_ATTEMPTS: '3'
  });

  const slave2 = startProcess('src/slave.ts', {
    PORT: '3002',
    HOST: 'localhost',
    SLAVE_ID: 'slave2',
    SLAVE_NAME: 'Local Dev Slave 2',
    MASTER_URL: 'http://localhost:3000',
    API_KEY: DEV_API_KEY,
    NODE_ENV: 'development',
    MAX_CONCURRENT_CHECKS: '50',
    CHECK_TIMEOUT: '30000',
    RETRY_ATTEMPTS: '3'
  });

  processes.push(slave1, slave2);
};

const processes = [master];

const cleanup = () => {
  console.log('\n🛑 Shutting down development cluster...');
  for (const proc of processes) {
    proc.kill();
  }
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

startSlaves();
