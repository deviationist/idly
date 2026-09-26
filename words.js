// Words Idly looks for in session-timeout warnings, per language. Pure data: edit
// freely, then run `node --test`. Everything is lowercase and matched
// case-insensitively. See detect.js for how each list is used.
//
// - session: text that suggests a session/logout warning. Matched anywhere in the
//   dialog's text, so word stems work ("inaktiv" also matches "inaktivitet").
// - stay:    labels of buttons that keep you logged in. Matched at the start of the
//   label, as whole words ("ja" matches "Ja, fortsett" but not "Jakke").
// - leave:   labels that log you out. Matched anywhere in the label. Never clicked.
// - dismiss: labels that close or cancel. Matched as the whole label or its first
//   word(s). Never clicked.
//
// Adding a language: copy a block, translate, and add a real-world example to
// test/detect.test.mjs.

globalThis.IdlyWords = {
  en: {
    session: ["log you out", "logged out", "logging out", "log out", "sign you out", "signed out",
      "session", "inactiv", "idle", "timeout", "time out", "timed out", "expire", "still there"],
    stay: ["continue", "stay", "keep", "extend", "yes", "i'm here", "i am here", "i'm still here",
      "still here", "remain", "renew", "resume"],
    leave: ["log out", "log me out", "logout", "log off", "sign out", "sign me out", "signout", "sign off", "end session"],
    dismiss: ["close", "cancel", "dismiss", "no", "not now"],
  },
  no: {
    session: ["logget ut", "logges ut", "logger deg ut", "utlogg", "inaktiv", "sesjon", "økt", "tidsavbrudd"],
    stay: ["fortsett", "forbli", "bli innlogget", "bli pålogget", "hold meg", "forleng", "forny", "ja", "jeg er her"],
    leave: ["logg ut", "logg meg ut", "logg av", "avslutt"],
    dismiss: ["lukk", "avbryt", "nei", "ikke nå"],
  },
  sv: {
    session: ["loggas ut", "loggar dig ut", "utloggad", "inaktiv", "session", "är du kvar"],
    stay: ["fortsätt", "förbli", "håll mig", "förläng", "förnya", "ja", "behåll", "stanna"],
    leave: ["logga ut", "logga ut mig", "avsluta"],
    dismiss: ["stäng", "avbryt", "nej", "inte nu"],
  },
  da: {
    session: ["logget ud", "logges ud", "logger dig ud", "inaktiv", "session"],
    stay: ["fortsæt", "forbliv", "hold mig", "forlæng", "forny", "ja", "bliv"],
    leave: ["log ud", "log mig ud", "log af", "afslut"],
    dismiss: ["luk", "annuller", "nej", "ikke nu"],
  },
  fi: {
    session: ["kirjaudu", "kirjataan ulos", "istunto", "vanhenee", "aikakatkaisu", "toimettom"],
    stay: ["jatka", "pysy", "kyllä", "pidennä"],
    leave: ["kirjaudu ulos", "lopeta"],
    dismiss: ["sulje", "peruuta", "ei"],
  },
  de: {
    session: ["abgemeldet", "abmeldung", "sitzung", "inaktiv", "zeitüberschreitung", "läuft ab"],
    stay: ["weiter", "fortfahren", "angemeldet bleiben", "eingeloggt bleiben", "verlängern", "ja"],
    leave: ["abmelden", "ausloggen", "beenden", "melde mich ab"],
    dismiss: ["schließen", "abbrechen", "nein"],
  },
  fr: {
    session: ["déconnecté", "déconnexion", "session", "inactivité", "expir"],
    stay: ["continuer", "rester", "prolonger", "oui", "je suis là"],
    leave: ["se déconnecter", "déconnecter", "quitter"],
    dismiss: ["fermer", "annuler", "non"],
  },
  es: {
    session: ["sesión", "inactividad", "expir", "desconect"],
    stay: ["continuar", "seguir", "mantener", "extender", "sí"],
    leave: ["cerrar sesión", "salir", "desconectar"],
    dismiss: ["cerrar", "cancelar", "no"],
  },
  nl: {
    session: ["uitgelogd", "sessie", "inactief", "inactiviteit", "verloopt"],
    stay: ["doorgaan", "ingelogd blijven", "blijf", "verlengen", "ja"],
    leave: ["uitloggen", "afmelden", "afsluiten"],
    dismiss: ["sluiten", "annuleren", "nee"],
  },
  it: {
    session: ["disconness", "sessione", "inattivit", "scad"],
    stay: ["continua", "rimani", "resta", "estendi", "prolunga", "sì"],
    leave: ["esci", "disconnetti", "termina"],
    dismiss: ["chiudi", "annulla", "no"],
  },
};

// Language-independent: developers name classes, ids and test ids in English.
// Matched against the class, id, aria-label and data-testid of a dialog and its parents.
globalThis.IdlyHints = ["timeout", "time-out", "session", "idle", "inactiv", "expir", "keepalive",
  "keep-alive", "autologout", "auto-logout", "logout", "countdown"];
