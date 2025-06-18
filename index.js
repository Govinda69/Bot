require('dotenv').config();
const mineflayer = require('mineflayer');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');

// Enhanced Configuration with validation
const CONFIG = {
    minecraft: {
        host: process.env.MC_HOST || '8b8t.me',
        port: parseInt(process.env.MC_PORT) || 25565,
        username: process.env.MC_USERNAME || '0xPwnd_Bot',
        version: process.env.MC_VERSION || '1.20.4',
        reconnectDelay: 30000,
        maxReconnectAttempts: 10,
        loginDelay: 3000,
        loginTimeout: 15000,
        loginMaxRetries: 5,
        healthThreshold: 5,
        maxChatLength: 256
    },
    kit: {
        cooldownTime: 30 * 1000,
        vipCooldownTime: 10 * 1000, // VIP users get shorter cooldown
        teleportTimeout: 25000,
        deliveryDelay: 3000,
        proximityDistance: 5,
        tpaAcceptDelay: 2000,
        maxQueueSize: 50,
        autoCleanupInterval: 600000 // 10 minutes
    },
    spammer: {
        interval: 40000,
        filePath: 'spammer.txt',
        maxMessageLength: 100,
        randomDelay: 5000 // Random delay variation
    },
    discord: {
        embedColor: {
            success: 0x00ff00,
            error: 0xff0000,
            warning: 0xffaa00,
            info: 0x0099ff
        }
    }
};

// Enhanced State Management with persistence
class BotState extends EventEmitter {
    constructor() {
        super();
        this.cooldowns = new Map();
        this.vipUsers = new Set(['0xpwnd', 'bigbear','dragonkit']); // VIP users list
        this.kitInProgress = false;
        this.kitQueue = [];
        this.devModeEnabled = false;
        this.currentKitAsker = null;
        this.spammerInterval = null;
        this.spammerStarted = false;
        this.reconnectAttempts = 0;
        this.isConnected = false;
        this.isLoggedIn = false;
        this.loginTimeout = null;
        this.loginAttempts = 0;
        this.loginInProgress = false;
        this.waitingForTpaAccept = false;
        this.tpaTimeout = null;
        this.initialPosition = null;
        this.positionWatcher = null;
        this.botHealth = 20;
        this.botPosition = { x: 0, y: 0, z: 0 };
        this.dimension = 'overworld';
        this.stats = {
            kitsDelivered: 0,
            messagesReceived: 0,
            uptime: Date.now(),
            reconnects: 0
        };
        this.setupCleanupTimer();
    }

    reset() {
        this.kitInProgress = false;
        this.kitQueue = [];
        this.currentKitAsker = null;
        this.stopSpammer();
        this.isConnected = false;
        this.isLoggedIn = false;
        this.loginAttempts = 0;
        this.loginInProgress = false;
        this.waitingForTpaAccept = false;
        this.stats.reconnects++;
        this.clearTimeouts();
        this.emit('reset');
    }

    clearTimeouts() {
        [this.loginTimeout, this.tpaTimeout].forEach(timeout => {
            if (timeout) {
                clearTimeout(timeout);
            }
        });
        this.loginTimeout = null;
        this.tpaTimeout = null;
    }

    stopSpammer() {
        if (this.spammerInterval) {
            clearInterval(this.spammerInterval);
            this.spammerInterval = null;
        }
        this.spammerStarted = false;
    }
    toggleDevMode() {
        this.devModeEnabled = !this.devModeEnabled;
        return this.devModeEnabled;
    }

    setupCleanupTimer() {
        setInterval(() => {
            this.cleanupOldCooldowns();
        }, CONFIG.kit.autoCleanupInterval);
    }

    cleanupOldCooldowns() {
        const now = Date.now();
        const maxAge = Math.max(CONFIG.kit.cooldownTime, CONFIG.kit.vipCooldownTime) * 2;
        
        for (const [user, timestamp] of this.cooldowns.entries()) {
            if (now - timestamp > maxAge) {
                this.cooldowns.delete(user);
            }
        }
    }

    addVipUser(username) {
        this.vipUsers.add(username.toLowerCase());
        this.emit('vipAdded', username);
    }

    removeVipUser(username) {
        this.vipUsers.delete(username.toLowerCase());
        this.emit('vipRemoved', username);
    }

    isVip(username) {
        return this.vipUsers.has(username.toLowerCase());
    }

    getUptime() {
        return Date.now() - this.stats.uptime;
    }
}

// Enhanced Giveaway System
class GiveawayManager extends EventEmitter {
    constructor() {
        super();
        this.activeGiveaway = null;
        this.giveawaySpammerInterval = null;
        this.giveawaySpammerActive = false;
        this.giveawayMessages = [
            '🎉 GIVEAWAY ACTIVE! Join with $giveaway',
            '🏆 Free prizes! Type $giveaway to enter',
            '⏰ Don\'t miss out! $giveaway to participate',
            '🎁 Active giveaway! Use $giveaway info for details'
        ];
    }

    createGiveaway(title, prize, durationMinutes, createdBy) {
        if (this.activeGiveaway) {
            return { success: false, message: 'A giveaway is already active!' };
        }

        const endTime = Date.now() + (durationMinutes * 60 * 1000);

        this.activeGiveaway = {
            id: Math.random().toString(36).substr(2, 9),
            title: title,
            prize: prize,
            duration: durationMinutes,
            startTime: Date.now(),
            endTime: endTime,
            participants: new Set(),
            createdBy: createdBy,
            active: true
        };

        // Stop normal spammer and start giveaway spammer
        this.startGiveawaySpammer();

        // Set auto-end timer
        this.activeGiveaway.autoEndTimer = setTimeout(() => {
            this.endGiveaway(true);
        }, durationMinutes * 60 * 1000);

        this.emit('giveawayCreated', this.activeGiveaway);
        return { success: true, giveaway: this.activeGiveaway };
    }

    joinGiveaway(username) {
        if (!this.activeGiveaway || !this.activeGiveaway.active) {
            return { success: false, message: 'No active giveaway!' };
        }

        if (Date.now() > this.activeGiveaway.endTime) {
            return { success: false, message: 'Giveaway has ended!' };
        }

        const cleanUsername = username.toLowerCase();

        if (this.activeGiveaway.participants.has(cleanUsername)) {
            return { success: false, message: 'You are already entered in this giveaway!' };
        }

        this.activeGiveaway.participants.add(cleanUsername);
        this.emit('participantJoined', { username, giveaway: this.activeGiveaway });

        return { 
            success: true, 
            message: `Successfully entered the giveaway! (${this.activeGiveaway.participants.size} participants)`,
            participantCount: this.activeGiveaway.participants.size
        };
    }

    getGiveawayInfo() {
        if (!this.activeGiveaway || !this.activeGiveaway.active) {
            return { success: false, message: 'No active giveaway!' };
        }

        const timeLeft = Math.max(0, this.activeGiveaway.endTime - Date.now());
        const minutesLeft = Math.floor(timeLeft / 60000);
        const secondsLeft = Math.floor((timeLeft % 60000) / 1000);

        return {
            success: true,
            giveaway: this.activeGiveaway,
            timeLeft: `${minutesLeft}m ${secondsLeft}s`,
            participantCount: this.activeGiveaway.participants.size
        };
    }

