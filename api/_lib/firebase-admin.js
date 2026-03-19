import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const serviceAccountRaw = globalThis.process?.env.FIREBASE_SERVICE_ACCOUNT_KEY;

const createAdminApp = () => {
  if (!serviceAccountRaw) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_KEY for serverless APIs.");
  }
  const serviceAccount = JSON.parse(serviceAccountRaw);
  return initializeApp({
    credential: cert(serviceAccount),
  });
};

const app = getApps().length > 0 ? getApps()[0] : createAdminApp();
const adminDb = getFirestore(app);

export { adminDb };
