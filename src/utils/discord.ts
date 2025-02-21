import { ServiceCheck, ServiceStatus } from '../types';

interface DiscordWebhookMessage {
    content?: string;
    embeds?: DiscordEmbed[];
    username?: string;
    avatar_url?: string;
}

interface DiscordEmbed {
    title?: string;
    description?: string;
    color?: number;
    fields?: { name: string; value: string; inline?: boolean }[];
    timestamp?: string;
}

const COLORS = {
    UP: 0x00ff00,      // Green
    DOWN: 0xff0000,    // Red
    DEGRADED: 0xffa500 // Orange
};

export class DiscordAlerter {
    private webhookUrl: string;
    private mentions: string[];

    constructor() {
        const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
        if (!webhookUrl) {
            console.warn('Discord webhook URL not configured. Alerts will be disabled.');
        }
        this.webhookUrl = webhookUrl || '';
        
        // Parse mentions from env
        this.mentions = (process.env.DISCORD_ALERT_MENTIONS || '')
            .split(',')
            .map(m => m.trim())
            .filter(Boolean);
    }

    private async sendWebhook(message: DiscordWebhookMessage): Promise<void> {
        if (!this.webhookUrl) return;

        try {
            const response = await fetch(this.webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(message),
            });

            if (!response.ok) {
                throw new Error(`Discord webhook failed: ${response.statusText}`);
            }
        } catch (error) {
            console.error('Failed to send Discord alert:', error);
        }
    }

    private getStatusColor(status: ServiceStatus): number {
        switch (status) {
            case 'up': return COLORS.UP;
            case 'down': return COLORS.DOWN;
            case 'degraded': return COLORS.DEGRADED;
            default: return COLORS.DOWN;
        }
    }

    private formatMentions(): string {
        return this.mentions.length ? this.mentions.join(' ') + ' ' : '';
    }

    async sendStatusChangeAlert(
        serviceName: string,
        oldStatus: ServiceStatus,
        newStatus: ServiceStatus,
        check: ServiceCheck
    ): Promise<void> {
        const embed: DiscordEmbed = {
            title: `🔔 Service Status Change: ${serviceName}`,
            description: `Status changed from **${oldStatus.toUpperCase()}** to **${newStatus.toUpperCase()}**`,
            color: this.getStatusColor(newStatus),
            fields: [
                {
                    name: 'Service URL',
                    value: check.url,
                    inline: true
                },
                {
                    name: 'Response Time',
                    value: `${check.responseTime}ms`,
                    inline: true
                },
                {
                    name: 'Checked From',
                    value: check.slaveName || check.slaveId,
                    inline: true
                }
            ],
            timestamp: new Date().toISOString()
        };

        if (check.error) {
            embed.fields?.push({
                name: 'Error Details',
                value: `\`\`\`\n${check.error}\n\`\`\``,
                inline: false
            });
        }

        const message: DiscordWebhookMessage = {
            content: this.formatMentions() + this.getStatusMessage(newStatus, serviceName),
            embeds: [embed],
            username: 'PingPals Monitor'
        };

        await this.sendWebhook(message);
    }

    private getStatusMessage(status: ServiceStatus, serviceName: string): string {
        switch (status) {
            case 'up':
                return `✅ ${serviceName} is back up!`;
            case 'down':
                return `🚨 ${serviceName} is down!`;
            case 'degraded':
                return `⚠️ ${serviceName} is experiencing degraded performance!`;
            default:
                return `Status update for ${serviceName}`;
        }
    }

    async sendSlaveOfflineAlert(slaveId: string, slaveName?: string): Promise<void> {
        const message: DiscordWebhookMessage = {
            content: this.formatMentions() + `🔌 Monitor node offline: ${slaveName || slaveId}`,
            embeds: [{
                title: '🔌 Monitor Node Offline',
                description: 'A monitoring node has gone offline and is no longer reporting status.',
                color: COLORS.DOWN,
                fields: [
                    {
                        name: 'Node ID',
                        value: slaveId,
                        inline: true
                    },
                    {
                        name: 'Node Name',
                        value: slaveName || 'N/A',
                        inline: true
                    }
                ],
                timestamp: new Date().toISOString()
            }],
            username: 'PingPals Monitor'
        };

        await this.sendWebhook(message);
    }
}