    endGiveaway(autoEnd = false) {
        if (!this.activeGiveaway) {
            return { success: false, message: 'No active giveaway!' };
        }

        // Clear auto-end timer
        if (this.activeGiveaway.autoEndTimer) {
            clearTimeout(this.activeGiveaway.autoEndTimer);
        }

        const giveaway = this.activeGiveaway;
        const participants = Array.from(giveaway.participants);

        let winner = null;
        if (participants.length > 0) {
            const randomIndex = Math.floor(Math.random() * participants.length);
            winner = participants[randomIndex];
        }

        const result = {
            giveaway: giveaway,
            winner: winner,
            participantCount: participants.length,
            autoEnd: autoEnd
        };

        // Stop giveaway spammer and restart normal spammer
        this.stopGiveawaySpammer();

        // Mark as inactive
        this.activeGiveaway.active = false;
        this.activeGiveaway = null;

        this.emit('giveawayEnded', result);
        return { success: true, result: result };
    }

    cancelGiveaway() {
        if (!this.activeGiveaway) {
            return { success: false, message: 'No active giveaway!' };
        }

        // Clear auto-end timer
        if (this.activeGiveaway.autoEndTimer) {
            clearTimeout(this.activeGiveaway.autoEndTimer);
        }

        const giveaway = this.activeGiveaway;

        // Stop giveaway spammer and restart normal spammer
        this.stopGiveawaySpammer();

        this.activeGiveaway = null;

        this.emit('giveawayCancelled', giveaway);
        return { success: true, giveaway: giveaway };
    }

    startGiveawaySpammer() {
        // Stop normal spammer first
        if (state.spammerInterval) {
            state.stopSpammer();
        }

        if (this.giveawaySpammerActive) return;

        this.giveawaySpammerActive = true;
        let messageIndex = 0;

        const sendGiveawayMessage = async () => {
            if (!this.giveawaySpammerActive || !this.activeGiveaway) {
                this.stopGiveawaySpammer();
                return;
            }

            const message = this.giveawayMessages[messageIndex];
            if (await safeChat(message)) {
                messageIndex = (messageIndex + 1) % this.giveawayMessages.length;
            }

            // Random delay for giveaway spam (more frequent than normal)
            const randomDelay = Math.floor(Math.random() * 3000);
            setTimeout(sendGiveawayMessage, 15000 + randomDelay); // 15s base interval
        };

        // Start giveaway spammer
        setTimeout(sendGiveawayMessage, 5000); // Initial delay
        logger.info('Giveaway spammer started');
    }

    stopGiveawaySpammer() {
        if (this.giveawaySpammerInterval) {
            clearInterval(this.giveawaySpammerInterval);
            this.giveawaySpammerInterval = null;
        }
        this.giveawaySpammerActive = false;

        // Restart normal spammer after delay
        setTimeout(async () => {
            if (state.isConnected && state.isLoggedIn && !this.activeGiveaway) {
                await startSpammer();
            }
        }, 2000);

        logger.info('Giveaway spammer stopped, normal spammer will restart');
    }

    hasActiveGiveaway() {
        return this.activeGiveaway !== null && this.activeGiveaway.active;
    }

    getStats() {
        if (!this.activeGiveaway) return null;

        return {
            title: this.activeGiveaway.title,
            prize: this.activeGiveaway.prize,
            participants: this.activeGiveaway.participants.size,
            timeLeft: Math.max(0, this.activeGiveaway.endTime - Date.now()),
            active: this.activeGiveaway.active
        };
    }
}

// Create giveaway manager instance
const giveawayManager = new GiveawayManager();

// Giveaway event handlers
giveawayManager.on('giveawayCreated', async (giveaway) => {
    const startMessage = `🎉 GIVEAWAY STARTED! 🎉\n` +
                        `🏆 Prize: ${giveaway.prize}\n` +
                        `⏰ Duration: ${giveaway.duration} minutes\n` +
                        `📝 Join with: $giveaway\n` +
                        `ℹ️ Info: $giveaway info`;

    // Announce in Minecraft
    await safeChat(startMessage.split('\n')[0]); // First line
    await delay(1000);
    await safeChat(`🏆 Prize: ${giveaway.prize}`);
    await delay(1000);
    await safeChat(`⏰ ${giveaway.duration} minutes | Join: $giveaway`);

    // Announce in Discord
    const discordEmbed = createEmbed(
        '🎉 Giveaway Started!',
        `**Prize:** ${giveaway.prize}\n` +
        `**Duration:** ${giveaway.duration} minutes\n` +
        `**How to join:** Type \`$giveaway\` in Minecraft chat\n` +
        `**Started by:** ${giveaway.createdBy}`,
        CONFIG.discord.embedColor.success,
        [
            { name: '📊 Participants', value: '0', inline: true },
            { name: '⏰ Ends at', value: `<t:${Math.floor(giveaway.endTime / 1000)}:F>`, inline: true }
        ]
    );

    await sendToDiscord(process.env.DISCORD_CHANNEL_ID, discordEmbed, true);
    logger.info(`Giveaway created: ${giveaway.title} - ${giveaway.prize}`);
});

giveawayManager.on('participantJoined', async (data) => {
    logger.debug(`${data.username} joined giveaway (${data.giveaway.participants.size} participants)`);
});

giveawayManager.on('giveawayEnded', async (result) => {
    const { giveaway, winner, participantCount, autoEnd } = result;

    if (winner) {
        // Announce winner in Minecraft
        await safeChat(`🎉 GIVEAWAY ENDED! Winner: ${winner}!`);
        await delay(1000);
        await safeChat(`🏆 ${winner} won: ${giveaway.prize}`);
        await delay(1000);
        await safeChat(`🎊 Congratulations ${winner}!`);

        // Send private message to winner
        await safeChat(`/msg ${winner} &5🎉 CONGRATULATIONS! You won the giveaway! Prize: ${giveaway.prize}. Contact staff to claim your prize!`);

        // Discord announcement
        const winnerEmbed = createEmbed(
            '🎉 Giveaway Ended - Winner!',
            `**Winner:** ${winner}\n` +
            `**Prize:** ${giveaway.prize}\n` +
            `**Participants:** ${participantCount}`,
            CONFIG.discord.embedColor.success,
            [
                { name: '🎊 Congratulations!', value: `<@everyone> ${winner} won the giveaway!`, inline: false },
                { name: '📊 Statistics', value: `${participantCount} total participants`, inline: true },
                { name: '⏰ Duration', value: `${giveaway.duration} minutes`, inline: true }
            ]
        );

        await sendToDiscord(process.env.DISCORD_CHANNEL_ID, winnerEmbed, true);
    } else {
        // No participants
        await safeChat(`🎉 Giveaway ended - No participants!`);

        const noWinnerEmbed = createEmbed(
            '🎉 Giveaway Ended - No Winner',
            `**Prize:** ${giveaway.prize}\n` +
            `**Participants:** 0\n` +
            `**Result:** No one participated`,
            CONFIG.discord.embedColor.warning
        );

        await sendToDiscord(process.env.DISCORD_CHANNEL_ID, noWinnerEmbed, true);
    }

    logger.info(`Giveaway ended: ${winner ? `Winner: ${winner}` : 'No participants'} (${participantCount} participants)`);
});

giveawayManager.on('giveawayCancelled', async (giveaway) => {
    // Announce cancellation in Minecraft
    await safeChat(`❌ Giveaway cancelled by admin!`);
    await delay(1000);
    await safeChat(`🚫 Prize: ${giveaway.prize} - No winner`);

    // Discord announcement
    const cancelEmbed = createEmbed(
        '❌ Giveaway Cancelled',
        `**Prize:** ${giveaway.prize}\n` +
        `**Participants:** ${giveaway.participants.size}\n` +
        `**Status:** Cancelled by administrator`,
        CONFIG.discord.embedColor.error
    );

    await sendToDiscord(process.env.DISCORD_CHANNEL_ID, cancelEmbed, true);
    logger.info(`Giveaway cancelled: ${giveaway.title}`);
});

// Helper function to format time
function formatGiveawayTime(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

const state = new BotState();
const blacklistedUsers = new Set(['ump', '_pigy_', 'thetroll2001']);

// Enhanced Discord client
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ]
});

