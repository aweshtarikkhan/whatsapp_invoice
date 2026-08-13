"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectToWhatsApp = connectToWhatsApp;
exports.getSocket = getSocket;
exports.getStatus = getStatus;
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const pino_1 = __importDefault(require("pino"));
const db_1 = require("./db");
const logger = (0, pino_1.default)({ level: 'silent' });
let sock = null;
let currentQR = null;
let connectionStatus = 'close';
async function connectToWhatsApp() {
    const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)('auth_info_baileys');
    const { version } = await (0, baileys_1.fetchLatestBaileysVersion)();
    sock = (0, baileys_1.default)({
        version,
        logger,
        printQRInTerminal: true,
        auth: state,
        browser: baileys_1.Browsers.macOS('Desktop'),
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
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== baileys_1.DisconnectReason.loggedOut;
            console.log('connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
            else {
                console.log('Logged out. Please delete auth_info_baileys folder and restart.');
                currentQR = null;
            }
        }
        else if (connection === 'open') {
            console.log('opened connection');
            connectionStatus = 'open';
            currentQR = null;
        }
        else if (connection === 'connecting') {
            connectionStatus = 'connecting';
        }
    });
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify')
            return;
        for (const msg of m.messages) {
            if (!msg.message)
                continue;
            const jid = msg.key.remoteJid;
            if (!jid || (0, baileys_1.isJidGroup)(jid) || (0, baileys_1.isJidStatusBroadcast)(jid) || (0, baileys_1.isJidNewsletter)(jid))
                continue;
            const fromMe = msg.key.fromMe;
            const phone = jid.split('@')[0];
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            const msgId = msg.key.id || '';
            if (text) {
                const direction = fromMe ? 'outgoing' : 'incoming';
                console.log(`[${direction}] ${phone}: ${text}`);
                const chatId = await (0, db_1.upsertChat)(phone, text);
                if (chatId) {
                    await (0, db_1.insertMessage)(chatId, phone, direction, text, msgId);
                }
            }
        }
    });
}
function getSocket() {
    return sock;
}
function getStatus() {
    return {
        status: connectionStatus,
        qr: currentQR
    };
}
