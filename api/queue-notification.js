import { Timestamp } from "firebase-admin/firestore";
import { ALLOWED_EMAILS, normalizeEmail } from "./_lib/access-control.js";
import { digestWindowMs, sendDigestEmail } from "./_lib/email.js";
import { adminDb } from "./_lib/firebase-admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const senderEmail = normalizeEmail(req.body?.senderEmail);
  const senderName = String(req.body?.senderName ?? "Someone").trim() || "Someone";
  const textPreviewRaw = String(req.body?.text ?? "").trim();
  const textPreview =
    textPreviewRaw.length > 140 ? `${textPreviewRaw.slice(0, 140)}...` : textPreviewRaw;

  if (!ALLOWED_EMAILS.includes(senderEmail)) {
    res.status(403).json({ ok: false, error: "Sender not allowed" });
    return;
  }

  const now = Date.now();

  try {
    for (const recipientEmail of ALLOWED_EMAILS) {
      if (recipientEmail === senderEmail) continue;

      const stateRef = adminDb.collection("notificationState").doc(recipientEmail);
      const result = await adminDb.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(stateRef);
        const existing = snapshot.exists ? snapshot.data() : null;
        const cooldownUntilMs =
          existing?.cooldownUntil?.toMillis?.() ??
          (typeof existing?.cooldownUntil === "number" ? existing.cooldownUntil : 0);

        if (!existing || now >= cooldownUntilMs) {
          transaction.set(
            stateRef,
            {
              recipientEmail,
              pendingCount: 0,
              lastSenderName: senderName,
              lastPreview: textPreview || "(attachment)",
              cooldownUntil: Timestamp.fromMillis(now + digestWindowMs),
              updatedAt: Timestamp.fromMillis(now),
              lastSentAt: Timestamp.fromMillis(now),
            },
            { merge: true },
          );
          return { immediate: true };
        }

        transaction.set(
          stateRef,
          {
            recipientEmail,
            pendingCount: Number(existing.pendingCount ?? 0) + 1,
            lastSenderName: senderName,
            lastPreview: textPreview || "(attachment)",
            cooldownUntil: Timestamp.fromMillis(cooldownUntilMs),
            updatedAt: Timestamp.fromMillis(now),
          },
          { merge: true },
        );
        return { immediate: false };
      });

      if (result?.immediate) {
        await sendDigestEmail({
          recipientEmail,
          count: 1,
          lastSenderName: senderName,
          lastPreview: textPreview || "(attachment)",
        });
      }
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("queue-notification failed:", error);
    res.status(500).json({ ok: false, error: "Notification queue failed" });
  }
}