let mcBot;

// Enhanced Logger with different levels
class Logger {
    constructor() {
        this.logLevel = process.env.LOG_LEVEL || 'info';
        this.levels = { debug: 0, info: 1, warn: 2, error: 3 };
    }

    log(level, msg, data = null) {
        if (this.levels[level] >= this.levels[this.logLevel]) {
            const timestamp = new Date().toISOString();
            const logMsg = `[${level.toUpperCase()}] ${timestamp}: ${msg}`;
            
            if (level === 'error') {
                console.error(logMsg, data || '');
            } else if (level === 'warn') {
                console.warn(logMsg, data || '');
            } else {
                console.log(logMsg, data || '');
            }
        }
    }

    debug(msg, data) { this.log('debug', msg, data); }
    info(msg, data) { this.log('info', msg, data); }
    warn(msg, data) { this.log('warn', msg, data); }
    error(msg, data) { this.log('error', msg, data); }
}

const logger = new Logger();

// Utility functions
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const sanitizeMessage = (message) => {
    return message.replace(/[^\x20-\x7E]/g, '').trim().substring(0, CONFIG.minecraft.maxChatLength);
};

const formatUptime = (ms) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
};

// Enhanced safe chat function with rate limiting
class ChatManager {
    constructor() {
        this.messageQueue = [];
        this.processing = false;
        this.lastMessageTime = 0;
        this.minDelay = 1000; // Minimum delay between messages
    }

    async safeChat(message, priority = false, bypassLoginCheck = false) {
        const allowedCommands = ['/login', '/8b8t', '/help'];
        const isAllowedCommand = allowedCommands.some(cmd => message.startsWith(cmd));
        
        if (!mcBot || !mcBot._client || !state.isConnected) {
            logger.warn(`Cannot send message - bot not connected: ${message}`);
            return false;
        }
        
        if (!state.isLoggedIn && !bypassLoginCheck && !isAllowedCommand) {
            logger.warn(`Cannot send message - bot not logged in: ${message}`);
            return false;
        }

        const cleanMessage = sanitizeMessage(message);
        if (cleanMessage.length === 0) {
            logger.warn('Message became empty after cleaning');
            return false;
        }

        return new Promise((resolve) => {
            const messageItem = { message: cleanMessage, resolve, priority };
            
            if (priority) {
                this.messageQueue.unshift(messageItem);
            } else {
                this.messageQueue.push(messageItem);
            }
            
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.processing || this.messageQueue.length === 0) return;
        
        this.processing = true;
        
        while (this.messageQueue.length > 0) {
            const now = Date.now();
            const timeSinceLastMessage = now - this.lastMessageTime;
            
            if (timeSinceLastMessage < this.minDelay) {
                await delay(this.minDelay - timeSinceLastMessage);
            }
            
            const { message, resolve } = this.messageQueue.shift();
            
            try {
                mcBot.chat(message);
                logger.debug(`Sent: ${message}`);
                this.lastMessageTime = Date.now();
                resolve(true);
            } catch (error) {
                logger.error(`Failed to send chat message: ${error.message}`);
                resolve(false);
            }
            
            // Small delay between messages
            await delay(500);
        }
        
        this.processing = false;
    }
}

const chatManager = new ChatManager();
const safeChat = (message, priority = false, bypassLoginCheck = false) => 
    chatManager.safeChat(message, priority, bypassLoginCheck);

// Enhanced Discord utilities
function createEmbed(title, description, color = CONFIG.discord.embedColor.info, fields = []) {
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp();
    
    if (fields.length > 0) {
        embed.addFields(fields);
    }
    
    return embed;
}

async function sendToDiscord(channelId, content, isEmbed = false, components = null) {
    try {
        const channel = discordClient.channels.cache.get(channelId);
        if (!channel) {
            logger.error(`Channel ${channelId} not found`);
            return;
        }

        const messageOptions = {};
        if (isEmbed) {
            messageOptions.embeds = [content];
        } else {
            messageOptions.content = content;
        }
        
        if (components) {
            messageOptions.components = components;
        }

        return await channel.send(messageOptions);
    } catch (error) {
        logger.error(`Failed to send Discord message: ${error.message}`);
    }
}

// Enhanced login sequence
async function performLoginSequence() {
    if (state.loginInProgress) {
        logger.warn('Login already in progress');
        return;
    }

    state.loginInProgress = true;
    state.loginAttempts++;
    
    logger.info(`Starting login sequence (attempt ${state.loginAttempts})`);
    
    try {
        await delay(CONFIG.minecraft.loginDelay);
        
        logger.info('Sending login command...');
        if (!(await safeChat('/login govinda', true, true))) {
            throw new Error('Failed to send login command');
        }
        
        await delay(3000);
        
        logger.info('Sending 8b8t command...');
        if (!(await safeChat('/8b8t', true, true))) {
            throw new Error('Failed to send 8b8t command');
        }
        
        await delay(2000);
        
        state.isLoggedIn = true;
        state.loginInProgress = false;
        state.loginAttempts = 0;
        
        logger.info('Login sequence completed successfully');
        
        await delay(1000);
        await safeChat("🤖 Bot online - Enhanced kit system ready!");
        
        // Start additional services
        await delay(2000);
        await startSpammer();
        
    } catch (error) {
        logger.error(`Login sequence failed: ${error.message}`);
        state.loginInProgress = false;
        
        if (state.loginAttempts < CONFIG.minecraft.loginMaxRetries) {
            logger.info(`Retrying login sequence in 5 seconds...`);
            setTimeout(performLoginSequence, 5000);
        } else {
            logger.error('Max login attempts reached');
            state.loginAttempts = 0;
        }
    }
}

async function logKitDelivery(username, position, dimension) {
    // Convert to whole numbers (integers)
    const coords = {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z)
    };
    
    // Simple Discord message format
    const message = `{${coords.x}, ${coords.y}, ${coords.z}} in ${dimension} by ${username}`;

    await sendToDiscord(process.env.COORDS_CHANNEL_ID, message, false);
    state.stats.kitsDelivered++;
    state.emit('kitDelivered', { username, position: coords, dimension });
}

async function startKitDelivery(username) {
    state.kitInProgress = true;
    state.currentKitAsker = username;
    state.initialPosition = null;
    state.positionWatcher = null;

    logger.info(`Starting kit delivery for ${username}`);
    
    if (!(await safeChat('/home kit', true))) {
        finishKit(username, false);
        return;
    }
    
    setTimeout(async () => {
        try {
            // Store initial position before TPA
            if (mcBot && mcBot.entity) {
                state.initialPosition = {
                    x: mcBot.entity.position.x,
                    y: mcBot.entity.position.y,
                    z: mcBot.entity.position.z
                };
                
                // Start watching for position changes
                startPositionWatcher(username);
            }
            
            await safeChat(`/tpa ${username}`, true);
            await safeChat(`/msg ${username} &6&l📦 Your kit is ready! Please accept the TPA (&9&l/tpayes ${CONFIG.minecraft.username}) &6within 25 seconds.`, true);
            
            // Set timeout for TPA acceptance
            state.tpaTimeout = setTimeout(() => {
                if (state.kitInProgress && state.currentKitAsker === username) {
                    logger.info(`TPA timeout for ${username}`);
                    safeChat(`/msg ${username} &4&l⏰ Timeout: You did not accept the TPA within 25 seconds.`);
                    finishKit(username, false);
                }
            }, CONFIG.kit.teleportTimeout);
            
        } catch (error) {
            logger.error(`Error during kit delivery: ${error.message}`);
            finishKit(username, false);
        }
    }, CONFIG.kit.deliveryDelay);
}

