const ALLOWED_EMAILS = [
  
];

const MODERATOR_EMAILS = [
  
];

const normalizeEmail = (value) => String(value ?? "").trim().toLowerCase();

const hasAccess = (email) => ALLOWED_EMAILS.includes(normalizeEmail(email));

const isModeratorEmail = (email) =>
  MODERATOR_EMAILS.includes(normalizeEmail(email));

export { ALLOWED_EMAILS, MODERATOR_EMAILS, hasAccess, isModeratorEmail };
