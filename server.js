import "dotenv/config";
import express from "express";
import { initializeApp as initializeFirebaseApp } from "firebase/app";
import {
  Timestamp,
  collection,
  doc,
  getDocs,
  getFirestore,
  query,
  runTransaction,
  setDoc,
  where,
} from "firebase/firestore";
import http from "http";
import nodemailer from "nodemailer";
import { Server } from "socket.io";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const server = http.createServer(app);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CHATROOM_ID = "school-main";
const STORE_PATH = path.join(__dirname, "messages.json");
const WHITEBOARD_STORE_PATH = path.join(__dirname, "whiteboard.json");
const MAX_MESSAGES = 300;
const MAX_PATHS = 800;
const DIGEST_WINDOW_MS =
  (Number(globalThis.process?.env.DIGEST_WINDOW_SECONDS ?? "300") || 300) *
  1000;
let messages = [];
let whiteboardPaths = [];
const ALLOWED_EMAILS = new Set([
  "ddevaraj@cisb.org.in",
  "aajay@cisb.org.in",
  "dchandrakanth@cisb.org.in",
  "mechaudhari@cisb.org.in",
  "skumar@cisb.org.in",
  "ynavneeth@cisb.org.in",
  "risharma@cisb.org.in",
  "hvinoj@cisb.org.in",
  "msundermurthy@cisb.org.in",
  "snandagopal@cisb.org.in",
  "amithra@cisb.org.in",
  "asabnani@cisb.org.in",
  "khomma@cisb.org.in",
  "smanikanti@cisb.org.in",
  "nchilakapati@cisb.org.in",
  "pnair@cisb.org.in",
  "shamantsai@gmail.com",
]);
const MODERATOR_EMAILS = new Set([
  "smanikanti@cisb.org.in",
  "pnair@cisb.org.in",
  "shamantsai@gmail.com",
]);
const brevoSmtpLogin = globalThis.process?.env.BREVO_SMTP_LOGIN;
const brevoSmtpPassword = globalThis.process?.env.BREVO_SMTP_PASSWORD;
const mailFrom =
  globalThis.process?.env.MAIL_FROM ??
  "Classroom Connect <shamant481@gmail.com>";
const smtpTransport =
  brevoSmtpLogin && brevoSmtpPassword
    ? nodemailer.createTransport({
        host: "smtp-relay.brevo.com",
        port: 587,
        secure: false,
        auth: {
          user: brevoSmtpLogin,
          pass: brevoSmtpPassword,
        },
      })
    : null;
const firebaseConfig = {
  apiKey: globalThis.process?.env.VITE_FIREBASE_API_KEY,
  authDomain: globalThis.process?.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: globalThis.process?.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: globalThis.process?.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: globalThis.process?.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: globalThis.process?.env.VITE_FIREBASE_APP_ID,
};
const firebaseReady = Object.values(firebaseConfig).every(Boolean);
const firebaseServerApp = firebaseReady
  ? initializeFirebaseApp(firebaseConfig, "server-notifications")
  : null;
const db = firebaseServerApp ? getFirestore(firebaseServerApp) : null;

const sendDigestEmail = async ({ recipientEmail, count, lastSenderName, lastPreview }) => {
  if (!smtpTransport || !mailFrom) {
    console.log(`Brevo SMTP is not configured. Skipping digest for ${recipientEmail}.`);
    return;
  }

  const subject =
    count === 1
      ? "1 new message in Classroom Connect"
      : `${count} new messages in Classroom Connect`;

  const text = [
    `Hi,`,
    ``,
    `You have ${count} new message${count > 1 ? "s" : ""} in Classroom Connect.`,
    `Latest from ${lastSenderName}:`,
    `"${lastPreview || "(attachment)"}"`,
    ``,
    `Open chat: http://localhost:5173`,
  ].join("\n");

  await smtpTransport.sendMail({
    from: mailFrom,
    to: recipientEmail,
    subject,
    text,
  });
};