function startPositionWatcher(username) {
    if (!mcBot || !mcBot.entity || !state.initialPosition) return;
    
    const checkInterval = 500; // Check every 500ms
    let lastPosition = { ...state.initialPosition };
    let hasLogged = false; // Flag to prevent multiple logging
    
    state.positionWatcher = setInterval(async () => {
        if (!mcBot || !mcBot.entity || !state.kitInProgress || state.currentKitAsker !== username || hasLogged) {
            clearInterval(state.positionWatcher);
            state.positionWatcher = null;
            return;
        }
        
        const currentPos = mcBot.entity.position;
        const distance = Math.sqrt(
            Math.pow(currentPos.x - lastPosition.x, 2) +
            Math.pow(currentPos.y - lastPosition.y, 2) +
            Math.pow(currentPos.z - lastPosition.z, 2)
        );
        
        // If bot moved significantly (teleported), log coordinates
        if (distance > 5) { // Threshold to detect teleportation
            hasLogged = true; // Set flag to prevent multiple executions
            logger.info(`Position change detected for ${username}, logging coordinates`);
            
            // Clear the position watcher immediately
            clearInterval(state.positionWatcher);
            state.positionWatcher = null;
            
            // Clear the TPA timeout since teleport was successful
            if (state.tpaTimeout) {
                clearTimeout(state.tpaTimeout);
                state.tpaTimeout = null;
            }
            
            const dimension = mcBot.game.dimension;
            await logKitDelivery(username, currentPos, dimension);
            await safeChat(`/msg ${username} &2&l✅ Kit delivered! Enjoy your items.`);
            await safeChat('/kill');
            
            finishKit(username, false);
            return;
        }
        
        lastPosition = { ...currentPos };
    }, checkInterval);
}

// Handle spawn distance error messages
function handleSpawnDistanceError(username) {
    logger.info(`Spawn distance error for ${username}, retrying kit delivery`);
    safeChat('/kill');
    
    // Reset state and restart kit delivery for the same user
    setTimeout(() => {
        if (state.currentKitAsker === username) {
            startKitDelivery(username);
        }
    }, 2000);
}

// This function should be called when receiving chat messages
function handleChatMessage(message) {
    const spawnDistancePattern = /You must be 15000 blocks from spawn in order to use \/(?:home|tpa)/i;
    
    if (spawnDistancePattern.test(message) && state.kitInProgress && state.currentKitAsker) {
        handleSpawnDistanceError(state.currentKitAsker);
    }
}

async function finishKit(username, shouldLog = false) {
    try {
        // Clear position watcher
        if (state.positionWatcher) {
            clearInterval(state.positionWatcher);
            state.positionWatcher = null;
        }
        
        if (shouldLog && mcBot && mcBot.entity) {
            const pos = mcBot.entity.position;
            const dimension = mcBot.game.dimension;
            await logKitDelivery(username, pos, dimension);
        }
        
        if (shouldLog) {
            await safeChat('/kill');
        }
        
        state.cooldowns.set(username, Date.now());
        logger.info(`Kit delivery completed for ${username}`);
    } catch (error) {
        logger.error(`Error finishing kit: ${error.message}`);
    } finally {
        state.kitInProgress = false;
        state.currentKitAsker = null;
        state.initialPosition = null;
        
        if (state.positionWatcher) {
            clearInterval(state.positionWatcher);
            state.positionWatcher = null;
        }
        
        if (state.tpaTimeout) {
            clearTimeout(state.tpaTimeout);
            state.tpaTimeout = null;
        }

        if (state.kitQueue.length > 0) {
            const nextUser = state.kitQueue.shift();
            await delay(2000);
            startKitDelivery(nextUser);
        }
    }
}

function handleKitRequest(username) {
    const cleanName = username.toLowerCase();
    
    if (blacklistedUsers.has(cleanName)) {
        safeChat(`/msg ${username} &4&l❌ You are currently banned from using $kit. Contact &50xPwnd &4<o appeal.`);
        return;
    }
    if (state.devModeEnabled && !state.isVip(username)) {
        safeChat(`/msg ${username} &1&l🔧 Kit system is currently in maintenance mode. Only VIP users can access kits right now.`);
        return;
    }

    const now = Date.now();
    const lastUsed = state.cooldowns.get(username);
    const isVip = state.isVip(username);
    const cooldownTime = isVip ? CONFIG.kit.vipCooldownTime : CONFIG.kit.cooldownTime;

    if (lastUsed && now - lastUsed < cooldownTime) {
        const timeLeft = Math.ceil((cooldownTime - (now - lastUsed)) / 1000);
        const vipText = isVip ? ' (VIP)' : '';
        safeChat(`/msg ${username} &5&l⏰ Cooldown${vipText}: ${timeLeft}s remaining.`);
        return;
    }

    if (state.kitInProgress) {
        if (state.currentKitAsker === username) {
            safeChat(`/msg ${username} &e&l📦 Your kit is already being prepared.`);
        } else if (!state.kitQueue.includes(username)) {
            if (state.kitQueue.length >= CONFIG.kit.maxQueueSize) {
                safeChat(`/msg ${username} &4&l❌ Queue is full. Please try again later.`);
                return;
            }
            state.kitQueue.push(username);
            safeChat(`/msg ${username} &2&l📋 Added to queue. Position: ${state.kitQueue.length}`);
        } else {
            safeChat(`/msg ${username} &e&l📋 You're already in the queue.`);
        }
        return;
    }

    startKitDelivery(username);
}

// Enhanced spammer system
async function loadSpamMessages() {
    try {
        const filePath = path.resolve(CONFIG.spammer.filePath);
        const content = await fs.readFile(filePath, 'utf8');
        return content.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && line.length <= CONFIG.spammer.maxMessageLength)
            .map(line => sanitizeMessage(line))
            .filter(line => line.length > 0);
    } catch (error) {
        logger.warn(`Could not load spam messages: ${error.message}`);
        return ['🤖 Enhanced kit bot is online!', '📦 Type $kit for free items!', '🎮 Join our Discord for updates!'];
    }
}

async function startSpammer() {
    if (state.spammerStarted || !state.isConnected || !state.isLoggedIn) return;

    const spamLines = await loadSpamMessages();
    if (spamLines.length === 0) {
        logger.warn("No valid spam messages found");
        return;
    }

    state.spammerStarted = true;
    let index = 0;
    
    const sendSpamMessage = async () => {
        if (!state.isConnected || !state.isLoggedIn) {
            logger.warn("Bot not ready for spamming, stopping...");
            state.stopSpammer();
            return;
        }
        
        const message = spamLines[index];
        if (await safeChat(message)) {
            index = (index + 1) % spamLines.length;
        }
        
        // Add random delay variation
        const randomDelay = Math.floor(Math.random() * CONFIG.spammer.randomDelay);
        setTimeout(sendSpamMessage, CONFIG.spammer.interval + randomDelay);
    };
    
    // Start with initial delay
    setTimeout(sendSpamMessage, CONFIG.spammer.interval);
    logger.info(`Spammer started with ${spamLines.length} messages`);
}

