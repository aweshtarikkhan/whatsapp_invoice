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
exports.sendMessage = exports.logoutSession = exports.restoreSessions = exports.startWhatsAppSession = exports.getSessionStatus = exports.qrCodes = exports.activeSessions = void 0;
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const pino_1 = __importDefault(require("pino"));
const qrcode_1 = __importDefault(require("qrcode"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const supabase_1 = require("./supabase");
const logger = (0, pino_1.default)({ level: "silent" });
const sessionsDir = path_1.default.resolve(__dirname, "..", "sessions");
if (!fs_1.default.existsSync(sessionsDir)) {
    fs_1.default.mkdirSync(sessionsDir, { recursive: true });
}
// Memory store to hold active sockets and QR codes
exports.activeSessions = {};
exports.qrCodes = {}; // Base64 QR codes
const getSessionStatus = async (orgId) => {
    const { data } = await supabase_1.supabase.from("whatsapp_sessions").select("status").eq("org_id", orgId).single();
    return data?.status || "disconnected";
};
exports.getSessionStatus = getSessionStatus;
const startWhatsAppSession = async (orgId) => {
    console.log(`Starting WhatsApp session for org: ${orgId}`);
    const orgSessionDir = path_1.default.join(sessionsDir, orgId);
    const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(orgSessionDir);
    const { version, isLatest } = await (0, baileys_1.fetchLatestBaileysVersion)();
    const sock = (0, baileys_1.default)({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: (0, baileys_1.makeCacheableSignalKeyStore)(state.keys, logger),
        },
        generateHighQualityLinkPreview: true,
    });
    exports.activeSessions[orgId] = sock;
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log(`[${orgId}] New QR Code generated.`);
            exports.qrCodes[orgId] = await qrcode_1.default.toDataURL(qr);
            // Update DB to authenticating
            await supabase_1.supabase.from("whatsapp_sessions").upsert({ org_id: orgId, status: "authenticating" }, { onConflict: "org_id" });
        }
        if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== baileys_1.DisconnectReason.loggedOut;
            console.log(`[${orgId}] Connection closed due to`, lastDisconnect?.error, ", reconnecting:", shouldReconnect);
            if (shouldReconnect) {
                (0, exports.startWhatsAppSession)(orgId);
            }
            else {
                console.log(`[${orgId}] Logged out. Deleting session.`);
                delete exports.activeSessions[orgId];
                delete exports.qrCodes[orgId];
                fs_1.default.rmSync(orgSessionDir, { recursive: true, force: true });
                await supabase_1.supabase.from("whatsapp_sessions").upsert({ org_id: orgId, status: "disconnected" }, { onConflict: "org_id" });
            }
        }
        else if (connection === "open") {
            console.log(`[${orgId}] Connected to WhatsApp!`);
            delete exports.qrCodes[orgId];
            await supabase_1.supabase.from("whatsapp_sessions").upsert({ org_id: orgId, status: "connected" }, { onConflict: "org_id" });
        }
    });
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify")
            return;
        for (const msg of messages) {
            if (!msg.message)
                continue;
            if (msg.key.fromMe)
                continue;
            if ((0, baileys_1.isJidBroadcast)(msg.key.remoteJid || ""))
                continue;
            if (msg.key.remoteJid?.includes("@g.us"))
                continue; // Ignore groups
            if (msg.key.remoteJid?.endsWith("@lid"))
                continue; // Ignore WhatsApp Privacy/Device LIDs
            if (!msg.key.remoteJid?.endsWith("@s.whatsapp.net"))
                continue; // Only accept direct user phone numbers
            // Check if message is forwarded
            const contextInfo = msg.message?.extendedTextMessage?.contextInfo ||
                msg.message?.imageMessage?.contextInfo ||
                msg.message?.videoMessage?.contextInfo ||
                msg.message?.documentMessage?.contextInfo ||
                msg.message?.audioMessage?.contextInfo;
            if (contextInfo?.isForwarded) {
                console.log(`[${orgId}] Ignoring forwarded message from ${msg.key.remoteJid}`);
                continue;
            }
            const phone = msg.key.remoteJid.split("@")[0];
            if (!phone)
                continue;
            const content = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "[Media/Other]";
            const pushName = msg.pushName || phone;
            const timestamp = new Date(msg.messageTimestamp * 1000).toISOString();
            console.log(`[${orgId}] Received message from ${phone}: ${content}`);
            // Find or create chat
            let { data: chat } = await supabase_1.supabase
                .from("whatsapp_chats")
                .select("id")
                .eq("org_id", orgId)
                .eq("client_phone", phone)
                .single();
            if (!chat) {
                const { data: newChat } = await supabase_1.supabase
                    .from("whatsapp_chats")
                    .insert({ org_id: orgId, client_phone: phone, client_name: pushName, last_message_at: timestamp, unread_count: 1 })
                    .select("id")
                    .single();
                chat = newChat;
            }
            else {
                await supabase_1.supabase.rpc("increment_unread", { chat_id: chat.id });
                await supabase_1.supabase.from("whatsapp_chats").update({ last_message_at: timestamp }).eq("id", chat.id);
            }
            if (chat) {
                await supabase_1.supabase.from("whatsapp_messages").insert({
                    chat_id: chat.id,
                    sender: "client",
                    content,
                    timestamp,
                    status: "delivered"
                });
            }
        }
    });
    return sock;
};
exports.startWhatsAppSession = startWhatsAppSession;
const restoreSessions = async () => {
    try {
        const { data: sessions, error } = await supabase_1.supabase.from("whatsapp_sessions").select("org_id").eq("status", "connected");
        if (error) {
            console.error("Failed to fetch sessions to restore:", error);
            return;
        }
        if (sessions && sessions.length > 0) {
            console.log(`Restoring ${sessions.length} WhatsApp sessions...`);
            for (const session of sessions) {
                if (!exports.activeSessions[session.org_id]) {
                    await (0, exports.startWhatsAppSession)(session.org_id).catch(err => {
                        console.error(`Failed to restore session for ${session.org_id}:`, err);
                    });
                }
            }
        }
    }
    catch (err) {
        console.error("Error restoring sessions:", err);
    }
};
exports.restoreSessions = restoreSessions;
const logoutSession = async (orgId) => {
    const sock = exports.activeSessions[orgId];
    if (sock) {
        sock.logout();
        delete exports.activeSessions[orgId];
    }
    const orgSessionDir = path_1.default.join(sessionsDir, orgId);
    if (fs_1.default.existsSync(orgSessionDir)) {
        fs_1.default.rmSync(orgSessionDir, { recursive: true, force: true });
    }
    await supabase_1.supabase.from("whatsapp_sessions").upsert({ org_id: orgId, status: "disconnected" }, { onConflict: "org_id" });
};
exports.logoutSession = logoutSession;
const sendMessage = async (orgId, phone, text, documentUrl, fileName, documentBase64) => {
    let sock = exports.activeSessions[orgId];
    if (!sock) {
        const status = await (0, exports.getSessionStatus)(orgId);
        if (status === "connected") {
            await (0, exports.startWhatsAppSession)(orgId);
            // Wait a moment for it to initialize
            let retries = 5;
            while (!exports.activeSessions[orgId] && retries > 0) {
                await new Promise((r) => setTimeout(r, 1000));
                retries--;
            }
            sock = exports.activeSessions[orgId];
        }
    }
    if (!sock)
        throw new Error("WhatsApp not connected for this organization.");
    const jid = `${phone}@s.whatsapp.net`;
    let result;
    if (documentBase64) {
        // Strip data URL prefix if present
        const base64Data = documentBase64.includes(',') ? documentBase64.split(',')[1] : documentBase64;
        result = await sock.sendMessage(jid, {
            document: Buffer.from(base64Data, 'base64'),
            mimetype: 'application/pdf',
            fileName: fileName || 'Document.pdf',
            caption: text
        });
    }
    else if (documentUrl) {
        result = await sock.sendMessage(jid, {
            document: { url: documentUrl },
            mimetype: 'application/pdf',
            fileName: fileName || 'Document.pdf',
            caption: text
        });
    }
    else {
        result = await sock.sendMessage(jid, { text });
    }
    // Log it to DB
    let { data: chat } = await supabase_1.supabase
        .from("whatsapp_chats")
        .select("id")
        .eq("org_id", orgId)
        .eq("client_phone", phone)
        .single();
    if (!chat) {
        const { data: newChat } = await supabase_1.supabase
            .from("whatsapp_chats")
            .insert({ org_id: orgId, client_phone: phone, last_message_at: new Date().toISOString() })
            .select("id")
            .single();
        chat = newChat;
    }
    else {
        await supabase_1.supabase.from("whatsapp_chats").update({ last_message_at: new Date().toISOString() }).eq("id", chat.id);
    }
    if (chat) {
        await supabase_1.supabase.from("whatsapp_messages").insert({
            chat_id: chat.id,
            sender: "me",
            content: (documentUrl || documentBase64) ? `[Document: ${fileName || 'Document.pdf'}]\n${text}` : text,
            timestamp: new Date().toISOString(),
            status: "sent"
        });
    }
    return result;
};
exports.sendMessage = sendMessage;
