import { Timestamp } from "firebase-admin/firestore";
import { digestWindowMs, sendDigestEmail } from "./_lib/email.js";
import { adminDb } from "./_lib/firebase-admin.js";

export default async function handler(req, res) {
  const cronSecret = globalThis.process?.env.CRON_SECRET;
  if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  const now = Date.now();

  try {
    const snapshot = await adminDb
      .collection("notificationState")
      .where("pendingCount", ">", 0)
      .get();

    let sentCount = 0;
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

      await stateDoc.ref.set(
        {
          pendingCount: 0,
          cooldownUntil: Timestamp.fromMillis(now + digestWindowMs),
          updatedAt: Timestamp.fromMillis(now),
          lastSentAt: Timestamp.fromMillis(now),
        },
        { merge: true },
      );
      sentCount += 1;
    }

    res.status(200).json({ ok: true, sentCount });
  } catch (error) {
    console.error("cron-digest failed:", error);
    res.status(500).json({ ok: false, error: "Cron digest failed" });
  }
}