function handleDevCommand(username) {
    // Only allow 0xPwnd to use this command
    if (username.toLowerCase() !== '0xpwnd') {
        safeChat(`/msg ${username} &4&l❌ You don't have permission to use this command.`);
        return;
    }

    const newState = state.toggleDevMode();

    if (newState) {
        // Dev mode enabled - kit system disabled for non-VIPs
        safeChat(`/msg ${username} &1&l🔧 Dev mode ENABLED. Kit system is now restricted to VIP users only.`);

        // Clear the current queue of non-VIP users
        const originalQueueLength = state.kitQueue.length;
        state.kitQueue = state.kitQueue.filter(user => state.isVip(user));
        const removedUsers = originalQueueLength - state.kitQueue.length;

        if (removedUsers > 0) {
            safeChat(`🔧 Maintenance mode enabled. ${removedUsers} non-VIP users removed from queue.`);
        }

        // If current kit delivery is for a non-VIP user, cancel it
        if (state.currentKitAsker && !state.isVip(state.currentKitAsker)) {
            safeChat(`/msg ${state.currentKitAsker} &c&l🔧 Kit delivery cancelled due to maintenance mode.`);
            finishKit(state.currentKitAsker, false);
        }

        // Send notification to Discord
        sendToDiscord(process.env.DISCORD_CHANNEL_ID, 
            `🔧 **Dev Mode Enabled** by ${username}\nKit system restricted to VIP users only.`, 
            false);

    } else {
        // Dev mode disabled - kit system available for everyone
        safeChat(`/msg ${username} &1&l✅ Dev mode DISABLED. Kit system is now available for all users.`);
        safeChat(`📦 Kit system is back online! Type $kit to get your free items.`);

        // Send notification to Discord
        sendToDiscord(process.env.DISCORD_CHANNEL_ID, 
            `✅ **Dev Mode Disabled** by ${username}\nKit system is now available for all users.`, 
            false);
    }
}

// Enhanced bot initialization
function setupBotEvents() {
    mcBot.on('login', () => {
        logger.info(`Logged into Minecraft as ${mcBot.username || 'Unknown'}`);
        state.reconnectAttempts = 0;
        state.isConnected = true;
    });

    mcBot.on('spawn', async () => {
        logger.info('Bot spawned');
        
        if (state.loginTimeout) {
            clearTimeout(state.loginTimeout);
        }
        
        state.loginTimeout = setTimeout(() => {
            if (!state.isLoggedIn && !state.loginInProgress) {
                performLoginSequence();
            }
        }, 2000);
    });
    
    mcBot.on('health', (health) => {
        state.botHealth = health;
        if (health <= CONFIG.minecraft.healthThreshold) {
            logger.warn(`Bot health critical: ${health}/20`);
            // Auto-heal if possible
            const foodItems = mcBot.inventory.items().filter(item => 
                ['bread', 'apple', 'cooked_beef', 'cooked_pork'].includes(item.name)
            );
            if (foodItems.length > 0) {
                mcBot.equip(foodItems[0], 'hand').then(() => {
                    mcBot.activateItem();
                }).catch(err => logger.error(`Failed to eat: ${err.message}`));
            }
        }
    });
    
    mcBot.on('move', () => {
        if (mcBot.entity) {
            state.botPosition = mcBot.entity.position;
        }
    });
    
    mcBot.on('error', (err) => {
        logger.error(`Bot error: ${err.message}`);
        state.reset();
    });
    
    mcBot.on('kicked', (reason) => {
        const reasonText = typeof reason === 'string' ? reason : JSON.stringify(reason);
        logger.warn(`Bot kicked: ${reasonText}`);
        state.reset();
        
        if (reasonText.includes('too fast') || reasonText.includes('login')) {
            CONFIG.minecraft.reconnectDelay = Math.min(CONFIG.minecraft.reconnectDelay * 1.5, 120000);
            logger.info(`Increased reconnect delay to ${CONFIG.minecraft.reconnectDelay}ms due to rate limiting`);
        }
        
        scheduleReconnect();
    });
    
    mcBot.on('end', () => {
        logger.info('Bot connection ended');
        state.reset();
        scheduleReconnect();
    });

    // Enhanced chat handler
    mcBot.on('chat', async (username, message) => {
        if (username === mcBot.username) return;
        
        state.stats.messagesReceived++;
        const spawnDistancePattern = /You must be 15000 blocks from spawn in order to use \/(?:home|tpa)/i;
        if (spawnDistancePattern.test(message) && state.kitInProgress && state.currentKitAsker) {
            handleSpawnDistanceError(state.currentKitAsker);
            return;
        }
        // Login detection  
        if (message.includes('You have successfully logged in') || 
            message.includes('Successfully logged in') ||
            message.includes('Login successful')) {
            logger.info('Detected successful login message');
            if (!state.isLoggedIn) {
                state.isLoggedIn = true;
                state.loginInProgress = false;
                state.loginAttempts = 0;
                logger.info('Login status updated to true');
            }
        }
    
        // Forward to Discord with enhanced formatting
        try {
            const cleanMessage = sanitizeMessage(message);
            const timestamp = Math.floor(Date.now() / 1000);
            await sendToDiscord(
                process.env.DISCORD_CHANNEL_ID, 
                `**[MC]** \`${username}\`: ${cleanMessage} <t:${timestamp}:t>`
            );
        } catch (error) {
            logger.error(`Error forwarding message to Discord: ${error.message}`);
        }

        // Enhanced command handling
        const cmd = message.trim().toLowerCase();
        const args = message.trim().split(' ');
        const command = args[0].toLowerCase();

        if (cmd === '$kit') {
            handleKitRequest(username);
        } else if (cmd === '$queue') {
            if (state.kitQueue.length > 0) {
                safeChat(`/msg ${username} &6&l📋 Queue (${state.kitQueue.length}): ${state.kitQueue.join(', ')}`);
            } else {
                safeChat(`/msg ${username} &c&l📋 Queue is empty`);
            }
        } else if (cmd === '$dev') {
            handleDevCommand(username);
        } else if (cmd === '$health') {
            if (state.isVip(username)) {
                const health = state.botHealth || 20;
                const healthBar = '█'.repeat(Math.floor(health / 2)) + '░'.repeat(10 - Math.floor(health / 2));
                safeChat(`/msg ${username} ❤️ Bot health: ${health}/20 ${healthBar}`);
            } else {
                safeChat(`/msg ${username} &4&l❌ VIP access required`);
            }
        } else if (cmd === '$giveaway') {
            if (args.length === 1) {
                const result = giveawayManager.joinGiveaway(username);
                if (result.success) {
                    safeChat(`/msg ${username} ✅ ${result.message}`);
                } else {
                    safeChat(`/msg ${username} ❌ ${result.message}`);
                }
            } else if (args[1] === 'info') {
                const info = giveawayManager.getGiveawayInfo();
                if (info.success) {
                    safeChat(`/msg ${username} 🎉 Active Giveaway: ${info.giveaway.title}`);
                    await delay(500);
                    safeChat(`/msg ${username} 🏆 Prize: ${info.giveaway.prize}`);
                    await delay(500);
                    safeChat(`/msg ${username} ⏰ Time left: ${info.timeLeft}`);
                    await delay(500);
                    safeChat(`/msg ${username} 👥 Participants: ${info.participantCount}`);
                } else {
                    safeChat(`/msg ${username} ❌ ${info.message}`);
                }
            }
        } else if (cmd === '$ban') {
            if (args.length < 2) {
                safeChat(`/msg ${username} &4&l❌ Usage: $ban <player> [reason]`);
                return;
            }
            const target = args[1];
            const reason = args.slice(2).join(' ') || 'No reason specified';
            safeChat(`[Server] ${target} has been banned by ${username} for: ${reason}`);
        } else if (cmd === '$bestping') {
            if (!mcBot.players || Object.keys(mcBot.players).length === 0) {
                safeChat(`/msg ${username} &4&l❌ No players online`);
                return;
            }
            const players = Object.values(mcBot.players).filter(p => p.ping !== undefined && p.username !== mcBot.username);
            if (players.length === 0) {
                safeChat(`/msg ${username} &4&l❌ No valid ping data available`);
                return;
            }
            const bestPingPlayer = players.reduce((min, p) => p.ping < min.ping ? p : min, players[0]);
            safeChat(`/msg ${username} &6&l🏆 Player with best ping: ${bestPingPlayer.username} (${bestPingPlayer.ping}ms)`);
        } else if (cmd === '$coords') {
            const fakeX = Math.floor(Math.random() * 1000000) - 500000;
            const fakeY = Math.floor(Math.random() * 256);
            const fakeZ = Math.floor(Math.random() * 1000000) - 500000;
            safeChat(`/msg ${username} &6&l📍 My coordinates: ${fakeX}, ${fakeY}, ${fakeZ}`);
        } else if (cmd === '$ping') {
            let target = username; // Default to the command issuer
            if (args.length > 1) {
                target = args[1];
                // Case-insensitive lookup
                const playerKeys = Object.keys(mcBot.players).map(k => k.toLowerCase());
                const targetKey = playerKeys.find(k => k === target.toLowerCase());
                if (!targetKey) {
                    safeChat(`/msg ${username} &4&l❌ Player ${target} not found`);
                    return;
                }
                target = Object.keys(mcBot.players).find(k => k.toLowerCase() === targetKey);
            }
            const ping = mcBot.players[target]?.ping || 0;
            safeChat(`/msg ${username} &6&l📡 ${target}'s ping: ${ping}ms`);
        } else if (cmd === '$seed') {
            safeChat(` /msg ${username} &6&l🌱 Server seed: -9079062558503125353`);
        } else if (cmd === '$tps') {
            const tps = mcBot.getServerTickRate ? mcBot.getServerTickRate() : 20;
            const lagStatus = tps >= 18 ? '&2&lGood' : tps >= 10 ? '&6&lModerate' : '&4&lLagging';
            safeChat(`/msg ${username} &6&l📊 Server TPS: ${tps.toFixed(1)} (${lagStatus}&6&l)`);
        } else if (cmd === '$worstping') {
            if (!mcBot.players || Object.keys(mcBot.players).length === 0) {
                safeChat(`/msg ${username} &4&l❌ No players online`);
                return;
            }
            const players = Object.values(mcBot.players).filter(p => p.ping !== undefined && p.username !== mcBot.username);
            if (players.length === 0) {
                safeChat(`/msg ${username} &4&l❌ No valid ping data available`);
                return;
            }
            const worstPingPlayer = players.reduce((max, p) => p.ping > max.ping ? p : max, players[0]);
            safeChat(`/msg ${username} &6&l🐢 Player with worst ping: ${worstPingPlayer.username} (${worstPingPlayer.ping}ms)`);
        }
    });
}

