import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import { supabase } from "./supabase";

const logger = pino({ level: "silent" });
const sessionsDir = path.resolve(__dirname, "..", "sessions");

if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

// Memory store to hold active sockets and QR codes
export const activeSessions: Record<string, ReturnType<typeof makeWASocket>> = {};
export const qrCodes: Record<string, string> = {}; // Base64 QR codes
export const connectionStates: Record<string, string> = {}; // "connecting", "open", "close"
const reconnectTimers: Record<string, any> = {}; // Debounce reconnection attempts

export const getSessionStatus = async (orgId: string) => {
  const { data } = await supabase.from("whatsapp_sessions").select("status").eq("org_id", orgId).single();
  return data?.status || "disconnected";
};

export const startWhatsAppSession = async (orgId: string) => {
  console.log(`Starting WhatsApp session for org: ${orgId}`);
  
  // Clean up any existing socket first
  const oldSock = activeSessions[orgId];
  if (oldSock) {
    try { oldSock.end(undefined); } catch(e) {}
    delete activeSessions[orgId];
  }
  
  // Clear any pending reconnect timer
  if (reconnectTimers[orgId]) {
    clearTimeout(reconnectTimers[orgId]);
    delete reconnectTimers[orgId];
  }
  
  const orgSessionDir = path.join(sessionsDir, orgId);
  const { state, saveCreds } = await useMultiFileAuthState(orgSessionDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: true,
  });

  activeSessions[orgId] = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection) {
      connectionStates[orgId] = connection;
      console.log(`[${orgId}] Connection state: ${connection}`);
    }

    if (qr) {
      console.log(`[${orgId}] New QR Code generated.`);
      qrCodes[orgId] = await QRCode.toDataURL(qr);
      
      // Update DB to authenticating
      await supabase.from("whatsapp_sessions").upsert({ org_id: orgId, status: "authenticating" }, { onConflict: "org_id" });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      
      // Don't reconnect if: logged out, or connection was replaced by us (440)
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && 
                              statusCode !== 440;
      
      console.log(`[${orgId}] Connection closed (code: ${statusCode}), reconnecting: ${shouldReconnect}`);
      
      // If this close event is from an OLD socket (we already created a new one), ignore it
      if (activeSessions[orgId] !== sock) {
        console.log(`[${orgId}] Ignoring close from stale socket.`);
        return;
      }
      
      if (shouldReconnect) {
        // Debounced reconnect: wait 5 seconds, only one reconnect at a time
        if (!reconnectTimers[orgId]) {
          reconnectTimers[orgId] = setTimeout(async () => {
            delete reconnectTimers[orgId];
            // Double-check this socket is still the active one
            if (activeSessions[orgId] !== sock) return;
            console.log(`[${orgId}] Attempting reconnect...`);
            try {
              await startWhatsAppSession(orgId);
            } catch (e) {
              console.error(`[${orgId}] Reconnect failed:`, e);
            }
          }, 5000);
        }
      } else {
        console.log(`[${orgId}] Logged out. Deleting session.`);
        delete activeSessions[orgId];
        delete qrCodes[orgId];
        delete connectionStates[orgId];
        fs.rmSync(orgSessionDir, { recursive: true, force: true });
        await supabase.from("whatsapp_sessions").upsert({ org_id: orgId, status: "disconnected" }, { onConflict: "org_id" });
      }
    } else if (connection === "open") {
      console.log(`[${orgId}] Connected to WhatsApp!`);
      delete qrCodes[orgId];
      await supabase.from("whatsapp_sessions").upsert({ org_id: orgId, status: "connected" }, { onConflict: "org_id" });
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;
      
      let rawJid = msg.key.remoteJid || "";
      if (isJidBroadcast(rawJid)) continue;
      if (rawJid.includes("@g.us")) continue; // Ignore groups

      // If remoteJid is @lid, try using key.participant if it has phone JID
      if (rawJid.endsWith("@lid")) {
        if (msg.key.participant && msg.key.participant.includes("@s.whatsapp.net")) {
          rawJid = msg.key.participant;
        } else {
          // If pure @lid without participant, skip
          console.log(`[${orgId}] Skipping @lid message without participant: ${rawJid}`);
          continue;
        }
      }

      // Extract pure phone number (strip device suffix like :12 and domain @s.whatsapp.net)
      const phoneDigits = rawJid.split("@")[0].split(":")[0].replace(/\D/g, "");
      if (!phoneDigits) continue;

      // Unwrap ephemeral, viewOnce, or nested message wrappers
      const realMsg = msg.message?.ephemeralMessage?.message ||
                      msg.message?.viewOnceMessage?.message ||
                      msg.message?.viewOnceMessageV2?.message ||
                      msg.message?.documentWithCaptionMessage?.message ||
                      msg.message;

      // Check if message is forwarded
      const contextInfo = 
        realMsg?.extendedTextMessage?.contextInfo ||
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

      const timestamp = new Date((msg.messageTimestamp as number || Math.floor(Date.now() / 1000)) * 1000).toISOString();

      console.log(`[${orgId}] Received message from ${phoneDigits}: ${content}`);

      // Normalize candidate phone formats for matching DB
      const phone10 = phoneDigits.length === 12 && phoneDigits.startsWith("91") ? phoneDigits.substring(2) : phoneDigits;
      const phoneWith91 = phoneDigits.length === 10 ? `91${phoneDigits}` : phoneDigits;
      const phoneWithPlus = `+${phoneWith91}`;

      const candidatePhones = Array.from(new Set([phoneDigits, phone10, phoneWith91, phoneWithPlus]));

      // Find active chat for this organization
      let { data: chat } = await supabase
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

      await supabase.rpc("increment_unread", { chat_id: chat.id });
      await supabase.from("whatsapp_chats").update({ last_message_at: timestamp }).eq("id", chat.id);

      await supabase.from("whatsapp_messages").insert({
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

export const restoreSessions = async () => {
  try {
    const { data: sessions, error } = await supabase.from("whatsapp_sessions").select("org_id").eq("status", "connected");
    if (error) {
      console.error("Failed to fetch sessions to restore:", error);
      return;
    }
    
    if (sessions && sessions.length > 0) {
      console.log(`Restoring ${sessions.length} WhatsApp sessions...`);
      for (const session of sessions) {
        if (!activeSessions[session.org_id]) {
          await startWhatsAppSession(session.org_id).catch(err => {
            console.error(`Failed to restore session for ${session.org_id}:`, err);
          });
        }
      }
    }
  } catch (err) {
    console.error("Error restoring sessions:", err);
  }
};

export const logoutSession = async (orgId: string) => {
  const sock = activeSessions[orgId];
  if (sock) {
    sock.logout();
    delete activeSessions[orgId];
  }
  const orgSessionDir = path.join(sessionsDir, orgId);
  if (fs.existsSync(orgSessionDir)) {
    fs.rmSync(orgSessionDir, { recursive: true, force: true });
  }
  await supabase.from("whatsapp_sessions").upsert({ org_id: orgId, status: "disconnected" }, { onConflict: "org_id" });
  
  // Archive existing chats for this organization
  await supabase.rpc("archive_whatsapp_session", { p_org_id: orgId });
};

export const sendMessage = async (orgId: string, phone: string, text: string, documentUrl?: string, fileName?: string, documentBase64?: string) => {
  const normalizedPhone = phone.length === 10 ? `91${phone}` : phone;
  const jid = `${normalizedPhone}@s.whatsapp.net`;

  // Ensure we have an active socket - start one if needed
  const ensureSocket = async (): Promise<ReturnType<typeof makeWASocket>> => {
    let sock = activeSessions[orgId];
    if (!sock) {
      const status = await getSessionStatus(orgId);
      if (status === "connected" || status === "authenticating") {
        await startWhatsAppSession(orgId);
      }
    }
    // Wait up to 10 seconds for socket to appear and connection to open
    for (let i = 0; i < 10; i++) {
      sock = activeSessions[orgId];
      if (sock && connectionStates[orgId] === "open") return sock;
      await new Promise(r => setTimeout(r, 1000));
    }
    // Return whatever we have - trySend will handle failures
    sock = activeSessions[orgId];
    if (sock) return sock;
    throw new Error("WhatsApp not connected. Please go to Settings and reconnect.");
  };

  // Try to send, retry up to 3 times with increasing delay
  const trySend = async (msgContent: any): Promise<any> => {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const sock = await ensureSocket();
        return await sock.sendMessage(jid, msgContent);
      } catch (err: any) {
        console.error(`[${orgId}] Send attempt ${attempt}/${maxRetries} failed:`, err?.message);
        if (attempt === maxRetries) throw err;
        
        // Wait with increasing delay: 3s, 6s, 9s
        const delay = attempt * 3000;
        console.log(`[${orgId}] Retrying in ${delay/1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        
        // Force reconnect if connection is dead
        if (connectionStates[orgId] !== "open") {
          console.log(`[${orgId}] Forcing reconnect...`);
          try { await startWhatsAppSession(orgId); } catch(e) {}
          // Wait for reconnection
          for (let i = 0; i < 8; i++) {
            if (connectionStates[orgId] === "open") break;
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
  } else if (documentUrl) {
    result = await trySend({ 
      document: { url: documentUrl }, 
      mimetype: 'application/pdf', 
      fileName: fileName || 'Document.pdf'
    });
  }
  
  // Log it to DB
  let { data: chat } = await supabase
    .from("whatsapp_chats")
    .select("id")
    .eq("org_id", orgId)
    .eq("client_phone", phone)
    .is("archived_session", null)
    .maybeSingle();

  if (!chat) {
    // Attempt to fetch client name if possible (try both with and without 91)
    const phone10 = phone.length === 12 && phone.startsWith("91") ? phone.substring(2) : phone;
    const { data: clients } = await supabase
      .from("clients")
      .select("display_name")
      .eq("org_id", orgId)
      .in("phone", [phone, phone10]);

    const clientObj = clients && clients.length > 0 ? clients[0] : null;

    const { data: newChat } = await supabase
      .from("whatsapp_chats")
      .insert({ org_id: orgId, client_phone: phone, client_name: clientObj?.display_name || null, last_message_at: new Date().toISOString() })
      .select("id")
      .single();
    chat = newChat;
  } else {
    await supabase.from("whatsapp_chats").update({ last_message_at: new Date().toISOString() }).eq("id", chat.id);
  }

  if (chat) {
    await supabase.from("whatsapp_messages").insert({
      chat_id: chat.id,
      sender: "me",
      content: (documentUrl || documentBase64) ? `[Document: ${fileName || 'Document.pdf'}]\n${text}` : text,
      timestamp: new Date().toISOString(),
      status: "sent"
    });
  }

  return result;
};
