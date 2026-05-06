// User preferences module. Backed by a single localStorage key so
// we can add new prefs over time without reshaping storage.
//
// Use:
//   import { prefs } from './prefs.js';
//   prefs.get('units');             // 'km' | 'mi'
//   prefs.set('units', 'mi');       // persists + notifies subscribers
//   prefs.subscribe(fn);            // fn(prefs) on any change
//
// We deliberately don't validate values exhaustively here —
// callers should treat get() as best-effort and have sensible
// fallbacks. That keeps the prefs object additive: old localStorage
// values from a previous session won't blow up after we add a new
// pref.

const STORAGE_KEY = 'lh.prefs.v1';

const DEFAULTS = Object.freeze({
  units: 'km',  // 'km' | 'mi'
});

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    // Merge over defaults so unknown new keys still get filled in.
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveToStorage(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage can throw in private browsing or when quota is
    // exceeded. We don't surface this; pref changes still take effect
    // in-memory for this session.
  }
}

const subscribers = new Set();

const state = loadFromStorage();
// Mirror to a window global so simple format helpers in other modules
// can read the current value without circular imports. Updated on
// every set().
window.__lhPrefs = state;

export const prefs = {
  get(key) {
    return state[key];
  },
  set(key, value) {
    if (state[key] === value) return;
    state[key] = value;
    window.__lhPrefs = state;
    saveToStorage(state);
    for (const fn of subscribers) {
      try { fn(state); } catch (e) { console.warn('prefs subscriber', e); }
    }
  },
  // Returns an unsubscribe function so a caller can clean up if it
  // wants to (e.g. when a component unmounts). We don't currently
  // have such lifecycles in this app but it's free insurance.
  subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  },
  // Snapshot of the whole prefs object — useful for tests or for
  // serializing into URLs later.
  snapshot() {
    return { ...state };
  },
};
