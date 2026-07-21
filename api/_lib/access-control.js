const ALLOWED_EMAILS = [
];

const normalizeEmail = (value) => String(value ?? "").trim().toLowerCase();

export { ALLOWED_EMAILS, normalizeEmail };
