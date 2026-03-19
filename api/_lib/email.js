import nodemailer from "nodemailer";

const smtpLogin = globalThis.process?.env.BREVO_SMTP_LOGIN;
const smtpPassword = globalThis.process?.env.BREVO_SMTP_PASSWORD;
const mailFrom = globalThis.process?.env.MAIL_FROM;
const appBaseUrl = globalThis.process?.env.APP_BASE_URL ?? "https://example.com";

const digestWindowSeconds = Number(globalThis.process?.env.DIGEST_WINDOW_SECONDS ?? "300");
const digestWindowMs = (Number.isFinite(digestWindowSeconds) ? digestWindowSeconds : 300) * 1000;

const transport =
  smtpLogin && smtpPassword
    ? nodemailer.createTransport({
        host: "smtp-relay.brevo.com",
        port: 587,
        secure: false,
        auth: {
          user: smtpLogin,
          pass: smtpPassword,
        },
      })
    : null;

const sendDigestEmail = async ({ recipientEmail, count, lastSenderName, lastPreview }) => {
  if (!transport || !mailFrom) {
    throw new Error("Brevo SMTP is not configured.");
  }

  const subject =
    count === 1
      ? "1 new message in Classroom Connect"
      : `${count} new messages in Classroom Connect`;

  const text = [
    "Hi,",
    "",
    `You have ${count} new message${count > 1 ? "s" : ""} in Classroom Connect.`,
    `Latest from ${lastSenderName}:`,
    `"${lastPreview || "(attachment)"}"`,
    "",
    `Open chat: ${appBaseUrl}`,
  ].join("\n");

  await transport.sendMail({
    from: mailFrom,
    to: recipientEmail,
    subject,
    text,
  });
};

export { digestWindowMs, sendDigestEmail };
