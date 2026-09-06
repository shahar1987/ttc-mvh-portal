// ===== הגדרות הפורטל — הקובץ היחיד שצריך למלא =====
// 1) Firebase Console -> Project settings -> Your apps -> Web app -> Config
window.PORTAL_CONFIG = {
  firebase: {
    apiKey: "PASTE_API_KEY",
    authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
    projectId: "PASTE_PROJECT_ID",
    messagingSenderId: "PASTE_SENDER_ID",
    appId: "PASTE_APP_ID",
  },
  // 2) Firebase Console -> Project settings -> Cloud Messaging -> Web Push certificates -> Key pair
  vapidKey: "PASTE_VAPID_PUBLIC_KEY",
  // 3) כתובת ה-Worker אחרי  npx wrangler deploy   (למשל https://ttc-mvh-login.<account>.workers.dev)
  loginUrl: "https://ttc-mvh-login.PASTE_ACCOUNT.workers.dev",

  // ===== פרטי המועדון (אפשר לערוך גם ממסך הניהול -> settings/club) =====
  club: {
    name: "מועדון טניס שולחן מבואות החרמון",
    fullName: 'מועדון טניס שולחן מבואות החרמון ע"ש רוני גלבוע',
    contactName: "שחר גילעד",
    contactPhone: "0504999149",
    facebook: "https://www.facebook.com/ttcmh",
    instagram: "https://www.instagram.com/ttcmh",
    tttmClubUrl: "https://tttm.co.il/c/160/הפועל-מבואות-חרמון",
  },
};