function scheduleReconnect() {
    if (state.reconnectAttempts >= CONFIG.minecraft.maxReconnectAttempts) {
        logger.error('Max reconnection attempts reached');
        return;
    }
    
    state.reconnectAttempts++;
    const delay = CONFIG.minecraft.reconnectDelay * Math.min(state.reconnectAttempts, 3);
    
    logger.info(`Reconnecting in ${delay}ms (attempt ${state.reconnectAttempts})`);
    setTimeout(initBot, delay);
}

function initBot() {
    state.reset();
    
    try {
        mcBot = mineflayer.createBot({
            host: CONFIG.minecraft.host,
            port: CONFIG.minecraft.port,
            username: CONFIG.minecraft.username,
            version: CONFIG.minecraft.version,
            auth: 'offline'
        });

        setupBotEvents();
    } catch (error) {
        logger.error(`Failed to create bot: ${error.message}`);
        scheduleReconnect();
    }
}

// Enhanced inventory management
async function dropInventory() {
    try {
        if (!mcBot || !mcBot.inventory) {
            logger.warn('Bot inventory not available');
            return false;$
        }
        
        const items = mcBot.inventory.items();
        logger.info(`Dropping ${items.length} items`);
        
        for (const item of items) {
            await mcBot.tossStack(item);
            await delay(100);
        }
        return true;
    } catch (err) {
        logger.error(`Error dropping items: ${err.message}`);
        return false;
    }
}

// Enhanced Discord event handlers
discordClient.on('ready', () => {
    logger.info(`Discord bot logged in as ${discordClient.user.tag}`);
});