const queueDigestEmail = ({ senderEmail, senderName, textPreview }) => {
  if (!db) {
    console.log("Firestore is not configured on server. Skipping notification queue.");
    return;
  }

  const sender = String(senderEmail ?? "").toLowerCase();
  const preview = String(textPreview ?? "").trim();
  const safeSenderName = String(senderName ?? "Someone").trim() || "Someone";
  const previewSnippet = preview.length > 140 ? `${preview.slice(0, 140)}...` : preview;

  ALLOWED_EMAILS.forEach((recipientEmail) => {
    if (recipientEmail === sender) return;

    const stateRef = doc(db, "notificationState", recipientEmail);
    void runTransaction(db, async (transaction) => {
      const now = Date.now();
      const current = await transaction.get(stateRef);
      const existing = current.exists() ? current.data() : null;
      const cooldownUntilMs =
        existing?.cooldownUntil?.toMillis?.() ??
        (typeof existing?.cooldownUntil === "number" ? existing.cooldownUntil : 0);

      const nextCooldownAt = Timestamp.fromMillis(now + DIGEST_WINDOW_MS);

      // Cooldown expired: send immediate, reset pending counter.
      if (!existing || now >= cooldownUntilMs) {
        transaction.set(
          stateRef,
          {
            recipientEmail,
            pendingCount: 0,
            lastSenderName: safeSenderName,
            lastPreview: previewSnippet,
            cooldownUntil: nextCooldownAt,
            updatedAt: Timestamp.fromMillis(now),
            lastSentAt: Timestamp.fromMillis(now),
          },
          { merge: true },
        );
        return { shouldSendImmediate: true };
      }

      // Within cooldown: batch into pending digest.
      const nextPending = Number(existing.pendingCount ?? 0) + 1;
      transaction.set(
        stateRef,
        {
          recipientEmail,
          pendingCount: nextPending,
          lastSenderName: safeSenderName,
          lastPreview: previewSnippet,
          cooldownUntil: Timestamp.fromMillis(cooldownUntilMs),
          updatedAt: Timestamp.fromMillis(now),
        },
        { merge: true },
      );
      return { shouldSendImmediate: false };
    })
      .then((result) => {
        if (!result?.shouldSendImmediate) return;
        return sendDigestEmail({
          recipientEmail,
          count: 1,
          lastSenderName: safeSenderName,
          lastPreview: previewSnippet,
        });
      })
      .catch((error) => {
        console.error(`Failed to process notification state for ${recipientEmail}:`, error);
      });
  });
};

const processPendingDigests = async () => {
  if (!db) return;

  try {
    const now = Date.now();
    const q = query(
      collection(db, "notificationState"),
      where("pendingCount", ">", 0),
    );
    const snapshot = await getDocs(q);

    for (const stateDoc of snapshot.docs) {
      const data = stateDoc.data();
      const cooldownUntilMs =
        data?.cooldownUntil?.toMillis?.() ??
        (typeof data?.cooldownUntil === "number" ? data.cooldownUntil : 0);

      if (now < cooldownUntilMs) continue;

      const recipientEmail = String(data.recipientEmail ?? stateDoc.id);
      const pendingCount = Number(data.pendingCount ?? 0);
      const lastSenderName = String(data.lastSenderName ?? "Someone");
      const lastPreview = String(data.lastPreview ?? "(attachment)");

      if (!recipientEmail || pendingCount <= 0) continue;

      await sendDigestEmail({
        recipientEmail,
        count: pendingCount,
        lastSenderName,
        lastPreview,
      });

      await setDoc(
        doc(db, "notificationState", recipientEmail),
        {
          pendingCount: 0,
          cooldownUntil: Timestamp.fromMillis(now + DIGEST_WINDOW_MS),
          updatedAt: Timestamp.fromMillis(now),
          lastSentAt: Timestamp.fromMillis(now),
        },
        { merge: true },
      );
    }
  } catch (error) {
    console.error("Failed to process pending digests:", error);
  }
};

