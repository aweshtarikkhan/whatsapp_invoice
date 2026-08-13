import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, isJidGroup, isJidStatusBroadcast, isJidNewsletter } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { upsertChat, insertMessage } from './db';

const logger = pino({ level: 'silent' });
let sock: ReturnType<typeof makeWASocket> | null = null;
let currentQR: string | null = null;
let connectionStatus: 'connecting' | 'open' | 'close' = 'close';

export async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: true,
        auth: state,
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
        }

        if (connection === 'close') {
            connectionStatus = 'close';
            const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('Logged out. Please delete auth_info_baileys folder and restart.');
                currentQR = null;
            }
        } else if (connection === 'open') {
            console.log('opened connection');
            connectionStatus = 'open';
            currentQR = null;
        } else if (connection === 'connecting') {
            connectionStatus = 'connecting';
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            if (!msg.message) continue;
            
            const jid = msg.key.remoteJid;
            if (!jid || isJidGroup(jid) || isJidStatusBroadcast(jid) || isJidNewsletter(jid)) continue;

            const fromMe = msg.key.fromMe;
            const phone = jid.split('@')[0];
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            const msgId = msg.key.id || '';

            if (text) {
                const direction = fromMe ? 'outgoing' : 'incoming';
                console.log(`[${direction}] ${phone}: ${text}`);

                const chatId = await upsertChat(phone, text);
                if (chatId) {
                    await insertMessage(chatId, phone, direction, text, msgId);
                }
            }
        }
    });
}

export function getSocket() {
    return sock;
}

export function getStatus() {
    return {
        status: connectionStatus,
        qr: currentQR
    };
}
