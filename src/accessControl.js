const ALLOWED_EMAILS = [
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
];

const MODERATOR_EMAILS = [
  "smanikanti@cisb.org.in",
  "pnair@cisb.org.in",
  "shamantsai@gmail.com",
];

const normalizeEmail = (value) => String(value ?? "").trim().toLowerCase();

const hasAccess = (email) => ALLOWED_EMAILS.includes(normalizeEmail(email));

const isModeratorEmail = (email) =>
  MODERATOR_EMAILS.includes(normalizeEmail(email));

export { ALLOWED_EMAILS, MODERATOR_EMAILS, hasAccess, isModeratorEmail };