discordClient.on('messageCreate', async (msg) => {
    if (msg.author.bot || msg.channel.id !== process.env.DISCORD_CHANNEL_ID) return;

    const content = msg.content.trim();

    if (content.startsWith('$')) {
        const args = content.slice(1).split(' ');
        const command = args.shift().toLowerCase();

        try {
            switch (command) {
                case 'drop':
                    const dropped = await dropInventory();
                    await msg.reply(dropped ? '✅ Dropping all inventory items...' : '❌ Failed to drop items');
                    break;
                    
                case 'tp':
                    if (await safeChat('/tpa 0xPwnd', true)) {
                        await msg.reply('📞 Sending teleport request...');
                    } else {
                        await msg.reply('❌ Bot not ready');
                    }
                    break;
                    
                case 'tph':
                    if (await safeChat('/tpahere 0xPwnd', true)) {
                        await msg.reply('📞 Sending teleport here request...');
                    } else {
                        await msg.reply('❌ Bot not ready');
                    }
                    break;
                    
                case 'login':
                    if (state.isConnected) {
                        await msg.reply('🔄 Retrying login sequence...');
                        performLoginSequence();
                    } else {
                        await msg.reply('❌ Bot not connected');
                    }
                    break;
                    
                case 'restart':
                    await msg.reply('🔄 Restarting bot...');
                    state.reset();
                    setTimeout(initBot, 2000);
                    break;
                    
                case 'stats':
                    const uptime = formatUptime(state.getUptime());
                    const statsEmbed = createEmbed('📊 Bot Statistics', 
                        `**Uptime:** ${uptime}\n` +
                        `**Kits Delivered:** ${state.stats.kitsDelivered}\n` +
                        `**Messages Received:** ${state.stats.messagesReceived}\n` +
                        `**Reconnects:** ${state.stats.reconnects}\n` +
                        `**Queue Length:** ${state.kitQueue.length}\n` +
                        `**Active Cooldowns:** ${state.cooldowns.size}`,
                        CONFIG.discord.embedColor.info
                    );
                    await msg.reply({ embeds: [statsEmbed] });
                    break;
                    
                case 'status':
                    const healthBar = '█'.repeat(Math.floor(state.botHealth / 2)) + '░'.repeat(10 - Math.floor(state.botHealth / 2));
                    const statusFields = [
                        { name: '🎉 Giveaway', value: giveawayManager.hasActiveGiveaway() ? 
                            `✅ Active (${giveawayManager.getGiveawayInfo().participantCount} participants)` : 
                            '❌ Inactive', inline: true },
                        { name: '🔗 Connection', value: state.isConnected ? '✅ Connected' : '❌ Disconnected', inline: true },
                        { name: '🔐 Login Status', value: state.isLoggedIn ? '✅ Logged In' : '❌ Not Logged In', inline: true },
                        { name: '⚙️ Login Progress', value: state.loginInProgress ? '🔄 In Progress' : '✅ Complete', inline: true },
                        { name: '❤️ Health', value: `${healthBar} ${state.botHealth}/20`, inline: false },
                        { name: '📍 Position', value: `\`${Math.floor(state.botPosition.x)}, ${Math.floor(state.botPosition.y)}, ${Math.floor(state.botPosition.z)}\``, inline: true },
                        { name: '🌍 Dimension', value: state.dimension || 'Unknown', inline: true },
                        { name: '📦 Kit System', value: state.kitInProgress ? '🔄 Processing' : '✅ Ready', inline: true },
                        { name: '📋 Queue', value: `${state.kitQueue.length} players`, inline: true },
                        { name: '🔄 Reconnect Attempts', value: `${state.reconnectAttempts}/${CONFIG.minecraft.maxReconnectAttempts}`, inline: true },
                        { name: '💬 Spammer', value: state.spammerStarted ? '✅ Active' : '❌ Inactive', inline: true }
                    ];
                    
                    const statusEmbed = createEmbed('🤖 Enhanced Bot Status', 
                        `**${mcBot?.username || 'Unknown'}** status overview`,
                        state.isConnected && state.isLoggedIn ? CONFIG.discord.embedColor.success : CONFIG.discord.embedColor.warning,
                        statusFields
                    );
                    await msg.reply({ embeds: [statusEmbed] });
                    break;
                    
                case 'queue':
                    if (state.kitQueue.length === 0) {
                        await msg.reply('📝 Kit queue is empty');
                    } else {
                        const queueList = state.kitQueue.map((user, index) => `${index + 1}. ${user}`).join('\n');
                        const queueEmbed = createEmbed('📋 Kit Queue', 
                            `**${state.kitQueue.length} players in queue:**\n\`\`\`${queueList}\`\`\``,
                            CONFIG.discord.embedColor.info
                        );
                        await msg.reply({ embeds: [queueEmbed] });
                    }
                    break;
                    
                case 'clearqueue':
                    const queueSize = state.kitQueue.length;
                    state.kitQueue = [];
                    await msg.reply(`✅ Cleared ${queueSize} players from queue`);
                    break;
                    
                case 'vip':
                    if (args.length === 0) {
                        const vipList = Array.from(state.vipUsers).join(', ') || 'None';
                        await msg.reply(`👑 VIP Users: ${vipList}`);
                    } else {
                        const action = args[0].toLowerCase();
                        const username = args[1];
                        
                        if (!username && action !== 'list') {
                            await msg.reply('❌ Usage: `$vip <add/remove/list> [username]`');
                            break;
                        }
                        
                        switch (action) {
                            case 'add':
                                state.addVipUser(username);
                                await msg.reply(`✅ Added ${username} to VIP list`);
                                break;
                            case 'remove':
                                state.removeVipUser(username);
                                await msg.reply(`✅ Removed ${username} from VIP list`);
                                break;
                            case 'list':
                                const vipList = Array.from(state.vipUsers).join(', ') || 'None';
                                await msg.reply(`👑 VIP Users: ${vipList}`);
                                break;
                            default:
                                await msg.reply('❌ Usage: `$vip <add/remove/list> [username]`');
                        }
                    }
                    break;
                    
                case 'blacklist':
                    if (args.length === 0) {
                        const blacklist = Array.from(blacklistedUsers).join(', ') || 'None';
                        await msg.reply(`🚫 Blacklisted Users: ${blacklist}`);
                    } else {
                        const action = args[0].toLowerCase();
                        const username = args[1];
                        
                        if (!username && action !== 'list') {
                            await msg.reply('❌ Usage: `$blacklist <add/remove/list> [username]`');
                            break;
                        }
                        
                        switch (action) {
                            case 'add':
                                blacklistedUsers.add(username.toLowerCase());
                                await msg.reply(`✅ Added ${username} to blacklist`);
                                break;
                            case 'remove':
                                blacklistedUsers.delete(username.toLowerCase());
                                await msg.reply(`✅ Removed ${username} from blacklist`);
                                break;
                            case 'list':
                                const blacklist = Array.from(blacklistedUsers).join(', ') || 'None';
                                await msg.reply(`🚫 Blacklisted Users: ${blacklist}`);
                                break;
                            default:
                                await msg.reply('❌ Usage: `$blacklist <add/remove/list> [username]`');
                        }
                    }
                    break;
                    
                case 'cooldown':
                    if (args.length === 0) {
                        if (state.cooldowns.size === 0) {
                            await msg.reply('⏰ No active cooldowns');
                        } else {
                            const now = Date.now();
                            const cooldownList = Array.from(state.cooldowns.entries())
                                .map(([user, time]) => {
                                    const remaining = Math.max(0, CONFIG.kit.cooldownTime - (now - time));
                                    return `${user}: ${Math.ceil(remaining / 1000)}s`;
                                })
                                .filter(entry => !entry.includes('0s'))
                                .join('\n');
                            
                            if (cooldownList) {
                                await msg.reply(`⏰ Active Cooldowns:\n\`\`\`${cooldownList}\`\`\``);
                            } else {
                                await msg.reply('⏰ No active cooldowns');
                            }
                        }
                    } else {
                        const username = args[0];
                        state.cooldowns.delete(username);
                        await msg.reply(`✅ Cleared cooldown for ${username}`);
                    }
                    break;
                    
                case 'say':
                    if (args.length === 0) {
                        await msg.reply('❌ Usage: `$say <message>`');
                    } else {
                        const message = args.join(' ');
                        if (await safeChat(message)) {
                            await msg.reply('✅ Message sent');
                        } else {
                            await msg.reply('❌ Failed to send message');
                        }
                    }
                    break;
                    
                case 'whisper':
                case 'msg':
                    if (args.length < 2) {
                        await msg.reply('❌ Usage: `$msg <player> <message>`');
                    } else {
                        const player = args[0];
                        const message = args.slice(1).join(' ');
                        if (await safeChat(`/msg ${player} ${message}`)) {
                            await msg.reply(`✅ Whisper sent to ${player}`);
                        } else {
                            await msg.reply('❌ Failed to send whisper');
                        }
                    }
                    break;
                    
                case 'inventory':
                case 'inv':
                    if (!mcBot || !mcBot.inventory) {
                        await msg.reply('❌ Bot inventory not available');
                        break;
                    }
                    
                    const items = mcBot.inventory.items();
                    if (items.length === 0) {
                        await msg.reply('📦 Inventory is empty');
                    } else {
                        const itemCounts = {};
                        items.forEach(item => {
                            const name = item.displayName || item.name;
                            itemCounts[name] = (itemCounts[name] || 0) + item.count;
                        });
                        
                        const itemList = Object.entries(itemCounts)
                            .map(([name, count]) => `${name}: ${count}`)
                            .join('\n');
                        
                        const invEmbed = createEmbed('📦 Bot Inventory', 
                            `**${items.length} items total:**\n\`\`\`${itemList}\`\`\``,
                            CONFIG.discord.embedColor.info
                        );
                        await msg.reply({ embeds: [invEmbed] });
                    }
                    break;
                    
                case 'config':
                    const configEmbed = createEmbed('⚙️ Bot Configuration', 
                        `**Minecraft:**\n` +
                        `• Host: ${CONFIG.minecraft.host}:${CONFIG.minecraft.port}\n` +
                        `• Username: ${CONFIG.minecraft.username}\n` +
                        `• Version: ${CONFIG.minecraft.version}\n\n` +
                        `**Kit System:**\n` +
                        `• Normal Cooldown: ${CONFIG.kit.cooldownTime / 1000}s\n` +
                        `• VIP Cooldown: ${CONFIG.kit.vipCooldownTime / 1000}s\n` +
                        `• Max Queue: ${CONFIG.kit.maxQueueSize}\n` +
                        `• TPA Timeout: ${CONFIG.kit.teleportTimeout / 1000}s\n\n` +
                        `**Spammer:**\n` +
                        `• Interval: ${CONFIG.spammer.interval / 1000}s\n` +
                        `• Random Delay: ${CONFIG.spammer.randomDelay / 1000}s\n\n` +
                        CONFIG.discord.embedColor.info
                    );
                    await msg.reply({ embeds: [configEmbed] });
                    break;
                    
                case 'help':
                    const helpFields = [
                        { name: '🎮 Basic Commands', value: '`$drop` - Drop all items\n`$tp` - Request teleport\n`$tph` - Request teleport here\n`$say <message>` - Send chat message\n`$msg <player> <message>` - Send whisper', inline: false },
                        { name: '🔧 System Commands', value: '`$login` - Retry login sequence\n`$restart` - Restart bot\n`$status` - Show detailed status\n`$stats` - Show statistics\n`$config` - Show configuration', inline: false },
                        { name: '📦 Kit Management', value: '`$queue` - Show kit queue\n`$clearqueue` - Clear kit queue\n`$cooldown [player]` - Show/clear cooldowns', inline: false },
                        { name: '👥 User Management', value: '`$vip <add/remove/list> [user]` - Manage VIP users\n`$blacklist <add/remove/list> [user]` - Manage blacklist', inline: false },
                        { name: '📋 Information', value: '`$inventory` - Show bot inventory\n`$help` - Show this help', inline: false },
                        { name: '🎉 Giveaway System', value: '`$giveaway create "Title" "Prize" <minutes>` - Create giveaway\n`$giveaway end` - End current giveaway\n`$giveaway cancel` - Cancel giveaway\n`$giveaway participants` - Show participants\n`$giveaway` - Show giveaway status', inline: false }
                    ];
                    
                    const helpEmbed = createEmbed('🔧 Enhanced Bot Commands',
                        'Available commands for bot management',
                        CONFIG.discord.embedColor.info,
                        helpFields
                    );
                    await msg.reply({ embeds: [helpEmbed] });
                    break;

                case 'giveaway':
                    if (args.length === 0) {
                        // Show giveaway status
                        if (giveawayManager.hasActiveGiveaway()) {
                            const info = giveawayManager.getGiveawayInfo();
                            if (info.success) {
                                const statusEmbed = createEmbed(
                                    '🎉 Active Giveaway',
                                    `**Title:** ${info.giveaway.title}\n` +
                                    `**Prize:** ${info.giveaway.prize}\n` +
                                    `**Time Left:** ${info.timeLeft}\n` +
                                    `**Participants:** ${info.participantCount}`,
                                    CONFIG.discord.embedColor.info,
                                    [
                                        { name: '📝 How to Join', value: 'Type `$giveaway` in Minecraft chat', inline: true },
                                        { name: '⏰ Ends at', value: `<t:${Math.floor(info.giveaway.endTime / 1000)}:F>`, inline: true }
                                    ]
                                );
                                await msg.reply({ embeds: [statusEmbed] });
                            }
                        } else {
                            await msg.reply('❌ No active giveaway');
                        }
                    } else {
                        const subCommand = args[0].toLowerCase();

                        switch (subCommand) {
                            case 'create':
                                if (args.length < 4) {
                                    await msg.reply('❌ Usage: `$giveaway create "Title" "Prize" <minutes>`\nExample: `$giveaway create "Diamond Giveaway" "64 Diamonds" 10`');
                                    break;
                                }

                                // Parse arguments - handle quoted strings
                                const fullArgs = content.slice(content.indexOf('create') + 6).trim();
                                const matches = fullArgs.match(/"([^"]+)"\s+"([^"]+)"\s+(\d+)/);

                                if (!matches) {
                                    await msg.reply('❌ Invalid format. Use: `$giveaway create "Title" "Prize" <minutes>`');
                                    break;
                                }

                                const title = matches[1];
                                const prize = matches[2];
                                const duration = parseInt(matches[3]);

                                if (duration < 1 || duration > 1440) { // Max 24 hours
                                    await msg.reply('❌ Duration must be between 1 and 1440 minutes (24 hours)');
                                    break;
                                }

                                const result = giveawayManager.createGiveaway(title, prize, duration, msg.author.username);

                                if (result.success) {
                                    await msg.reply(`✅ Giveaway created successfully!\n**Title:** ${title}\n**Prize:** ${prize}\n**Duration:** ${duration} minutes`);
                                } else {
                                    await msg.reply(`❌ ${result.message}`);
                                }
                                break;

                            case 'end':
                                const endResult = giveawayManager.endGiveaway(false);
                                if (endResult.success) {
                                    const { winner, participantCount } = endResult.result;
                                    if (winner) {
                                        await msg.reply(`✅ Giveaway ended! Winner: **${winner}** (${participantCount} participants)`);
                                    } else {
                                        await msg.reply(`✅ Giveaway ended with no participants`);
                                    }
                                } else {
                                    await msg.reply(`❌ ${endResult.message}`);
                                }
                                break;

                            case 'cancel':
                                const cancelResult = giveawayManager.cancelGiveaway();
                                if (cancelResult.success) {
                                    await msg.reply(`✅ Giveaway cancelled successfully\n**Prize:** ${cancelResult.giveaway.prize}\n**Participants:** ${cancelResult.giveaway.participants.size}`);
                                } else {
                                    await msg.reply(`❌ ${cancelResult.message}`);
                                }
                                break;

                            case 'participants':
                                if (giveawayManager.hasActiveGiveaway()) {
                                    const info = giveawayManager.getGiveawayInfo();
                                    if (info.success) {
                                        const participants = Array.from(info.giveaway.participants);
                                        if (participants.length > 0) {
                                            const participantList = participants.join(', ');
                                            const participantEmbed = createEmbed(
                                                '👥 Giveaway Participants',
                                                `**Total:** ${participants.length}\n**Participants:** ${participantList}`,
                                                CONFIG.discord.embedColor.info
                                            );
                                            await msg.reply({ embeds: [participantEmbed] });
                                        } else {
                                            await msg.reply('📝 No participants yet');
                                        }
                                    }
                                } else {
                                    await msg.reply('❌ No active giveaway');
                                }
                                break;

                            default:
                                await msg.reply('❌ Unknown giveaway command. Use: `create`, `end`, `cancel`, or `participants`');
                                break;
                        }
                    }
                    break;
                    
                default:
                    await msg.reply('❌ Unknown command. Use `$help` for available commands.');
                    break;
            }
        } catch (error) {
            logger.error(`Discord command error: ${error.message}`);
            await msg.reply('❌ An error occurred while executing the command.');
        }
    } else if (content && state.isConnected && state.isLoggedIn) {
        // Forward Discord messages to Minecraft
        if (await safeChat(content)) {
            await msg.react('✅');
        } else {
            await msg.react('❌');
        }
    }
});

