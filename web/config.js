// ===== הגדרות הפורטל — הקובץ היחיד שצריך למלא =====
// 1) Firebase Console -> Project settings -> Your apps -> Web app -> Config
window.PORTAL_CONFIG = {
  firebase: {
    apiKey: "AIzaSyAGrF-WbxA7fbuCS_sdIJQFjAdPqVVIRtw",
    authDomain: "ttc-mvh-portal.firebaseapp.com",
    projectId: "ttc-mvh-portal",
    messagingSenderId: "9781369454",
    appId: "1:9781369454:web:a101838cb72553b711247f",
  },
  // 2) Firebase Console -> Project settings -> Cloud Messaging -> Web Push certificates -> Key pair
  vapidKey: "BNsbFrCidiEhI9yzyYLdeEWWaZ4uD0Oe_BwZYfXS4533qpSDeMyuH83O3tD90l9D85k_3Hyf2olXHBX0WWwQ6cE",
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
