import { spawn } from 'child_process';

interface PingOptions {
  timeout?: number;
  retries?: number;
}

interface PingResult {
  alive: boolean;
  time?: number;
  error?: string;
}

export async function ping(host: string, options: PingOptions = {}): Promise<PingResult> {
  const timeout = options.timeout || 5000;
  const retries = options.retries || 1;

  return new Promise((resolve) => {
    const startTime = Date.now();
    const ping = spawn('ping', [
      '-c', '1',                     // Only send one packet
      '-W', String(timeout / 1000),  // Timeout in seconds
      host
    ]);

    let output = '';
    let error = '';

    ping.stdout.on('data', (data) => {
      output += data.toString();
    });

    ping.stderr.on('data', (data) => {
      error += data.toString();
    });

    ping.on('close', (code) => {
      const endTime = Date.now();
      const time = endTime - startTime;

      if (code === 0) {
        // Extract time from output if available
        const timeMatch = output.match(/time=(\d+(\.\d+)?)/);
        const pingTime = timeMatch ? parseFloat(timeMatch[1]) : time;

        resolve({
          alive: true,
          time: pingTime
        });
      } else {
        resolve({
          alive: false,
          time,
          error: error || 'Host unreachable'
        });
      }
    });

    // Handle timeout
    setTimeout(() => {
      ping.kill();
      resolve({
        alive: false,
        time: timeout,
        error: 'Timeout'
      });
    }, timeout);
  });
}