// Enhanced error handling
process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception: ${error.message}`, error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled rejection: ${reason}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    logger.info('Shutting down gracefully...');
    state.reset();
    discordClient.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    state.reset();
    discordClient.destroy();
    process.exit(0);
});

// State event listeners for enhanced logging
state.on('kitDelivered', (data) => {
    logger.info(`Kit delivered to ${data.username} at ${data.position.x}, ${data.position.y}, ${data.position.z}`);
});

state.on('vipAdded', (username) => {
    logger.info(`Added VIP user: ${username}`);
});

state.on('vipRemoved', (username) => {
    logger.info(`Removed VIP user: ${username}`);
});

state.on('reset', () => {
    logger.info('Bot state reset');
});

// Configuration validation
function validateConfig() {
    const required = [
        'DISCORD_TOKEN',
        'DISCORD_CHANNEL_ID',
        'COORDS_CHANNEL_ID'
    ];
    
    for (const env of required) {
        if (!process.env[env]) {
            logger.error(`Missing required environment variable: ${env}`);
            process.exit(1);
        }
    }
    
    logger.info('Configuration validated successfully');
}

// Startup sequence
async function startup() {
    try {
        logger.info('Starting Enhanced Minecraft Bot...');
        validateConfig();
        
        // Initialize Discord client
        await discordClient.login(process.env.DISCORD_TOKEN);
        
        // Wait for Discord to be ready
        await new Promise(resolve => {
            if (discordClient.isReady()) {
                resolve();
            } else {
                discordClient.once('ready', resolve);
            }
        });
        
        logger.info('Discord client ready, initializing Minecraft bot...');
        initBot();
        
    } catch (error) {
        logger.error(`Startup failed: ${error.message}`);
        process.exit(1);
    }
}

// Start the bot
startup();