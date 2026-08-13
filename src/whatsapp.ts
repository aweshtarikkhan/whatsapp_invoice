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
    try { oldSock.ev.removeAllListeners(); } catch(e) {}
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
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[${orgId}] Connection closed (code: ${statusCode}), reconnecting: ${shouldReconnect}`);
      
      if (shouldReconnect) {
        // Debounced reconnect: wait 3 seconds, only one reconnect at a time
        if (!reconnectTimers[orgId]) {
          reconnectTimers[orgId] = setTimeout(async () => {
            delete reconnectTimers[orgId];
            console.log(`[${orgId}] Attempting reconnect...`);
            try {
              await startWhatsAppSession(orgId);
            } catch (e) {
              console.error(`[${orgId}] Reconnect failed:`, e);
            }
          }, 3000);
        }
      } else {
        console.log(`[${orgId}] Logged out. Deleting session.`);
        try { sock.ev.removeAllListeners(); } catch(e) {}
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
      if (isJidBroadcast(msg.key.remoteJid || "")) continue;
      if (msg.key.remoteJid?.includes("@g.us")) continue; // Ignore groups
      if (msg.key.remoteJid?.endsWith("@lid")) continue; // Ignore WhatsApp Privacy/Device LIDs
      if (!msg.key.remoteJid?.endsWith("@s.whatsapp.net")) continue; // Only accept direct user phone numbers

      // Check if message is forwarded
      const contextInfo = 
        msg.message?.extendedTextMessage?.contextInfo ||
        msg.message?.imageMessage?.contextInfo ||
        msg.message?.videoMessage?.contextInfo ||
        msg.message?.documentMessage?.contextInfo ||
        msg.message?.audioMessage?.contextInfo;

      if (contextInfo?.isForwarded) {
        console.log(`[${orgId}] Ignoring forwarded message from ${msg.key.remoteJid}`);
        continue;
      }

      const phone = msg.key.remoteJid.split("@")[0];
      if (!phone) continue;

      const content = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "[Media/Other]";
      const pushName = msg.pushName || phone;
      const timestamp = new Date((msg.messageTimestamp as number) * 1000).toISOString();

      console.log(`[${orgId}] Received message from ${phone}: ${content}`);

        // Check if phone matches any known client (try both with and without 91)
        const phone10 = phone.length === 12 && phone.startsWith("91") ? phone.substring(2) : phone;
        const { data: clients } = await supabase
          .from("clients")
          .select("display_name")
          .eq("org_id", orgId)
          .in("phone", [phone, phone10]);

        const clientObj = clients && clients.length > 0 ? clients[0] : null;

        // Find or create chat
        let { data: chat } = await supabase
          .from("whatsapp_chats")
          .select("id, client_name")
          .eq("org_id", orgId)
          .in("client_phone", [phone, phone10])
          .is("archived_session", null)
          .maybeSingle();
  
        if (!chat) {
          console.log(`[${orgId}] Ignoring incoming message from uninitiated number ${phone}`);
          continue;
        } else {
        await supabase.rpc("increment_unread", { chat_id: chat.id });
        await supabase.from("whatsapp_chats").update({ last_message_at: timestamp }).eq("id", chat.id);
      }

      if (chat) {
        await supabase.from("whatsapp_messages").insert({
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
  let sock = activeSessions[orgId];
  if (!sock) {
    const status = await getSessionStatus(orgId);
    if (status === "connected") {
      await startWhatsAppSession(orgId);
    }
  }
  
  // Give connection a brief moment to become ready if it's still connecting
  if (connectionStates[orgId] !== "open") {
    let waitAttempts = 20;
    while (connectionStates[orgId] !== "open" && waitAttempts > 0) {
      await new Promise((r) => setTimeout(r, 1500));
      waitAttempts--;
    }
  }

  sock = activeSessions[orgId];
  
  if (!sock) {
    throw new Error("WhatsApp not connected. Please reconnect from Settings.");
  }
  
  const normalizedPhone = phone.length === 10 ? `91${phone}` : phone;
  const jid = `${normalizedPhone}@s.whatsapp.net`;
  
  // Helper: attempt to send with retry on Connection Closed
  const trySend = async (msgContent: any, maxRetries = 3): Promise<any> => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const currentSock = activeSessions[orgId];
        if (!currentSock) throw new Error("Socket lost");
        return await currentSock.sendMessage(jid, msgContent);
      } catch (err: any) {
        const errMsg = (err?.message || "").toLowerCase();
        console.error(`[${orgId}] Send attempt ${attempt}/${maxRetries} failed:`, errMsg);
        
        if (attempt === maxRetries) throw err;
        
        // Wait for Baileys auto-reconnect
        console.log(`[${orgId}] Waiting for reconnect before retry...`);
        let waitRetries = 10;
        while (connectionStates[orgId] !== "open" && waitRetries > 0) {
          await new Promise((r) => setTimeout(r, 2000));
          waitRetries--;
        }
        if (connectionStates[orgId] !== "open") {
          throw new Error("WhatsApp connection could not be restored. Please reconnect from Settings.");
        }
      }
    }
  };

  let result;
  
  // Send text message first (lightweight, likely to succeed)
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
