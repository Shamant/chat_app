import { initializeApp } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const configReady = Object.values(firebaseConfig).every((value) =>
  Boolean(value),
);

let db = null;
let auth = null;
if (configReady) {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
}

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

const signInWithGoogle = async () => {
  if (!auth) throw new Error("Firebase auth is not configured.");
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
};

const signOutUser = async () => {
  if (!auth) return;
  await signOut(auth);
};

export { auth, configReady, db, signInWithGoogle, signOutUser };