const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

app.get("/", (_req, res) => {
  res.send("Chat server is running.");
});

const toClockTime = (isoDate) =>
  new Date(isoDate).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

const saveMessages = async () => {
  await writeFile(STORE_PATH, JSON.stringify(messages, null, 2), "utf-8");
};

const saveWhiteboard = async () => {
  await writeFile(
    WHITEBOARD_STORE_PATH,
    JSON.stringify(whiteboardPaths, null, 2),
    "utf-8",
  );
};

const addMessage = async (message) => {
  messages.push(message);
  if (messages.length > MAX_MESSAGES) {
    messages = messages.slice(-MAX_MESSAGES);
  }
  await saveMessages();
};

const addWhiteboardPath = async (pathData) => {
  whiteboardPaths.push(pathData);
  if (whiteboardPaths.length > MAX_PATHS) {
    whiteboardPaths = whiteboardPaths.slice(-MAX_PATHS);
  }
  await saveWhiteboard();
};

const seedOrLoadMessages = async () => {
  if (!existsSync(STORE_PATH)) {
    messages = [
      {
        id: randomUUID(),
        username: "System",
        text: "Welcome to the school chatroom.",
        createdAt: new Date().toISOString(),
      },
    ];
    await saveMessages();
    return;
  }

  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      messages = parsed.slice(-MAX_MESSAGES);
    }
  } catch (error) {
    console.error("Could not read messages.json, starting empty:", error);
    messages = [];
  }
};

const loadWhiteboard = async () => {
  if (!existsSync(WHITEBOARD_STORE_PATH)) {
    whiteboardPaths = [];
    await saveWhiteboard();
    return;
  }

  try {
    const raw = await readFile(WHITEBOARD_STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      whiteboardPaths = parsed.slice(-MAX_PATHS);
    }
  } catch (error) {
    console.error("Could not read whiteboard.json, starting empty:", error);
    whiteboardPaths = [];
  }
};

