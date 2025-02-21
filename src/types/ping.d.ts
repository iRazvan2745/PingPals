declare module 'ping' {
  interface PingConfig {
    numeric?: boolean;
    timeout?: number;
    deadline?: number;
    min_reply?: number;
    v6?: boolean;
    sourceAddr?: string;
    extra?: string[];
  }

  interface PingResponse {
    host: string;
    numeric_host: string;
    alive: boolean;
    output: string;
    time: number;
    times: number[];
    min: string;
    max: string;
    avg: string;
    stddev: string;
    packetLoss: string;
  }

  export const promise: {
    probe: (host: string, config?: PingConfig) => Promise<PingResponse>;
  };

  export function sys(): {
    probe: (host: string, config?: PingConfig) => Promise<PingResponse>;
  };
}
