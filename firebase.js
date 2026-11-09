// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCsw23YSIeVYIjCx8f2uSc3UKoEwcOdvpw",
  authDomain: "node-project-b4035.firebaseapp.com",
  projectId: "node-project-b4035",
  storageBucket: "node-project-b4035.firebasestorage.app",
  messagingSenderId: "878975651044",
  appId: "1:878975651044:web:e62d579f2d2e6e55d570f1",
  measurementId: "G-MR1LSLRMLP"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);