io.on("connection", (socket) => {
  socket.on("join_room", ({ username, email }, callback) => {
    const cleanName = String(username ?? "").trim();
    const cleanEmail = String(email ?? "").trim().toLowerCase();
    if (!cleanName || cleanName.length < 2) {
      callback?.({ ok: false, error: "Name must be at least 2 characters." });
      return;
    }
    if (!cleanEmail || !ALLOWED_EMAILS.has(cleanEmail)) {
      callback?.({ ok: false, error: "Your email is not approved." });
      return;
    }

    const isModerator = MODERATOR_EMAILS.has(cleanEmail);
    socket.join(CHATROOM_ID);
    socket.data.username = cleanName;
    socket.data.email = cleanEmail;
    socket.data.isModerator = isModerator;

    callback?.({
      ok: true,
      isModerator,
      room: CHATROOM_ID,
      history: messages.map((msg) => ({
        ...msg,
        time: toClockTime(msg.createdAt),
      })),
      whiteboardPaths,
    });

    const joinMessage = {
      id: randomUUID(),
      username: "System",
      text: `${cleanName}${isModerator ? " (mod)" : ""} joined the chat.`,
      createdAt: new Date().toISOString(),
    };

    addMessage(joinMessage).catch((error) => {
      console.error("Failed to store join message:", error);
    });

    io.to(CHATROOM_ID).emit("receive_message", {
      ...joinMessage,
      time: toClockTime(joinMessage.createdAt),
    });
  });

  socket.on("send_message", async ({ text }) => {
    const cleanText = String(text ?? "").trim();
    if (!cleanText || !socket.data.username) return;

    const message = {
      id: randomUUID(),
      username: socket.data.username,
      text: cleanText,
      isModerator: Boolean(socket.data.isModerator),
      createdAt: new Date().toISOString(),
    };

    await addMessage(message);

    io.to(CHATROOM_ID).emit("receive_message", {
      ...message,
      time: toClockTime(message.createdAt),
    });
  });

  socket.on("delete_message", async ({ messageId }, callback) => {
    if (!socket.data.isModerator) {
      callback?.({ ok: false, error: "Only moderators can delete messages." });
      return;
    }

    const before = messages.length;
    messages = messages.filter((msg) => msg.id !== messageId);
    if (messages.length === before) {
      callback?.({ ok: false, error: "Message not found." });
      return;
    }

    await saveMessages();
    io.to(CHATROOM_ID).emit("message_deleted", { messageId });
    callback?.({ ok: true });
  });

  socket.on("clear_chat", async (_payload, callback) => {
    if (!socket.data.isModerator) {
      callback?.({ ok: false, error: "Only moderators can clear chat." });
      return;
    }

    messages = [
      {
        id: randomUUID(),
        username: "System",
        text: `Chat cleared by ${socket.data.username}.`,
        createdAt: new Date().toISOString(),
      },
    ];
    await saveMessages();

    io.to(CHATROOM_ID).emit(
      "chat_replaced",
      messages.map((msg) => ({
        ...msg,
        time: toClockTime(msg.createdAt),
      })),
    );
    callback?.({ ok: true });
  });

  socket.on("whiteboard_add_path", async ({ path }, callback) => {
    if (!socket.data.isModerator) {
      callback?.({ ok: false, error: "Only moderators can draw." });
      return;
    }
    if (!path || !Array.isArray(path.points) || path.points.length < 2) {
      callback?.({ ok: false, error: "Invalid path data." });
      return;
    }

    const safePath = {
      id: `${Date.now()}-${Math.random()}`,
      by: socket.data.username,
      color: path.color ?? "#1f3f96",
      size: path.size ?? 3,
      points: path.points.slice(0, 2000),
      createdAt: new Date().toISOString(),
    };

    await addWhiteboardPath(safePath);
    io.to(CHATROOM_ID).emit("whiteboard_synced", { paths: whiteboardPaths });
    callback?.({ ok: true });
  });

  socket.on("whiteboard_clear", async (_payload, callback) => {
    if (!socket.data.isModerator) {
      callback?.({ ok: false, error: "Only moderators can clear board." });
      return;
    }
    whiteboardPaths = [];
    await saveWhiteboard();
    io.to(CHATROOM_ID).emit("whiteboard_synced", { paths: whiteboardPaths });
    callback?.({ ok: true });
  });

  socket.on("message_created_for_notifications", ({ senderEmail, senderName, text }) => {
    queueDigestEmail({
      senderEmail,
      senderName,
      textPreview: text,
    });
  });

  socket.on("disconnect", () => {
    if (!socket.data.username) return;

    const leaveMessage = {
      id: randomUUID(),
      username: "System",
      text: `${socket.data.username} left the chat.`,
      createdAt: new Date().toISOString(),
    };

    addMessage(leaveMessage).catch((error) => {
      console.error("Failed to store leave message:", error);
    });

    io.to(CHATROOM_ID).emit("receive_message", {
      ...leaveMessage,
      time: toClockTime(leaveMessage.createdAt),
    });
  });
});

const PORT = 3001;
seedOrLoadMessages()
  .then(loadWhiteboard)
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Chat server running at http://localhost:${PORT}`);
      console.log("Email allowlist + moderator access is active.");
      if (smtpTransport) {
        console.log("Brevo digest notifications are active.");
      } else {
        console.log("Brevo digest notifications are disabled (missing env vars).");
      }
      if (!db) {
        console.log("Firestore notification state is disabled (missing Firebase env vars).");
      } else {
        console.log("Firestore-backed cooldown state is active.");
      }
      setInterval(() => {
        void processPendingDigests();
      }, 30000);
    });
  })
  .catch((error) => {
    console.error("Failed to start chat server:", error);
    globalThis.process?.exit(1);
  });
