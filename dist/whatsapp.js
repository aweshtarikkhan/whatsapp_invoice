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
exports.sendMessage = exports.logoutSession = exports.restoreSessions = exports.startWhatsAppSession = exports.getSessionStatus = exports.connectionStates = exports.qrCodes = exports.activeSessions = void 0;
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
exports.connectionStates = {}; // "connecting", "open", "close"
const reconnectTimers = {}; // Debounce reconnection attempts
const getSessionStatus = async (orgId) => {
    const { data } = await supabase_1.supabase.from("whatsapp_sessions").select("status").eq("org_id", orgId).single();
    return data?.status || "disconnected";
};
exports.getSessionStatus = getSessionStatus;
const startWhatsAppSession = async (orgId) => {
    console.log(`Starting WhatsApp session for org: ${orgId}`);
    // Clean up any existing socket first
    const oldSock = exports.activeSessions[orgId];
    if (oldSock) {
        try {
            oldSock.end(undefined);
        }
        catch (e) { }
        delete exports.activeSessions[orgId];
    }
    // Clear any pending reconnect timer
    if (reconnectTimers[orgId]) {
        clearTimeout(reconnectTimers[orgId]);
        delete reconnectTimers[orgId];
    }
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
        if (connection) {
            exports.connectionStates[orgId] = connection;
            console.log(`[${orgId}] Connection state: ${connection}`);
        }
        if (qr) {
            console.log(`[${orgId}] New QR Code generated.`);
            exports.qrCodes[orgId] = await qrcode_1.default.toDataURL(qr);
            // Update DB to authenticating
            await supabase_1.supabase.from("whatsapp_sessions").upsert({ org_id: orgId, status: "authenticating" }, { onConflict: "org_id" });
        }
        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            // Don't reconnect if: logged out, or connection was replaced by us (440)
            const shouldReconnect = statusCode !== baileys_1.DisconnectReason.loggedOut &&
                statusCode !== 440;
            console.log(`[${orgId}] Connection closed (code: ${statusCode}), reconnecting: ${shouldReconnect}`);
            // If this close event is from an OLD socket (we already created a new one), ignore it
            if (exports.activeSessions[orgId] !== sock) {
                console.log(`[${orgId}] Ignoring close from stale socket.`);
                return;
            }
            if (shouldReconnect) {
                // Debounced reconnect: wait 5 seconds, only one reconnect at a time
                if (!reconnectTimers[orgId]) {
                    reconnectTimers[orgId] = setTimeout(async () => {
                        delete reconnectTimers[orgId];
                        // Double-check this socket is still the active one
                        if (exports.activeSessions[orgId] !== sock)
                            return;
                        console.log(`[${orgId}] Attempting reconnect...`);
                        try {
                            await (0, exports.startWhatsAppSession)(orgId);
                        }
                        catch (e) {
                            console.error(`[${orgId}] Reconnect failed:`, e);
                        }
                    }, 5000);
                }
            }
            else {
                console.log(`[${orgId}] Logged out. Deleting session.`);
                delete exports.activeSessions[orgId];
                delete exports.qrCodes[orgId];
                delete exports.connectionStates[orgId];
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
            let rawJid = msg.key.remoteJid || "";
            if ((0, baileys_1.isJidBroadcast)(rawJid))
                continue;
            if (rawJid.includes("@g.us"))
                continue; // Ignore groups
            // If remoteJid is @lid, try using key.participant if it has phone JID
            if (rawJid.endsWith("@lid")) {
                if (msg.key.participant && msg.key.participant.includes("@s.whatsapp.net")) {
                    rawJid = msg.key.participant;
                }
                else {
                    // If pure @lid without participant, skip
                    console.log(`[${orgId}] Skipping @lid message without participant: ${rawJid}`);
                    continue;
                }
            }
            // Extract pure phone number (strip device suffix like :12 and domain @s.whatsapp.net)
            const phoneDigits = rawJid.split("@")[0].split(":")[0].replace(/\D/g, "");
            if (!phoneDigits)
                continue;
            // Unwrap ephemeral, viewOnce, or nested message wrappers
            const realMsg = msg.message?.ephemeralMessage?.message ||
                msg.message?.viewOnceMessage?.message ||
                msg.message?.viewOnceMessageV2?.message ||
                msg.message?.documentWithCaptionMessage?.message ||
                msg.message;
            // Check if message is forwarded
            const contextInfo = realMsg?.extendedTextMessage?.contextInfo ||
                realMsg?.imageMessage?.contextInfo ||
                realMsg?.videoMessage?.contextInfo ||
                realMsg?.documentMessage?.contextInfo ||
                realMsg?.audioMessage?.contextInfo;
            if (contextInfo?.isForwarded) {
                console.log(`[${orgId}] Ignoring forwarded message from ${phoneDigits}`);
                continue;
            }
            const content = realMsg?.conversation ||
                realMsg?.extendedTextMessage?.text ||
                realMsg?.imageMessage?.caption ||
                realMsg?.videoMessage?.caption ||
                realMsg?.documentMessage?.caption ||
                (realMsg?.imageMessage ? "[Photo]" : null) ||
                (realMsg?.videoMessage ? "[Video]" : null) ||
                (realMsg?.documentMessage ? "[Document]" : null) ||
                (realMsg?.audioMessage ? "[Voice Message]" : null) ||
                (realMsg?.stickerMessage ? "[Sticker]" : null) ||
                "[Message]";
            const timestamp = new Date((msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString();
            console.log(`[${orgId}] Received message from ${phoneDigits}: ${content}`);
            // Normalize candidate phone formats for matching DB
            const phone10 = phoneDigits.length === 12 && phoneDigits.startsWith("91") ? phoneDigits.substring(2) : phoneDigits;
            const phoneWith91 = phoneDigits.length === 10 ? `91${phoneDigits}` : phoneDigits;
            const phoneWithPlus = `+${phoneWith91}`;
            const candidatePhones = Array.from(new Set([phoneDigits, phone10, phoneWith91, phoneWithPlus]));
            // Find active chat for this organization
            let { data: chat } = await supabase_1.supabase
                .from("whatsapp_chats")
                .select("id, client_name")
                .eq("org_id", orgId)
                .in("client_phone", candidatePhones)
                .is("archived_session", null)
                .maybeSingle();
            if (!chat) {
                console.log(`[${orgId}] Ignoring incoming message from uninitiated number ${phoneDigits} (candidates: ${candidatePhones.join(",")})`);
                continue;
            }
            await supabase_1.supabase.rpc("increment_unread", { chat_id: chat.id });
            await supabase_1.supabase.from("whatsapp_chats").update({ last_message_at: timestamp }).eq("id", chat.id);
            await supabase_1.supabase.from("whatsapp_messages").insert({
                chat_id: chat.id,
                sender: "client",
                content,
                timestamp,
                status: "delivered"
            });
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
    // Archive existing chats for this organization
    await supabase_1.supabase.rpc("archive_whatsapp_session", { p_org_id: orgId });
};
exports.logoutSession = logoutSession;
const sendMessage = async (orgId, phone, text, documentUrl, fileName, documentBase64) => {
    const normalizedPhone = phone.length === 10 ? `91${phone}` : phone;
    const jid = `${normalizedPhone}@s.whatsapp.net`;
    // Ensure we have an active socket - start one if needed
    const ensureSocket = async () => {
        let sock = exports.activeSessions[orgId];
        if (!sock) {
            const status = await (0, exports.getSessionStatus)(orgId);
            if (status === "connected" || status === "authenticating") {
                await (0, exports.startWhatsAppSession)(orgId);
            }
        }
        // Wait up to 10 seconds for socket to appear and connection to open
        for (let i = 0; i < 10; i++) {
            sock = exports.activeSessions[orgId];
            if (sock && exports.connectionStates[orgId] === "open")
                return sock;
            await new Promise(r => setTimeout(r, 1000));
        }
        // Return whatever we have - trySend will handle failures
        sock = exports.activeSessions[orgId];
        if (sock)
            return sock;
        throw new Error("WhatsApp not connected. Please go to Settings and reconnect.");
    };
    // Try to send, retry up to 3 times with increasing delay
    const trySend = async (msgContent) => {
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const sock = await ensureSocket();
                return await sock.sendMessage(jid, msgContent);
            }
            catch (err) {
                console.error(`[${orgId}] Send attempt ${attempt}/${maxRetries} failed:`, err?.message);
                if (attempt === maxRetries)
                    throw err;
                // Wait with increasing delay: 3s, 6s, 9s
                const delay = attempt * 3000;
                console.log(`[${orgId}] Retrying in ${delay / 1000}s...`);
                await new Promise(r => setTimeout(r, delay));
                // Force reconnect if connection is dead
                if (exports.connectionStates[orgId] !== "open") {
                    console.log(`[${orgId}] Forcing reconnect...`);
                    try {
                        await (0, exports.startWhatsAppSession)(orgId);
                    }
                    catch (e) { }
                    // Wait for reconnection
                    for (let i = 0; i < 8; i++) {
                        if (exports.connectionStates[orgId] === "open")
                            break;
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
            }
        }
    };
    let result;
    // Send text message first
    if (text) {
        result = await trySend({ text });
    }
    // Then send document separately if provided
    if (documentBase64) {
        const base64Data = documentBase64.includes(',') ? documentBase64.split(',')[1] : documentBase64;
        result = await trySend({
            document: Buffer.from(base64Data, 'base64'),
            mimetype: 'application/pdf',
            fileName: fileName || 'Document.pdf'
        });
    }
    else if (documentUrl) {
        result = await trySend({
            document: { url: documentUrl },
            mimetype: 'application/pdf',
            fileName: fileName || 'Document.pdf'
        });
    }
    // Log it to DB
    let { data: chat } = await supabase_1.supabase
        .from("whatsapp_chats")
        .select("id")
        .eq("org_id", orgId)
        .eq("client_phone", phone)
        .is("archived_session", null)
        .maybeSingle();
    if (!chat) {
        // Attempt to fetch client name if possible (try both with and without 91)
        const phone10 = phone.length === 12 && phone.startsWith("91") ? phone.substring(2) : phone;
        const { data: clients } = await supabase_1.supabase
            .from("clients")
            .select("display_name")
            .eq("org_id", orgId)
            .in("phone", [phone, phone10]);
        const clientObj = clients && clients.length > 0 ? clients[0] : null;
        const { data: newChat } = await supabase_1.supabase
            .from("whatsapp_chats")
            .insert({ org_id: orgId, client_phone: phone, client_name: clientObj?.display_name || null, last_message_at: new Date().toISOString() })
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
