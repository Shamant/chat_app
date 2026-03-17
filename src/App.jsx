import { useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { io } from "socket.io-client";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import "./App.css";
import Whiteboard from "./components/Whiteboard";
import { hasAccess, isModeratorEmail } from "./accessControl";
import { auth, configReady, db, signInWithGoogle, signOutUser } from "./firebase";
import { supabase, supabaseReady } from "./supabase";

const socket = io(import.meta.env.VITE_SERVER_URL ?? "http://localhost:3001", {
  autoConnect: false,
});

function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [joined, setJoined] = useState(false);
  const [isModerator, setIsModerator] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [messages, setMessages] = useState([]);
  const [whiteboardPaths, setWhiteboardPaths] = useState([]);
  const [attachmentFile, setAttachmentFile] = useState(null);
  const [isSending, setIsSending] = useState(false);
  const [activeTab, setActiveTab] = useState("chat");
  const endRef = useRef(null);
  const fileRef = useRef(null);
  const normalizedEmail = useMemo(
    () => user?.email?.trim().toLowerCase() ?? "",
    [user],
  );
  const canAccess = useMemo(() => hasAccess(normalizedEmail), [normalizedEmail]);
  const displayName = useMemo(() => {
    const fromProfile = user?.displayName?.trim();
    if (fromProfile) return fromProfile;
    return normalizedEmail.split("@")[0] || "Student";
  }, [user, normalizedEmail]);

  useEffect(() => {
    socket.on("whiteboard_synced", ({ paths }) => {
      setWhiteboardPaths(Array.isArray(paths) ? paths : []);
    });

    return () => {
      socket.off("whiteboard_synced");
    };
  }, []);

  useEffect(() => {
    if (!configReady || !auth) {
      setAuthLoading(false);
      return undefined;
    }

    const unsub = onAuthStateChanged(auth, async (currentUser) => {
      setAuthLoading(false);
      if (!currentUser) {
        setUser(null);
        setJoined(false);
        setIsModerator(false);
        setMessages([]);
        setWhiteboardPaths([]);
        return;
      }

      const email = currentUser.email?.trim().toLowerCase() ?? "";
      if (!hasAccess(email)) {
        await signOutUser();
        setError("Your Google account is not allowed in this chatroom.");
        return;
      }

      setUser(currentUser);
      setError("");
    });

    return () => unsub();
  }, []);

  useEffect(() => {
    if (!joined || !configReady || !db) return undefined;

    const messagesQuery = query(
      collection(db, "chatMessages"),
      orderBy("createdAt", "asc"),
    );

    const unsubscribe = onSnapshot(messagesQuery, (snapshot) => {
      const nextMessages = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data(),
      }));
      setMessages(nextMessages);
    });

    return () => unsubscribe();
  }, [joined]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const joinRoom = () => {
    if (!canAccess || !user) return;
    if (!configReady) {
      setError("Firebase is not configured. Add keys in .env first.");
      return;
    }

    if (!socket.connected) {
      socket.connect();
    }

    socket.emit(
      "join_room",
      {
        username: displayName,
        email: normalizedEmail,
      },
      (response) => {
        if (!response?.ok) {
          setError(response?.error ?? "Could not join the chat.");
          return;
        }
        setError("");
        setJoined(true);
        setIsModerator(Boolean(response.isModerator));
        setWhiteboardPaths(response.whiteboardPaths ?? []);
      },
    );
  };

  const compressImage = async (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const image = new Image();
        image.onload = () => {
          const maxWidth = 1440;
          const scale = Math.min(1, maxWidth / image.width);
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const ctx = canvas.getContext("2d");
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(
            (blob) => {
              if (!blob) {
                reject(new Error("Compression failed"));
                return;
              }
              resolve(blob);
            },
            "image/webp",
            0.75,
          );
        };
        image.onerror = () => reject(new Error("Invalid image file"));
        image.src = String(reader.result);
      };
      reader.onerror = () => reject(new Error("File read failed"));
      reader.readAsDataURL(file);
    });

  const uploadAttachment = async (file) => {
    if (!supabaseReady || !supabase) {
      throw new Error("Supabase is not configured for attachments.");
    }

    const bucket = import.meta.env.VITE_SUPABASE_BUCKET ?? "chat-attachments";
    let uploadContent = file;
    let contentType = file.type || "application/octet-stream";
    let fileName = file.name;

    if (file.type.startsWith("image/")) {
      const compressedBlob = await compressImage(file);
      uploadContent = compressedBlob;
      contentType = "image/webp";
      fileName = `${file.name.replace(/\.[^.]+$/, "") || "image"}.webp`;
    }

    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}-${safeName}`;

    let uploadError = null;
    try {
      const result = await supabase.storage
        .from(bucket)
        .upload(storagePath, uploadContent, {
          contentType,
          upsert: false,
        });
      uploadError = result.error;
    } catch (networkError) {
      const netMessage = String(networkError?.message ?? "");
      if (netMessage.toLowerCase().includes("failed to fetch")) {
        throw new Error(
          "Cannot reach Supabase. Check VITE_SUPABASE_URL in .env and your network.",
        );
      }
      throw networkError;
    }

    if (uploadError) throw new Error(uploadError.message);

    const {
      data: { publicUrl },
    } = supabase.storage.from(bucket).getPublicUrl(storagePath);

    return {
      name: fileName,
      url: publicUrl,
      type: contentType,
      size: uploadContent.size ?? file.size,
      path: storagePath,
    };
  };

  const sendMessage = async ({ fileOverride, textOverride } = {}) => {
    if (!configReady || !db) {
      setError("Firebase is required for chat messages.");
      return;
    }
    const outgoingText =
      typeof textOverride === "string" ? textOverride : text;
    const outgoingFile = fileOverride ?? attachmentFile;
    if (!outgoingText.trim() && !outgoingFile) return;
    setIsSending(true);

    try {
      let attachment = null;
      if (outgoingFile) {
        attachment = await uploadAttachment(outgoingFile);
      }

      await addDoc(collection(db, "chatMessages"), {
        username: displayName,
        email: normalizedEmail,
        isModerator,
        text: outgoingText.trim(),
        attachment,
        createdAt: serverTimestamp(),
      });

      socket.emit("message_created_for_notifications", {
        senderEmail: normalizedEmail,
        senderName: displayName,
        text: outgoingText.trim() || "(attachment)",
      });

      setText("");
      setAttachmentFile(null);
      if (fileRef.current) {
        fileRef.current.value = "";
      }
      setError("");
    } catch (sendError) {
      const message = String(sendError?.message ?? "");
      if (message.toLowerCase().includes("row-level security")) {
        setError(
          "Upload blocked by Supabase RLS. Add storage insert policy for bucket `files`.",
        );
      } else if (message.toLowerCase().includes("failed to fetch")) {
        setError(
          "Network fetch failed. If this happened on attachment upload, verify Supabase URL and internet.",
        );
      } else {
        setError(message || "Could not send message.");
      }
    } finally {
      setIsSending(false);
    }
  };

  const deleteMessage = async (messageId) => {
    if (!isModerator || !db) return;
    try {
      await deleteDoc(doc(db, "chatMessages", messageId));
      setError("");
    } catch {
      setError("Could not delete message.");
    }
  };

  const clearChat = async () => {
    if (!isModerator || !db) return;
    try {
      const snapshot = await getDocs(collection(db, "chatMessages"));
      const docs = snapshot.docs;
      for (let i = 0; i < docs.length; i += 400) {
        const batch = writeBatch(db);
        docs.slice(i, i + 400).forEach((docSnap) => {
          batch.delete(docSnap.ref);
        });
        // Chunk deletes to stay under Firestore batch limits.
        await batch.commit();
      }
      setError("");
    } catch {
      setError("Could not clear chat.");
    }
  };

  const leaveRoom = () => {
    socket.disconnect();
    setJoined(false);
    setIsModerator(false);
    setMessages([]);
    setWhiteboardPaths([]);
    setText("");
    setAttachmentFile(null);
    setActiveTab("chat");
    setError("");
  };

  const logout = async () => {
    leaveRoom();
    await signOutUser();
    setUser(null);
  };

  const formatTime = (createdAt) => {
    const dateValue = createdAt?.toDate?.() ?? null;
    if (!dateValue) return "";
    return dateValue.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const handleAttachFromWhiteboard = async (file) => {
    setActiveTab("chat");
    setError("");
    await sendMessage({
      fileOverride: file,
      textOverride: "Whiteboard snapshot",
    });
  };

  return (
    <main className="app">
      {!joined ? (
        <section className="panel">
          <h1>Classroom Connect</h1>
          <p className="subtext">
            Secure class chat with attachments and live whiteboard.
          </p>
          {authLoading ? <p className="roomHint">Checking sign-in...</p> : null}

          {user ? (
            <div className="identityCard">
              <p className="identityName">{displayName}</p>
              <p className="identityEmail">{normalizedEmail}</p>
              <p className="identityRole">
                Role: {isModeratorEmail(normalizedEmail) ? "Moderator" : "Member"}
              </p>
            </div>
          ) : null}

          {error ? <p className="errorText">{error}</p> : null}

          {!user ? (
            <button
              onClick={() => {
                void signInWithGoogle().catch(() => {
                  setError("Google sign-in failed. Please try again.");
                });
              }}
              disabled={authLoading || !configReady}
            >
              Sign In With Google
            </button>
          ) : (
            <button onClick={joinRoom} disabled={!canAccess}>
              Enter Classroom
            </button>
          )}

          {user ? (
            <button className="secondary" onClick={() => void logout()}>
              Switch Google Account
            </button>
          ) : null}
          {!configReady ? (
            <p className="errorText">
              Firebase is missing. Add `VITE_FIREBASE_*` values in `.env`.
            </p>
          ) : null}
          {!supabaseReady ? (
            <p className="roomHint">
              Supabase is missing, so attachments are temporarily disabled.
            </p>
          ) : null}
        </section>
      ) : (
        <section className="chat">
          <header className="chatHeader">
            <div>
              <h2>School Main Room</h2>
              <p className="roomHint">
                {displayName} ({normalizedEmail})
                {isModerator ? " - moderator" : ""}
              </p>
            </div>
            <div className="headerButtons">
              {isModerator ? (
                <button onClick={clearChat} className="danger">
                  Clear Chat
                </button>
              ) : null}
              <button onClick={leaveRoom} className="secondary">
                Leave
              </button>
              <button onClick={() => void logout()} className="secondary">
                Logout
              </button>
            </div>
          </header>

          <div className="modeTabs">
            <button
              className={`tabButton ${activeTab === "chat" ? "active" : ""}`}
              onClick={() => setActiveTab("chat")}
            >
              Chat
            </button>
            <button
              className={`tabButton ${
                activeTab === "whiteboard" ? "active" : ""
              }`}
              onClick={() => setActiveTab("whiteboard")}
            >
              Whiteboard
            </button>
          </div>

          {error ? <p className="chatError">{error}</p> : null}

          {activeTab === "chat" ? (
            <div className="chatView">
              <div className="messages">
                {messages.map((msg) => (
                  <article
                    key={msg.id}
                    className={`message ${
                      msg.email === normalizedEmail ? "mine" : "other"
                    }`}
                  >
                    <div className="meta">
                      <strong>
                        {msg.username}
                        {msg.isModerator ? " (mod)" : ""}
                      </strong>
                      <span>{formatTime(msg.createdAt)}</span>
                    </div>
                    {msg.text ? <p>{msg.text}</p> : null}
                    {msg.attachment ? (
                      msg.attachment.type?.startsWith("image/") ? (
                        <a
                          href={msg.attachment.url}
                          target="_blank"
                          rel="noreferrer"
                          className="attachmentLink"
                        >
                          <img
                            src={msg.attachment.url}
                            alt={msg.attachment.name ?? "attachment"}
                            className="attachmentPreview"
                          />
                        </a>
                      ) : (
                        <a
                          href={msg.attachment.url}
                          target="_blank"
                          rel="noreferrer"
                          className="attachmentLink"
                        >
                          {msg.attachment.name ?? "Download attachment"}
                        </a>
                      )
                    ) : null}
                    {isModerator ? (
                      <button
                        className="iconButton"
                        onClick={() => deleteMessage(msg.id)}
                        title="Delete message"
                      >
                        Delete
                      </button>
                    ) : null}
                  </article>
                ))}
                <div ref={endRef} />
              </div>

              {attachmentFile ? (
                <p className="roomHint selectedFile">
                  Selected: {attachmentFile.name}
                </p>
              ) : null}

              <footer className="composer">
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void sendMessage();
                    }
                  }}
                  placeholder="Send a message to class..."
                />
                <label className="fileLabel">
                  Attach
                  <input
                    ref={fileRef}
                    type="file"
                    onChange={(event) => {
                      setAttachmentFile(event.target.files?.[0] ?? null);
                    }}
                  />
                </label>
                <button onClick={() => void sendMessage()} disabled={isSending}>
                  {isSending ? "Sending..." : "Send"}
                </button>
              </footer>
            </div>
          ) : (
            <Whiteboard
              socket={socket}
              username={displayName}
              canDraw={isModerator}
              initialPaths={whiteboardPaths}
              onExportSnapshot={handleAttachFromWhiteboard}
            />
          )}
        </section>
      )}
    </main>
  );
}

export default App;
