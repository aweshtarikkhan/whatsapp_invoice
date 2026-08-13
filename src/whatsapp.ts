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

export const getSessionStatus = async (orgId: string) => {
  const { data } = await supabase.from("whatsapp_sessions").select("status").eq("org_id", orgId).single();
  return data?.status || "disconnected";
};

export const startWhatsAppSession = async (orgId: string) => {
  console.log(`Starting WhatsApp session for org: ${orgId}`);
  
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

    if (qr) {
      console.log(`[${orgId}] New QR Code generated.`);
      qrCodes[orgId] = await QRCode.toDataURL(qr);
      
      // Update DB to authenticating
      await supabase.from("whatsapp_sessions").upsert({ org_id: orgId, status: "authenticating" }, { onConflict: "org_id" });
    }

    if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`[${orgId}] Connection closed due to`, lastDisconnect?.error, ", reconnecting:", shouldReconnect);
      
      if (shouldReconnect) {
        startWhatsAppSession(orgId);
      } else {
        console.log(`[${orgId}] Logged out. Deleting session.`);
        delete activeSessions[orgId];
        delete qrCodes[orgId];
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

      // Find or create chat
      let { data: chat } = await supabase
        .from("whatsapp_chats")
        .select("id")
        .eq("org_id", orgId)
        .eq("client_phone", phone)
        .single();

      if (!chat) {
        const { data: newChat } = await supabase
          .from("whatsapp_chats")
          .insert({ org_id: orgId, client_phone: phone, client_name: pushName, last_message_at: timestamp, unread_count: 1 })
          .select("id")
          .single();
        chat = newChat;
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
};

export const sendMessage = async (orgId: string, phone: string, text: string, documentUrl?: string, fileName?: string, documentBase64?: string) => {
  const sock = activeSessions[orgId];
  if (!sock) throw new Error("WhatsApp not connected for this organization.");

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
  } else if (documentUrl) {
    result = await sock.sendMessage(jid, { 
      document: { url: documentUrl }, 
      mimetype: 'application/pdf', 
      fileName: fileName || 'Document.pdf',
      caption: text
    });
  } else {
    result = await sock.sendMessage(jid, { text });
  }
  
  // Log it to DB
  let { data: chat } = await supabase
    .from("whatsapp_chats")
    .select("id")
    .eq("org_id", orgId)
    .eq("client_phone", phone)
    .single();

  if (!chat) {
    const { data: newChat } = await supabase
      .from("whatsapp_chats")
      .insert({ org_id: orgId, client_phone: phone, last_message_at: new Date().toISOString() })
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
