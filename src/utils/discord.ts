import { ServiceStatus, MonitoringResult } from '../types';

interface DiscordWebhookMessage {
  content?: string;
  embeds?: DiscordEmbed[];
  username?: string;
  avatar_url?: string;
}

interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields: DiscordEmbedField[];
  timestamp?: string;
}

interface AlertOptions {
  type: 'up' | 'down';
  service: string;
  timestamp: number;
  details?: string;
  duration?: number;
}

const COLORS = {
  UP: 0x00ff00,      // Green
  DOWN: 0xff0000,    // Red
  DEGRADED: 0xffa500 // Orange
};

export class DiscordAlerter {
  private webhookUrl: string | undefined;
  private mentions: string[];

  constructor() {
    this.webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!this.webhookUrl) {
      console.warn('Discord webhook URL not configured. Alerts will be disabled.');
    }

    // Parse mentions from env
    this.mentions = (process.env.DISCORD_ALERT_MENTIONS || '')
      .split(',')
      .map(m => m.trim())
      .filter(Boolean);
  }

  async sendAlert(options: AlertOptions): Promise<void> {
    if (!this.webhookUrl) return;

    const { type, service, timestamp, details, duration } = options;
    const isUp = type === 'up';
    const color = isUp ? COLORS.UP : COLORS.DOWN;
    
    const fields: DiscordEmbedField[] = [
      {
        name: 'Service',
        value: service,
        inline: true
      },
      {
        name: 'Status',
        value: isUp ? '🟢 UP' : '🔴 DOWN',
        inline: true
      },
      {
        name: 'Time',
        value: new Date(timestamp).toLocaleString(),
        inline: true
      }
    ];

    // Add duration for recovery alerts
    if (isUp && duration) {
      fields.push({
        name: 'Downtime Duration',
        value: this.formatDuration(duration),
        inline: true
      });
    }

    // Add error details for downtime alerts
    if (!isUp && details) {
      fields.push({
        name: 'Error Details',
        value: details,
        inline: false
      });
    }

    const message: DiscordWebhookMessage = {
      embeds: [{
        title: `Service ${isUp ? 'Recovery' : 'Downtime'} Alert`,
        description: this.mentions.length > 0 ? this.mentions.join(' ') : undefined,
        color,
        fields,
        timestamp: new Date(timestamp).toISOString()
      }]
    };

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      });

      if (!response.ok) {
        console.error(`Failed to send Discord alert: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error('Error sending Discord alert:', error);
    }
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

  async sendStatusChangeAlert(
    serviceId: string,
    oldStatus: ServiceStatus,
    newStatus: ServiceStatus,
    result: MonitoringResult & { slaveName?: string; slaveId: string }
  ): Promise<void> {
    if (!this.webhookUrl) return;

    const statusEmoji = newStatus.lastStatus ? '🟢' : '🔴';
    const statusText = newStatus.lastStatus ? 'UP' : 'DOWN';
    const oldStatusText = oldStatus.lastStatus ? 'UP' : 'DOWN';
    const duration = result.duration ? `${result.duration}ms` : 'N/A';
    const error = result.error || 'No error details available';

    const embed: DiscordEmbed = {
      title: `${statusEmoji} Service Status Change: ${newStatus.name}`,
      description: `Service has changed status from ${oldStatusText} to ${statusText}`,
      color: newStatus.lastStatus ? COLORS.UP : COLORS.DOWN,
      fields: [
        {
          name: 'Service ID',
          value: serviceId,
          inline: true
        },
        {
          name: 'Check Duration',
          value: duration,
          inline: true
        },
        {
          name: 'Checked By',
          value: result.slaveName || result.slaveId,
          inline: true
        }
      ],
      timestamp: new Date(result.timestamp).toISOString()
    };

    // Add error field if service is down
    if (!newStatus.lastStatus) {
      embed.fields.push({
        name: 'Error Details',
        value: '```\n' + error + '\n```',
        inline: false
      });
    }

    // Add uptime statistics
    embed.fields.push({
      name: 'Uptime Statistics',
      value: `30-day: ${newStatus.uptimePercentage30d.toFixed(2)}%\nOverall: ${newStatus.uptimePercentage.toFixed(2)}%`,
      inline: false
    });

    const message: DiscordWebhookMessage = {
      content: this.formatMentions() + this.getStatusMessage(newStatus, newStatus.name),
      embeds: [embed],
      username: 'PingPals Monitor'
    };

    await this.sendWebhook(message);
  }

  private formatMentions(): string {
    return this.mentions.length ? this.mentions.join(' ') + ' ' : '';
  }

  private getStatusMessage(status: ServiceStatus, serviceName: string): string {
    if (status.lastStatus) {
      return `✅ ${serviceName} is back up!`;
    } else {
      return `🚨 ${serviceName} is down!`;
    }
  }

  async sendSlaveOfflineAlert(slaveId: string, slaveName?: string): Promise<void> {
    if (!this.webhookUrl) return;

    const embed: DiscordEmbed = {
      title: '🔌 Slave Node Offline',
      description: `A slave node has gone offline and is not responding to health checks`,
      color: COLORS.DOWN,
      fields: [
        {
          name: 'Slave ID',
          value: slaveId,
          inline: true
        },
        {
          name: 'Slave Name',
          value: slaveName || 'Unknown',
          inline: true
        }
      ],
      timestamp: new Date().toISOString()
    };

    const message: DiscordWebhookMessage = {
      content: this.formatMentions() + `⚠️ Slave node ${slaveName || slaveId} is offline!`,
      embeds: [embed],
      username: 'PingPals Monitor'
    };

    await this.sendWebhook(message);
  }

  private async sendWebhook(message: DiscordWebhookMessage): Promise<void> {
    if (!this.webhookUrl) return;

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      });

      if (!response.ok) {
        throw new Error(`Discord webhook failed: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error('Failed to send Discord alert:', error);
    }
  }
}
