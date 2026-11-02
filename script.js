/* =========================================================
   Studio Voix Off — script principal
   Compatible Chrome 100+, Firefox, Safari, Edge
   ========================================================= */
(() => {
'use strict';

/* =========================================================
   1. CONSTANTES
   ========================================================= */
const CHARS_PER_SECOND = 15;           // débit moyen d'une voix française à vitesse 1
const SAMPLE_RATE = 44100;
const NORMALIZE_VERSION = 1;           // à changer si les règles de nettoyage évoluent (invalide le cache)
const LAMEJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';

const OPENAI_MODEL = 'gpt-4o-mini-tts';
const OPENAI_VOICES = [
    ['marin', 'Marin (recommandée)'], ['cedar', 'Cedar (recommandée)'],
    ['alloy', 'Alloy'], ['ash', 'Ash'], ['ballad', 'Ballad'], ['coral', 'Coral'],
    ['echo', 'Echo'], ['fable', 'Fable'], ['nova', 'Nova'], ['onyx', 'Onyx'],
    ['sage', 'Sage'], ['shimmer', 'Shimmer'], ['verse', 'Verse'],
];
const ELEVEN_FALLBACK = [
    ['JBFqnCBsd6RMkjVDRZzb', 'George'],
    ['21m00Tcm4TlvDq8ikWAM', 'Rachel'],
];

// Tarifs publics (estimation, octobre 2026)
const PRICES = {
    openaiPerMinute: 0.015,                     // gpt-4o-mini-tts ≈ 0,015 $ / minute
    eleven: {                                   // $ pour 1 000 caractères (API)
        eleven_multilingual_v2: 0.08,
        eleven_v4: 0.08,
        eleven_flash_v2_5: 0.04,
    },
};

const STORE = {
    settings: 'voixoff-reglages',
    history: 'voixoff-historique',
    project: 'voixoff-projet-courant',
    key: engine => `voixoff-cle-${engine}`,
};

/* =========================================================
   2. OUTILS GÉNÉRAUX
   ========================================================= */
const $ = id => document.getElementById(id);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Petite empreinte de texte (pour les clés de cache)
function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

function formatDuration(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    if (seconds < 60) return `${seconds} s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m} min ${String(s).padStart(2, '0')}`;
}

function formatMoney(dollars) {
    if (dollars <= 0) return '0 $';
    if (dollars < 0.01) return '< 0,01 $';
    return dollars.toFixed(2).replace('.', ',') + ' $';
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function safeFileName(name) {
    return (name || 'voix-off')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'voix-off';
}

/* =========================================================
   3. STOCKAGE
   ========================================================= */
const storage = {
    get(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignoré */ }
    },
    remove(key) {
        try { localStorage.removeItem(key); } catch { /* ignoré */ }
    },
};

// IndexedDB : projets + audio déjà généré (pour ne jamais payer deux fois)
const db = (() => {
    let dbPromise = null;
    let failed = false;
    const memory = { projects: new Map(), audio: new Map() };

    function open() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            if (!window.indexedDB) { reject(new Error('IndexedDB indisponible')); return; }
            const req = indexedDB.open('studio-voix-off', 1);
            req.onupgradeneeded = () => {
                const d = req.result;
                if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
                if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio', { keyPath: 'sig' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }).catch(err => { failed = true; throw err; });
        return dbPromise;
    }

    // Repli en mémoire si IndexedDB est bloqué (navigation privée…)
    function memOp(store, kind, arg) {
        const m = memory[store];
        if (kind === 'get') return m.get(arg);
        if (kind === 'put') { m.set(arg.id || arg.sig, arg); return true; }
        if (kind === 'delete') { m.delete(arg); return true; }
        if (kind === 'all') return [...m.values()];
        if (kind === 'clear') { m.clear(); return true; }
        return undefined;
    }

    async function op(store, mode, kind, arg) {
        if (!failed) {
            let d;
            try { d = await open(); } catch { failed = true; }
            if (d) {
                try {
                    return await new Promise((resolve, reject) => {
                        const tx = d.transaction(store, mode);
                        const st = tx.objectStore(store);
                        let req = null;
                        if (kind === 'get') req = st.get(arg);
                        else if (kind === 'put') req = st.put(arg);
                        else if (kind === 'delete') req = st.delete(arg);
                        else if (kind === 'all') req = st.getAll();
                        else if (kind === 'clear') req = st.clear();
                        tx.oncomplete = () => resolve(req ? req.result : undefined);
                        tx.onerror = () => reject(tx.error);
                        tx.onabort = () => reject(tx.error);
                    });
                } catch (err) {
                    console.warn('IndexedDB :', err);
                    // on continue en mémoire pour cette opération (ex. espace plein)
                }
            }
        }
        return memOp(store, kind, arg);
    }

    return {
        get: (store, key) => op(store, 'readonly', 'get', key),
        put: (store, value) => op(store, 'readwrite', 'put', value),
        delete: (store, key) => op(store, 'readwrite', 'delete', key),
        all: (store) => op(store, 'readonly', 'all'),
        clear: (store) => op(store, 'readwrite', 'clear'),
        get persistent() { return !failed; },
    };
})();

/* =========================================================
   4. RÉGLAGES (globaux, valables pour tous les projets)
   ========================================================= */
const savedSettings = storage.get(STORE.settings, {}) || {};
const settings = Object.assign({
    engine: 'libre',
    libreLang: 'fr',            // langue affichée pour les voix gratuites
    voices: {},                 // voix principale par moteur
    elevenModel: 'eleven_multilingual_v2',
    rate: 1, pitch: 1, volume: 1, stability: 0.5,
    blockSize: 180, gap: 0.3,
    instructions: '',
    normalize: true,
    dictionary: [],             // [[écrit, prononcé], …]
    theme: null,
    format: 'mp3',
    video: { format: '720x1280', style: 'violet', subs: true },
}, savedSettings);

const saveSettings = debounce(() => storage.set(STORE.settings, settings), 200);

/* =========================================================
   4 bis. MESURE D'AUDIENCE (Google Analytics, seulement avec accord)
   ========================================================= */
const GA_ID = 'G-WBGDNYG2B8';
const CONSENT_KEY = 'voixoff-consentement';

function loadAnalytics() {
    if (window.gtag || !GA_ID) return;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_ID, { anonymize_ip: true });
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
    document.head.appendChild(s);
}

function track(name, params) {
    try {
        if (window.gtag && storage.get(CONSENT_KEY, null) === 'granted') window.gtag('event', name, params || {});
    } catch { /* jamais bloquant */ }
}

function setupConsent() {
    const banner = $('consent');
    const choice = storage.get(CONSENT_KEY, null);
    if (choice === 'granted') loadAnalytics();
    banner.hidden = choice !== null;
    $('consent-yes').addEventListener('click', () => {
        storage.set(CONSENT_KEY, 'granted');
        banner.hidden = true;
        loadAnalytics();
    });
    $('consent-no').addEventListener('click', () => {
        const was = storage.get(CONSENT_KEY, null);
        storage.set(CONSENT_KEY, 'denied');
        banner.hidden = true;
        if (was === 'granted') {
            // efface les cookies de mesure déjà posés
            document.cookie.split(';').map(c => c.split('=')[0].trim()).filter(n => /^_ga/.test(n)).forEach(n => {
                const host = location.hostname;
                document.cookie = `${n}=; Max-Age=0; path=/`;
                document.cookie = `${n}=; Max-Age=0; path=/; domain=${host}`;
                document.cookie = `${n}=; Max-Age=0; path=/; domain=.${host}`;
            });
            toast('Mesure d\'audience désactivée.');
        }
    });
    $('open-consent').addEventListener('click', () => { banner.hidden = false; });
    $('open-about').addEventListener('click', () => openDialog('dlg-about'));
}

/* =========================================================
   5. NOTIFICATIONS
   ========================================================= */
function toast(message, type = '') {
    // Une fenêtre ouverte passe au-dessus de tout : on y affiche la notification
    const host = document.querySelector('dialog[open]') || document.body;
    let box = host === document.body ? $('toasts') : host.querySelector(':scope > .toasts');
    if (!box) {
        box = document.createElement('div');
        box.className = 'toasts';
        host.appendChild(box);
    }
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = message;
    box.appendChild(t);
    while (box.children.length > 3) box.firstElementChild.remove();
    setTimeout(() => t.remove(), type === 'error' ? 7000 : 3200);
}

/* =========================================================
   6. FENÊTRES
   ========================================================= */
function openDialog(id) {
    const d = $(id);
    if (!d.open) {
        if (typeof d.showModal === 'function') d.showModal();
        else d.setAttribute('open', '');
    }
    return d;
}
function closeDialog(d) {
    if (typeof d.close === 'function') d.close();
    else d.removeAttribute('open');
}
document.querySelectorAll('.dlg').forEach(d => {
    d.querySelectorAll('.dlg-close').forEach(b => b.addEventListener('click', () => closeDialog(d)));
    // clic sur le fond = fermer
    d.addEventListener('click', e => { if (e.target === d) closeDialog(d); });
});

/* =========================================================
   7. NOMBRES EN TOUTES LETTRES (français)
   ========================================================= */
const UNITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix',
    'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
const TENS = ['', 'dix', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];

function under100(n, plural) {
    if (n < 20) return UNITS[n];
    const t = Math.floor(n / 10), u = n % 10;
    if (t === 7 || t === 9) {
        if (t === 7 && u === 1) return 'soixante et onze';
        return (t === 7 ? 'soixante' : 'quatre-vingt') + '-' + UNITS[10 + u];
    }
    if (t === 8) return u === 0 ? (plural ? 'quatre-vingts' : 'quatre-vingt') : 'quatre-vingt-' + UNITS[u];
    if (u === 0) return TENS[t];
    if (u === 1) return TENS[t] + ' et un';
    return TENS[t] + '-' + UNITS[u];
}

function under1000(n, plural = true) {
    const h = Math.floor(n / 100), r = n % 100;
    let s = '';
    if (h === 1) s = 'cent';
    else if (h > 1) s = UNITS[h] + ' cent' + (r === 0 && plural ? 's' : '');
    if (r === 0) return s || 'zéro';
    return (s ? s + ' ' : '') + under100(r, plural);
}

function numberToWords(n) {
    if (!Number.isFinite(n)) return String(n);
    if (n < 0) return 'moins ' + numberToWords(-n);
    n = Math.floor(n);
    if (n === 0) return 'zéro';
    if (n >= 1e12) return String(n).split('').map(d => UNITS[+d]).join(' ');
    const parts = [];
    const billions = Math.floor(n / 1e9);
    const millions = Math.floor(n / 1e6) % 1000;
    const thousands = Math.floor(n / 1000) % 1000;
    const rest = n % 1000;
    if (billions) parts.push(billions === 1 ? 'un milliard' : under1000(billions) + ' milliards');
    if (millions) parts.push(millions === 1 ? 'un million' : under1000(millions) + ' millions');
    if (thousands) parts.push(thousands === 1 ? 'mille' : under1000(thousands, false) + ' mille');
    if (rest) parts.push(under1000(rest));
    return parts.join(' ');
}

// « un » → « une » devant un nom féminin (une heure, vingt et une minutes)
const feminine = words => words.replace(/(^|\s|-)un$/, '$1une');

// Lit un nombre écrit en chiffres, en gardant les zéros de tête (06 → zéro six)
function digitsToWords(str) {
    let lead = '';
    while (str.length > 1 && str[0] === '0') { lead += 'zéro '; str = str.slice(1); }
    return lead + numberToWords(parseInt(str, 10));
}

function ordinalToWords(n, fem) {
    if (n === 1) return fem ? 'première' : 'premier';
    let w = numberToWords(n);
    if (/cinq$/.test(w)) return w + 'uième';
    if (/neuf$/.test(w)) return w.replace(/f$/, 'vième');
    w = w.replace(/(cent|vingt)s$/, '$1');
    if (/e$/.test(w)) w = w.slice(0, -1);
    return w + 'ième';
}

function romanToInt(s) {
    const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let total = 0;
    for (let i = 0; i < s.length; i++) {
        const v = map[s[i]], next = map[s[i + 1]] || 0;
        total += v < next ? -v : v;
    }
    return total;
}

// "12,5" / "12.5" / "12" → mots
function decimalToWords(str) {
    const [int, dec] = str.replace('.', ',').split(',');
    let w = digitsToWords(int);
    if (dec) w += ' virgule ' + digitsToWords(dec);
    return w;
}

// Noms féminins courants (pour « une fois », « vingt et une personnes »…)
const FEMININE_NOUNS = new Set(['fois', 'heure', 'heures', 'minute', 'minutes', 'seconde', 'secondes',
    'semaine', 'semaines', 'journée', 'journées', 'année', 'années', 'nuit', 'nuits', 'personne', 'personnes',
    'chose', 'choses', 'page', 'pages', 'vidéo', 'vidéos', 'idée', 'idées', 'femme', 'femmes', 'fille', 'filles',
    'ville', 'villes', 'voiture', 'voitures', 'maison', 'maisons', 'étape', 'étapes', 'place', 'places',
    'part', 'parts', 'partie', 'parties', 'photo', 'photos', 'équipe', 'équipes', 'saison', 'saisons',
    'chanson', 'chansons', 'image', 'images', 'raison', 'raisons', 'règle', 'règles', 'astuce', 'astuces',
    'erreur', 'erreurs', 'option', 'options', 'tonne', 'tonnes', 'victoire', 'victoires',
    'étoile', 'étoiles', 'langue', 'langues', 'leçon', 'leçons', 'histoire', 'histoires', 'question', 'questions']);

function isFeminineNoun(word) {
    const w = word.toLowerCase();
    return FEMININE_NOUNS.has(w) || /(tion|sion|tions|sions|ée|ées|ette|ettes)$/.test(w);
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
    'septembre', 'octobre', 'novembre', 'décembre'];

/* =========================================================
   8. NETTOYAGE AUTOMATIQUE DU TEXTE (avant lecture)
   ========================================================= */
const NB = '(?<![\\p{L}\\d])';            // pas de lettre/chiffre juste avant
const NA = '(?![\\p{L}\\d])';             // pas de lettre/chiffre juste après
const NUM = '(\\d+(?:[.,]\\d+)?)';

const CURRENCIES = [
    { re: '€|euros?|EUR', one: 'euro', many: 'euros', cents: 'centimes', de: "d'euros" },
    { re: '\\$|dollars?|USD', one: 'dollar', many: 'dollars', cents: 'cents', de: 'de dollars' },
    { re: '£|livres? sterling', one: 'livre', many: 'livres', cents: 'pence', de: 'de livres', fem: true },
    { re: 'DH|Dhs?|dhs?|MAD|dirhams?', one: 'dirham', many: 'dirhams', cents: 'centimes', de: 'de dirhams' },
];

function readMoney(amount, cur) {
    const [intStr, decStr] = amount.replace('.', ',').split(',');
    const int = parseInt(intStr, 10);
    let w = int === 1 ? (cur.fem ? 'une' : 'un') : numberToWords(int);
    if (int >= 1e6 && int % 1e6 === 0) w += ' ' + cur.de;
    else w += ' ' + (int >= 2 ? cur.many : cur.one);
    if (decStr && /[1-9]/.test(decStr)) {
        const cents = parseInt(decStr.padEnd(2, '0').slice(0, 2), 10);
        w += ' ' + numberToWords(cents);
    }
    return w;
}

const UNIT_WORDS = [
    ['km\\/h', 'kilomètre heure', 'kilomètres heure'],
    ['km²', 'kilomètre carré', 'kilomètres carrés'],
    ['m²', 'mètre carré', 'mètres carrés'],
    ['km', 'kilomètre', 'kilomètres'],
    ['kg', 'kilo', 'kilos'],
    ['°C', 'degré', 'degrés'],
    ['°', 'degré', 'degrés'],
    ['cm', 'centimètre', 'centimètres'],
    ['mm', 'millimètre', 'millimètres'],
    ['ml', 'millilitre', 'millilitres'],
    ['min', 'minute', 'minutes', true],
];

function normalizeFrench(input) {
    let t = ' ' + input + ' ';

    // Emojis, liens, symboles de mise en forme
    t = t.replace(/\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu, ' ');
    t = t.replace(/[️‍]/g, '');
    t = t.replace(/https?:\/\/\S+|www\.\S+/gi, ' ');
    t = t.replace(/#(\p{L}[\p{L}\d_]*)/gu, '$1');
    t = t.replace(/[*_•▪►→←]|->|<-/g, ' ');
    t = t.replace(/([!?])\1+/g, '$1');
    t = t.replace(/~\s*(?=\d)/g, 'environ ');

    // Abréviations
    const abbr = [
        [/(?<![\p{L}])M\.(?=\s+\p{Lu})/gu, 'Monsieur'],
        [/(?<![\p{L}])MM\.(?=\s)/gu, 'Messieurs'],
        [/(?<![\p{L}])Mmes\.?(?![\p{L}])/gu, 'Mesdames'],
        [/(?<![\p{L}])Mme\.?(?![\p{L}])/gu, 'Madame'],
        [/(?<![\p{L}])Mlles\.?(?![\p{L}])/gu, 'Mesdemoiselles'],
        [/(?<![\p{L}])Mlle\.?(?![\p{L}])/gu, 'Mademoiselle'],
        [/(?<![\p{L}])Dr\.?(?=\s+\p{Lu})/gu, 'Docteur'],
        [/(?<![\p{L}])Pr\.?(?=\s+\p{Lu})/gu, 'Professeur'],
        [/(?<![\p{L}])Me\.?(?=\s+\p{Lu}\p{Ll})/gu, 'Maître'],
        [/(?<![\p{L}])Ste\.?(?=[\s-]+\p{Lu})/gu, 'Sainte'],
        [/(?<![\p{L}])St\.?(?=[\s-]+\p{Lu})/gu, 'Saint'],
        [/(?<![\p{L}])av\.\s?J\.?-C\./gu, 'avant Jésus-Christ'],
        [/(?<![\p{L}])apr\.\s?J\.?-C\./gu, 'après Jésus-Christ'],
        [/(?<![\p{L}])J\.-C\./gu, 'Jésus-Christ'],
        [/(?<![\p{L}])cf\.(?![\p{L}])/giu, 'voir'],
        [/(?<![\p{L}])p\.\s?ex\.(?![\p{L}])/gu, 'par exemple'],
        [/(?<![\p{L}])env\.(?![\p{L}])/gu, 'environ'],
        [/(?<![\p{L}])c\.?-?à-?d\.?(?![\p{L}])/giu, "c'est-à-dire"],
        [/(?<![\p{L}])svp(?![\p{L}])/giu, "s'il vous plaît"],
        [/(?<![\p{L}])rdv(?![\p{L}])/giu, 'rendez-vous'],
        [/(?<![\p{L}])vs\.?(?![\p{L}])/gu, 'contre'],
        [/[nN]°\s*/gu, 'numéro '],
        [/\s&\s/g, ' et '],
    ];
    abbr.forEach(([re, rep]) => { t = t.replace(re, rep); });
    // « etc. » : on garde le point s'il termine la phrase
    t = t.replace(/(?<![\p{L}])etc(\.?)(?![\p{L}])(\s*)([,;:)]?)/gu, (m, dot, sp, punct) =>
        'et cetera' + (dot && !punct ? '.' : '') + sp + punct);

    // Milliers séparés par des espaces ou des points : 3 000 / 3.000 → 3000
    t = t.replace(/(?<!\d)(\d{1,3})((?:[   ]\d{3})+)(?!\d)/g, (m, a, b) => a + b.replace(/[   ]/g, ''));
    t = t.replace(/(?<![\d.,])(\d{1,3})((?:\.\d{3})+)(?![\d.,]*\d)/g, (m, a, b) => a + b.replace(/\./g, ''));

    // Nombres négatifs
    t = t.replace(/(^|[\s(])[-−](?=\d)/g, '$1moins ');

    // Dates 01/11/2026
    t = t.replace(new RegExp(NB + '(\\d{1,2})[/.](\\d{1,2})[/.](\\d{4})' + NA, 'gu'), (m, d, mo, y) => {
        const day = +d, month = +mo;
        if (day < 1 || day > 31 || month < 1 || month > 12) return m;
        return `${day === 1 ? 'premier' : numberToWords(day)} ${MONTHS[month - 1]} ${numberToWords(+y)}`;
    });
    // « 1 novembre » / « 1er novembre »
    t = t.replace(new RegExp(NB + '1(?:er)?\\s+(?=(' + MONTHS.join('|') + ')' + NA + ')', 'giu'), 'premier ');

    // Heures 14h30, 8 h, 14:30
    t = t.replace(new RegExp(NB + '(\\d{1,2})\\s?[hH]\\s?(\\d{2})?' + NA, 'gu'), (m, h, min) => {
        const hh = +h;
        if (hh > 24) return m;
        let w = feminine(numberToWords(hh)) + (hh <= 1 ? ' heure' : ' heures');
        if (min && +min > 0) w += ' ' + feminine(numberToWords(+min));
        return w;
    });
    t = t.replace(new RegExp(NB + '([01]?\\d|2[0-3]):([0-5]\\d)' + NA, 'gu'), (m, h, min) => {
        let w = feminine(numberToWords(+h)) + (+h <= 1 ? ' heure' : ' heures');
        if (+min > 0) w += ' ' + feminine(numberToWords(+min));
        return w;
    });

    // Monnaies : 12 €, 12,50 €, 100 DH, $5, 3 millions d'euros
    CURRENCIES.forEach(cur => {
        t = t.replace(new RegExp(NB + NUM + '\\s?(millions?|milliards?)\\s?(?:de\\s|d[\'’])?(?:' + cur.re + ')(?![\\p{L}])', 'gu'),
            (m, a, big) => {
                const plural = parseFloat(a.replace(',', '.')) >= 2;
                const unit = big.replace(/s$/, '') + (plural ? 's' : '');
                return decimalToWords(a) + ' ' + unit + ' ' + cur.de;
            });
        t = t.replace(new RegExp(NB + NUM + '\\s?(?:' + cur.re + ')(?![\\p{L}])', 'gu'), (m, a) => readMoney(a, cur));
        if (cur.re.startsWith('€') || cur.re.startsWith('\\$') || cur.re.startsWith('£')) {
            const sym = cur.re.split('|')[0];
            t = t.replace(new RegExp('(?:' + sym + ')\\s?' + NUM + NA, 'gu'), (m, a) => readMoney(a, cur));
        }
    });

    // Pourcentages
    t = t.replace(new RegExp(NB + NUM + '\\s?%', 'gu'), (m, a) => decimalToWords(a) + ' pour cent');

    // Unités
    UNIT_WORDS.forEach(([u, one, many, fem]) => {
        t = t.replace(new RegExp(NB + NUM + '\\s?' + u + '(?![\\p{L}\\d²])', 'gu'), (m, a) => {
            const isOne = /^[01]([.,]0+)?$/.test(a);
            let w = decimalToWords(a);
            if (fem && /^1$/.test(a)) w = 'une';
            return w + ' ' + (isOne ? one : many);
        });
    });

    // Siècles en chiffres romains : XXIe siècle
    t = t.replace(/(?<![\p{L}])([IVXLC]+)(?:e|ème|eme)(?=\s+(?:siècle|millénaire))/gu, (m, r) => ordinalToWords(romanToInt(r), false));

    // Ordinaux : 1er, 1re, 2e, 3ème, 2nd
    t = t.replace(new RegExp(NB + '(\\d+)\\s?(ers?|res?|ères?|eres?|nde?s?|e|è|ème|eme|èmes|emes|es)' + NA, 'gu'), (m, n, suf) => {
        const num = +n;
        const fem = /^(re|ère|ere|nde)/.test(suf);
        let w = (num === 2 && /^nd/.test(suf)) ? (fem ? 'seconde' : 'second') : ordinalToWords(num, fem);
        if (/s$/.test(suf) && num > 1) w += 's';
        return w;
    });

    // Opérations simples
    t = t.replace(/(\d)\s*\+\s*(?=\d)/g, '$1 plus ');
    t = t.replace(/(\d)\s*=\s*(?=\d)/g, '$1 égale ');
    t = t.replace(/(\d)\s*[x×]\s*(?=\d)/g, '$1 fois ');

    // Tous les nombres restants
    t = t.replace(new RegExp(NB + '(\\d+)\\.(\\d{1,2})' + NA, 'gu'), (m, a, b) => decimalToWords(a + ',' + b));
    t = t.replace(new RegExp(NB + '(\\d+),(\\d+)' + NA, 'gu'), (m, a, b) => decimalToWords(a + ',' + b));
    t = t.replace(new RegExp(NB + '(\\d+)' + NA + '(?=(?:\\s+(\\p{L}+))?)', 'gu'), (m, a, next) => {
        const w = digitsToWords(a);
        return next && isFeminineNoun(next) ? feminine(w) : w;
    });

    return t.replace(/[ \t  ]+/g, ' ').replace(/\s+([,.!?…])/g, '$1').trim();
}

/* =========================================================
   9. DICTIONNAIRE DE PRONONCIATION
   ========================================================= */
let dictRegex = null;
let dictMap = new Map();

function rebuildDictionary() {
    const entries = (settings.dictionary || []).filter(([a, b]) => a && a.trim() && b !== undefined);
    dictMap = new Map(entries.map(([a, b]) => [a.trim().toLowerCase(), b]));
    if (!entries.length) { dictRegex = null; return; }
    const escaped = entries
        .map(([a]) => a.trim())
        .sort((x, y) => y.length - x.length)
        .map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    dictRegex = new RegExp('(?<![\\p{L}\\p{N}])(' + escaped.join('|') + ')(?![\\p{L}\\p{N}])', 'giu');
}

function applyDictionary(text) {
    if (!dictRegex) return text;
    return text.replace(dictRegex, m => {
        const rep = dictMap.get(m.toLowerCase());
        return rep === undefined ? m : rep;
    });
}

// Texte final envoyé à la voix
function prepareSpeech(text) {
    let t = applyDictionary(text);
    if (settings.normalize) t = normalizeFrench(t);
    return t.replace(/\s+/g, ' ').trim();
}

/* =========================================================
   10. BALISES DE MISE EN SCÈNE
   ========================================================= */
const TAG_RE = /\[([^\[\]\n]{1,80})\]/g;

function parseTag(inner) {
    const s = inner.trim();
    const low = s.toLowerCase();
    let m;
    if ((m = low.match(/^(?:pause|silence)(?:\s*[:=]?\s*([\d.,]+)\s*(ms|s|sec|secs|seconde|secondes)?)?$/))) {
        let v = m[1] ? parseFloat(m[1].replace(',', '.')) : 1;
        if (m[2] === 'ms') v /= 1000;
        return { type: 'pause', seconds: clamp(isFinite(v) ? v : 1, 0, 30) };
    }
    if ((m = s.match(/^(?:voix|voice)\s*(?:[:=]\s*(.*))?$/i))) {
        const name = (m[1] || '').trim();
        return { type: 'voice', name: name || null };
    }
    if ((m = low.match(/^(?:vitesse|speed)\s*[:=]?\s*([\d.,]+)?\s*[x×]?$/))) {
        const v = m[1] ? parseFloat(m[1].replace(',', '.')) : 1;
        return { type: 'rate', factor: clamp(isFinite(v) ? v : 1, 0.5, 2) };
    }
    if (low === 'très lent' || low === 'tres lent') return { type: 'rate', factor: 0.75 };
    if (low === 'lent') return { type: 'rate', factor: 0.87 };
    if (low === 'rapide') return { type: 'rate', factor: 1.15 };
    if (low === 'très rapide' || low === 'tres rapide') return { type: 'rate', factor: 1.3 };
    if (low === 'normal' || low === 'normale') return { type: 'rate', factor: 1 };
    if ((m = s.match(/^ton\s*(?:[:=]\s*(.*))?$/i))) {
        const tone = (m[1] || '').trim();
        return { type: 'tone', text: tone || null };
    }
    return { type: 'raw', text: `[${s}]` };
}

// Découpe un texte en morceaux : texte / balise
function tokenize(text) {
    const out = [];
    let last = 0;
    text.replace(TAG_RE, (match, inner, index) => {
        if (index > last) out.push({ type: 'text', text: text.slice(last, index) });
        out.push(Object.assign({ source: match }, parseTag(inner)));
        last = index + match.length;
        return match;
    });
    if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
    return out;
}

// Texte sans les balises (pour l'affichage, les sous-titres, les statistiques)
const stripTags = text => text.replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim();

/* =========================================================
   11. DÉCOUPAGE EN BLOCS (+ mode dialogue)
   ========================================================= */
const SPEAKER_RE = /^\s*(\p{L}[\p{L}\p{N}'’ .\-]{0,23}?)\s*:\s*(\S.*)$/u;

function detectSpeaker(line) {
    const m = line.match(SPEAKER_RE);
    if (!m) return null;
    const name = m[1].trim();
    if (name.split(/\s+/).length > 3) return null;
    return { name, key: name.toUpperCase(), text: m[2] };
}

function splitLong(piece, max) {
    if (piece.length <= max) return [piece];
    const out = [];
    let current = '';
    piece.split(/(?<=[,;:])\s+|\s+/).forEach(part => {
        if (!part) return;
        const candidate = current ? `${current} ${part}` : part;
        if (candidate.length <= max) current = candidate;
        else {
            if (current) out.push(current);
            current = part;
        }
    });
    if (current) out.push(current);
    return out;
}

function splitParagraph(paragraph, max) {
    // On protège les balises pour ne jamais les couper en deux
    const tags = [];
    const safe = paragraph.replace(TAG_RE, m => { tags.push(m); return `${tags.length - 1}`; });
    const restore = s => s.replace(/(\d+)/g, (m, i) => tags[+i]);
    const visibleLength = s => restore(s).replace(TAG_RE, '').length;

    if (visibleLength(safe) <= max) return [restore(safe)];

    const result = [];
    const sentences = safe.match(/[^.!?…]+[.!?…]+["'»”)\]]*|[^.!?…]+$/g) || [safe];
    let current = '';
    sentences.map(s => s.trim()).filter(Boolean).forEach(sentence => {
        const candidate = current ? `${current} ${sentence}` : sentence;
        if (visibleLength(candidate) <= max) current = candidate;
        else {
            if (current) result.push(current);
            const pieces = splitLong(sentence, max);
            current = pieces.pop();
            result.push(...pieces);
        }
    });
    if (current) result.push(current);
    return result.map(restore);
}

// Texte complet → liste de blocs { text, speaker }
function splitText(text, max, dialogue) {
    const blocks = [];
    text.split(/\n+/).map(l => l.trim()).filter(Boolean).forEach(line => {
        let speaker = null;
        let body = line;
        if (dialogue) {
            const sp = detectSpeaker(line);
            if (sp) { speaker = sp.name; body = sp.text; }
        }
        splitParagraph(body, max).forEach(piece => {
            if (piece.trim()) blocks.push({ text: piece.trim(), speaker });
        });
    });
    return blocks;
}

// Personnages présents dans le texte (mode dialogue)
function detectCast(text) {
    const seen = new Map();
    text.split(/\n+/).forEach(line => {
        const sp = detectSpeaker(line);
        if (sp && !seen.has(sp.key)) seen.set(sp.key, sp.name);
    });
    return [...seen.entries()].map(([key, name]) => ({ key, name }));
}

/* =========================================================
   12. ÉLÉMENTS DE LA PAGE ET ÉTAT
   ========================================================= */
const el = {
    projectSelect: $('project-select'), projectNew: $('project-new'),
    projectRename: $('project-rename'), projectDelete: $('project-delete'),
    openDict: $('open-dict'), openCompare: $('open-compare'), openPrompter: $('open-prompter'), theme: $('theme-btn'),
    text: $('text-input'), file: $('file-input'), tagBar: $('tag-bar'), helpTags: $('help-tags'),
    dialogue: $('dialogue-toggle'), previewBtn: $('preview-btn'), cast: $('cast'), castList: $('cast-list'),
    statChars: $('stat-chars'), statWords: $('stat-words'), statDuration: $('stat-duration'), statCost: $('stat-cost'),
    engine: $('engine-select'), apiKey: $('api-key'), keyProvider: $('key-provider'),
    keyToggle: $('key-toggle'), keyForget: $('key-forget'), model: $('model-select'),
    voice: $('voice-select'), voicePreview: $('voice-preview'), instructions: $('instructions'),
    rate: $('rate-slider'), rateValue: $('rate-value'), pitch: $('pitch-slider'), pitchValue: $('pitch-value'),
    stability: $('stability-slider'), stabilityValue: $('stability-value'),
    volume: $('volume-slider'), volumeValue: $('volume-value'), gap: $('gap-slider'), gapValue: $('gap-value'),
    blockSize: $('block-size'), blockSizeValue: $('block-size-value'), normalize: $('normalize-toggle'),
    targetInput: $('target-input'), targetAdjust: $('target-adjust'), targetBar: $('target-bar'),
    targetFill: $('target-fill'), targetMsg: $('target-msg'),
    split: $('split-btn'), editedNotice: $('edited-notice'), blockCount: $('block-count'),
    playAll: $('play-all-btn'), pause: $('pause-btn'), stop: $('stop-btn'),
    progress: $('progress'), progressBar: $('progress-bar'), progressLabel: $('progress-label'),
    blocks: $('blocks-container'),
    musicInput: $('music-input'), musicBox: $('music-box'), musicName: $('music-name'), musicRemove: $('music-remove'),
    musicAdd: $('music-add'), musicVolume: $('music-volume'), musicVolumeValue: $('music-volume-value'),
    musicDuck: $('music-duck'), musicDuckValue: $('music-duck-value'),
    generateAll: $('generate-all-btn'), listenFinal: $('listen-final-btn'), format: $('format-select'),
    exportAudio: $('export-audio-btn'), exportSrt: $('export-srt-btn'), openVideo: $('open-video'),
    storageInfo: $('storage-info'),
    libreLang: $('lang-select'), libreStatus: $('libre-status'), libreOption: $('engine-libre-option'),
};

const state = {
    project: null,          // projet ouvert
    blocks: [],             // [{ id, text, speaker }]
    manualEdits: false,     // blocs modifiés à la main
    timeline: null,         // segments calculés
    music: null,            // { name, blob, buffer }
    busy: false,            // génération / export en cours
};

/* =========================================================
   13. MOTEURS ET VOIX
   ========================================================= */
const engine = () => settings.engine;
const isOnline = (e = engine()) => e !== 'browser';
const getKey = (e = engine()) => (storage.get(STORE.key(e), '') || '').trim();

let browserVoices = [];
let elevenVoices = null;

/* ---------- Voix gratuites : Piper dans le navigateur ---------- */
// Bibliothèques et voix (modifiable ici si une adresse change un jour)
const PIPER_CONFIG = {
    ortUrl: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js',
    ortWasmPath: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/',
    phonemizerUrl: 'https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/+esm',
    voicesUrl: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/',
    cacheName: 'piper-voices-v1',
};
const CARD_URL = 'https://huggingface.co/rhasspy/piper-voices/blob/main/';

// Voix proposées. size = taille approximative du téléchargement (Mo)
const PIPER_VOICES = [
    { stem: 'fr_FR-siwis-medium', name: 'Siwis', gender: 'female', size: 63, license: 'voir la fiche' },
    { stem: 'fr_FR-upmc-medium', speaker: 'jessica', name: 'Jessica', gender: 'female', size: 74, license: 'CC BY-SA 4.0' },
    { stem: 'fr_FR-upmc-medium', speaker: 'pierre', name: 'Pierre', gender: 'male', size: 74, license: 'CC BY-SA 4.0' },
    { stem: 'fr_FR-gilles-low', name: 'Gilles', gender: 'male', size: 63, license: 'CC0' },
    { stem: 'en_GB-alba-medium', name: 'Alba', gender: 'female', size: 63, license: 'voir la fiche' },
    { stem: 'en_US-ryan-medium', name: 'Ryan', gender: 'male', size: 63, license: 'voir la fiche' },
    { stem: 'es_ES-davefx-medium', name: 'Davefx', gender: 'male', size: 63, license: 'voir la fiche' },
    { stem: 'de_DE-thorsten-medium', name: 'Thorsten', gender: 'male', size: 63, license: 'CC0' },
    { stem: 'it_IT-paola-medium', name: 'Paola', gender: 'female', size: 63, license: 'voir la fiche' },
    { stem: 'pt_BR-faber-medium', name: 'Faber', gender: 'male', size: 63, license: 'voir la fiche' },
    { stem: 'ar_JO-kareem-medium', name: 'Kareem', gender: 'male', size: 63, license: 'voir la fiche' },
];

function piperPath(stem) {
    const [code, name, quality] = stem.split('-');
    return `${code.split('_')[0]}/${code}/${name}/${quality}/${stem}`;
}

const libre = {
    checked: false,
    available: false,     // le navigateur sait faire tourner Piper
    engines: [],
    voices: null,         // [{ id, name, locale, lang, gender, engine, stem, speaker, size, license, source }]
    loading: null,
};
const ENGINE_ORDER = { piper: 0 };

function fetchWithTimeout(url, ms, opts = {}) {
    const ctrl = window.AbortController ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
    return fetch(url, Object.assign({}, opts, ctrl ? { signal: ctrl.signal } : {}))
        .finally(() => { if (t) clearTimeout(t); });
}

// Le navigateur peut-il faire tourner Piper ?
async function detectLibreServer() {
    const ok = typeof WebAssembly === 'object' && typeof Worker === 'function'
        && typeof BigInt64Array === 'function' && location.protocol !== 'file:';
    libre.available = ok;
    libre.engines = [{ id: 'piper', name: 'Piper', available: ok,
        detail: ok ? 'Fonctionne dans ton navigateur' : 'Navigateur trop ancien pour les voix Piper' }];
    libre.checked = true;
    if (ok) refreshPiperCache();
    return ok;
}

function loadLibreVoices() {
    if (!libre.voices) {
        libre.voices = PIPER_VOICES.map(v => {
            const code = v.stem.split('-')[0];
            return Object.assign({}, v, {
                id: `piper:${v.stem}${v.speaker ? '#' + v.speaker : ''}`,
                locale: code.replace('_', '-'),
                lang: code.split('_')[0],
                engine: 'piper',
                engine_name: 'Piper',
                source: `${CARD_URL}${piperPath(v.stem).replace(/\/[^/]+$/, '')}/MODEL_CARD`,
            });
        });
    }
    return Promise.resolve(libre.voices);
}

const libreVoice = id => (libre.voices || []).find(v => v.id === id);

/* ---------- Dialogue avec le moteur (Web Worker) ---------- */
const piper = {
    worker: null,
    seq: 0,
    pending: new Map(),         // id → { resolve, reject }
    progress: new Map(),        // stem → { loaded, total }
    cached: new Set(),          // stems déjà téléchargés
    failed: false,
    listeners: new Set(),
};

function piperNotify() { piper.listeners.forEach(fn => { try { fn(); } catch { /* ignoré */ } }); }

function piperWorker() {
    if (piper.worker) return piper.worker;
    const w = new Worker('piper-worker.js');
    w.onmessage = (e) => {
        const m = e.data || {};
        if (m.type === 'progress') {
            piper.progress.set(m.stem, { loaded: m.loaded, total: m.total });
            piperNotify();
            return;
        }
        if (m.type === 'ready') {
            if (!piper.cached.has(m.stem)) {
                piper.cached.add(m.stem);
                track('voice_download', { voice: m.stem });
            }
            piper.progress.delete(m.stem);
            piperNotify();
            return;
        }
        const p = piper.pending.get(m.id);
        if (!p) return;
        piper.pending.delete(m.id);
        if (m.stem) { piper.progress.delete(m.stem); piperNotify(); }
        if (m.ok) p.resolve(m);
        else p.reject(new Error(piperErrorMessage(m.error)));
    };
    w.onerror = (e) => {
        e.preventDefault && e.preventDefault();
        piper.failed = true;
        const err = new Error(piperErrorMessage(e.message || 'démarrage impossible'));
        piper.pending.forEach(p => p.reject(err));
        piper.pending.clear();
        piper.progress.clear();
        piper.worker = null;
        piperNotify();
    };
    piper.worker = w;
    return w;
}

function piperErrorMessage(detail) {
    const d = String(detail || '');
    if (/téléchargement|fetch|network|NetworkError|Failed to fetch|load|import/i.test(d)) {
        return `La voix n'a pas pu être téléchargée. Vérifie ta connexion internet et réessaie. (${d})`;
    }
    return `La voix Piper a rencontré un problème : ${d}. Tu peux utiliser « Navigateur » dans « Moteur de voix » en attendant.`;
}

function piperCall(msg) {
    return new Promise((resolve, reject) => {
        const id = ++piper.seq;
        piper.pending.set(id, { resolve, reject });
        try {
            piperWorker().postMessage(Object.assign({}, msg, { id, config: PIPER_CONFIG }));
        } catch (err) {
            piper.pending.delete(id);
            reject(new Error(piperErrorMessage(err.message)));
        }
    });
}

// Quelles voix sont déjà sur cet appareil ?
async function refreshPiperCache() {
    if (!window.caches) return;
    try {
        const cache = await caches.open(PIPER_CONFIG.cacheName);
        const stems = [...new Set(PIPER_VOICES.map(v => v.stem))];
        for (const stem of stems) {
            const hit = await cache.match(`${PIPER_CONFIG.voicesUrl}${piperPath(stem)}.onnx`);
            if (hit) piper.cached.add(stem); else piper.cached.delete(stem);
        }
        piperNotify();
    } catch { /* stockage indisponible */ }
}

async function clearPiperCache() {
    if (window.caches) await caches.delete(PIPER_CONFIG.cacheName);
    piper.cached.clear();
    if (piper.worker) { piper.worker.terminate(); piper.worker = null; }
    piperNotify();
}

function downloadPiperVoice(voiceId) {
    const v = libreVoice(voiceId);
    if (!v) return Promise.reject(new Error('Voix inconnue.'));
    piper.progress.set(v.stem, { loaded: 0, total: v.size * 1048576 });
    piperNotify();
    return piperCall({ type: 'load', stem: v.stem });
}

// Nom d'une langue en français : "fr-CA" → "français (Canada)"
let langNames = null;
let regionNames = null;
try {
    langNames = new Intl.DisplayNames(['fr'], { type: 'language' });
    regionNames = new Intl.DisplayNames(['fr'], { type: 'region' });
} catch { /* navigateur ancien : on garde les codes */ }

function localeName(locale) {
    if (!locale) return '';
    try {
        if (langNames) return langNames.of(locale);
    } catch { /* code inconnu */ }
    return locale;
}

function langName(lang) {
    try { if (langNames) { const n = langNames.of(lang); return n.charAt(0).toUpperCase() + n.slice(1); } }
    catch { /* code inconnu */ }
    return lang;
}

const GENDERS = { female: 'femme', male: 'homme' };

function libreVoiceLabel(v) {
    const parts = [v.name];
    if (GENDERS[v.gender]) parts.push(GENDERS[v.gender]);
    if (!settings.libreLang) parts.push(localeName(v.locale));
    parts.push(piper.cached.has(v.stem) ? '✓ prête' : `${v.size} Mo à télécharger`);
    return parts.join(' · ');
}

function libreGroup(v) {
    const n = localeName(v.locale);
    return n.charAt(0).toUpperCase() + n.slice(1);
}

// Région préférée pour trier : FR en premier pour le français, etc.
const PREFERRED_REGION = { fr: 'FR', en: 'US', es: 'ES', pt: 'BR', de: 'DE', ar: 'MA', it: 'IT', nl: 'NL' };

function sortedLibreVoices(list) {
    return list.slice().sort((a, b) => {
        const ea = ENGINE_ORDER[a.engine] ?? 9, eb = ENGINE_ORDER[b.engine] ?? 9;
        if (ea !== eb) return ea - eb;
        const pa = a.locale.toUpperCase().endsWith('-' + (PREFERRED_REGION[a.lang] || '?')) ? 0 : 1;
        const pb = b.locale.toUpperCase().endsWith('-' + (PREFERRED_REGION[b.lang] || '?')) ? 0 : 1;
        // ordre du catalogue (meilleures voix d'abord), puis alphabétique
        const ia = PIPER_VOICES.findIndex(v => a.stem === v.stem && (v.speaker || '') === (a.speaker || ''));
        const ib = PIPER_VOICES.findIndex(v => b.stem === v.stem && (v.speaker || '') === (b.speaker || ''));
        return (pa - pb) || a.locale.localeCompare(b.locale) || (ia - ib) || a.name.localeCompare(b.name);
    });
}

function allLibreOptions() {
    return sortedLibreVoices(libre.voices || []).map(v => [v.id, libreVoiceLabel(v), libreGroup(v)]);
}

// Langues présentes dans les voix gratuites : [[code, nom, nombre]]
function libreLanguages() {
    const counts = new Map();
    (libre.voices || []).forEach(v => counts.set(v.lang, (counts.get(v.lang) || 0) + 1));
    return [...counts.entries()]
        .map(([code, n]) => [code, langName(code), n])
        .sort((a, b) => a[1].localeCompare(b[1], 'fr'));
}

function loadBrowserVoiceList() {
    browserVoices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
}

// Voix proposées dans les menus (filtrées par langue pour les voix gratuites)
function voiceOptions(e = engine()) {
    if (e === 'libre') {
        const lang = settings.libreLang;
        const list = (libre.voices || []).filter(v => !lang || v.lang === lang);
        return sortedLibreVoices(list).map(v => [v.id, libreVoiceLabel(v), libreGroup(v)]);
    }
    if (e === 'openai') return OPENAI_VOICES;
    if (e === 'elevenlabs') return elevenVoices && elevenVoices.length ? elevenVoices : ELEVEN_FALLBACK;
    const sorted = browserVoices.slice().sort((a, b) =>
        (Number(b.lang.toLowerCase().startsWith('fr')) - Number(a.lang.toLowerCase().startsWith('fr')))
        || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    return sorted.map(v => [v.voiceURI, `${v.name} (${v.lang})`]);
}

// Toutes les voix du moteur, sans filtre de langue
function allVoiceOptions(e = engine()) {
    return e === 'libre' ? allLibreOptions() : voiceOptions(e);
}

function voiceLabel(value, e = engine()) {
    const found = allVoiceOptions(e).find(([v]) => v === value);
    return found ? found[1].replace(/\s*\(recommandée\)/, '') : value;
}

function mainVoice(e = engine()) {
    const opts = voiceOptions(e);
    const saved = settings.voices[e];
    if (saved && opts.some(([v]) => v === saved)) return saved;
    return opts.length ? opts[0][0] : '';
}

function findVoiceByName(name, e = engine()) {
    const n = name.toLowerCase().trim();
    // d'abord dans la langue choisie, puis dans toutes les voix
    for (const opts of [voiceOptions(e), allVoiceOptions(e)]) {
        const base = l => l.toLowerCase().replace(/\s*\(.*\)$/, '').split(' · ')[0];
        const exact = opts.find(([v, l]) => v.toLowerCase() === n || v.toLowerCase().endsWith(':' + n) || base(l) === n);
        if (exact) return exact[0];
        const partial = opts.find(([, l]) => l.toLowerCase().includes(n));
        if (partial) return partial[0];
    }
    return null;
}

// options : [[valeur, libellé, groupe?]] — les groupes deviennent des <optgroup>
function fillSelect(select, options, value) {
    select.innerHTML = '';
    let group = null, groupName = null;
    options.forEach(([v, l, g]) => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = l;
        if (g) {
            if (g !== groupName) {
                group = document.createElement('optgroup');
                group.label = g;
                groupName = g;
                select.appendChild(group);
            }
            group.appendChild(o);
        } else select.appendChild(o);
    });
    if (value && options.some(([v]) => v === value)) select.value = value;
}

async function loadElevenVoices(force = false) {
    if (!getKey('elevenlabs') || (elevenVoices && !force)) return;
    try {
        const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': getKey('elevenlabs') } });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        const list = (data.voices || []).map(v => {
            const lang = v.labels && (v.labels.language || v.labels.accent);
            return [v.voice_id, v.name + (lang ? ` (${lang})` : '')];
        });
        if (list.length) {
            elevenVoices = list;
            onVoicesChanged();
        }
    } catch {
        // la clé n'a peut-être pas le droit de lister les voix : liste de secours
    }
}

// Débit réel selon le moteur (ElevenLabs limite la vitesse entre 0,7 et 1,2)
function effectiveRate(rate, e = engine()) {
    if (e === 'elevenlabs') return clamp(rate, 0.7, 1.2);
    if (e === 'libre') return clamp(rate, 0.5, 2);
    if (e === 'openai') return clamp(rate, 0.25, 4);
    return clamp(rate, 0.1, 3);
}

/* =========================================================
   14. GÉNÉRATION AUDIO EN LIGNE + CACHE
   ========================================================= */
// Voix gratuites : Piper, calculé dans le navigateur
async function requestLibreAudio(job) {
    const v = libreVoice(job.voice);
    if (!v) throw new Error('Les voix gratuites ne sont pas encore chargées. Recharge la page.');
    const res = await piperCall({
        type: 'synth', stem: v.stem, speaker: v.speaker || '', text: job.speak,
        rate: effectiveRate(job.rate, 'libre'),
    });
    return new Blob([res.wav], { type: 'audio/wav' });
}

async function requestAudio(job) {
    const e = job.engine;
    if (e === 'libre') return requestLibreAudio(job);
    const key = getKey(e);
    if (!key) throw new Error('Ajoute ta clé API dans « La voix ».');
    let res;
    try {
        if (e === 'openai') {
            const body = {
                model: OPENAI_MODEL,
                input: job.speak,
                voice: job.voice,
                response_format: 'mp3',
                speed: effectiveRate(job.rate, e),
            };
            if (job.tone) body.instructions = job.tone;
            res = await fetch('https://api.openai.com/v1/audio/speech', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        } else {
            let stability = job.stability;
            if (job.model === 'eleven_v4') stability = [0, 0.5, 1].reduce((a, b) => Math.abs(b - stability) < Math.abs(a - stability) ? b : a);
            res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(job.voice)}?output_format=mp3_44100_128`, {
                method: 'POST',
                headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
                body: JSON.stringify({
                    text: job.speak,
                    model_id: job.model,
                    voice_settings: {
                        stability,
                        similarity_boost: 0.75,
                        speed: effectiveRate(job.rate, e),
                    },
                }),
            });
        }
    } catch {
        throw new Error('Connexion au service impossible. Vérifie ta connexion internet.');
    }

    if (!res.ok) {
        let detail = '';
        try {
            const data = await res.json();
            detail = (data && data.error && data.error.message)
                || (data && data.detail && (data.detail.message || data.detail))
                || '';
            if (typeof detail !== 'string') detail = JSON.stringify(detail);
        } catch { /* réponse non JSON */ }
        if (res.status === 401) throw new Error('Clé API refusée. Vérifie qu’elle est correcte et qu’elle a le droit « Text to Speech ».');
        if (res.status === 402) throw new Error('Crédit insuffisant sur ton compte. ' + detail);
        if (res.status === 429) throw new Error('Limite ou crédit atteint chez le fournisseur. ' + detail);
        throw new Error(`Erreur ${res.status}. ${detail}`.trim());
    }
    const blob = await res.blob();
    if (!blob.size) throw new Error('Le service a renvoyé un fichier vide.');
    return new Blob([blob], { type: 'audio/mpeg' });
}

// Empreinte d'un segment : si elle change, l'audio doit être régénéré
function jobSignature(job) {
    const parts = [job.engine, job.voice, job.speak, Math.round(effectiveRate(job.rate, job.engine) * 100)];
    if (job.engine === 'openai') parts.push(OPENAI_MODEL, job.tone || '');
    if (job.engine === 'elevenlabs') parts.push(job.model, job.stability);
    return hash(JSON.stringify(parts));
}

const audioMem = new Map();      // sig → { blob, url, duration }
const audioPending = new Map();  // sig → Promise
const audioErrors = new Map();   // sig → message
const decodedMem = new Map();    // sig → AudioBuffer

let decodeCtx = null;
function getDecodeContext() {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) throw new Error("Ce navigateur ne sait pas traiter l'audio.");
    if (!decodeCtx) decodeCtx = new OAC(1, 1, SAMPLE_RATE);
    return decodeCtx;
}

function decodeBlob(blob) {
    return blob.arrayBuffer().then(buf => new Promise((resolve, reject) => {
        const ctx = getDecodeContext();
        const p = ctx.decodeAudioData(buf, resolve, () => reject(new Error('Fichier audio illisible.')));
        if (p && typeof p.then === 'function') p.then(resolve, () => reject(new Error('Fichier audio illisible.')));
    }));
}

async function decodeSig(sig) {
    if (decodedMem.has(sig)) return decodedMem.get(sig);
    const rec = audioMem.get(sig);
    if (!rec) throw new Error('Audio manquant.');
    const buffer = await decodeBlob(rec.blob);
    decodedMem.set(sig, buffer);
    return buffer;
}

// Cherche l'audio en mémoire puis dans la base du navigateur
async function lookupAudio(sig) {
    if (audioMem.has(sig)) return audioMem.get(sig);
    const stored = await db.get('audio', sig);
    if (stored && stored.blob) {
        const rec = { blob: stored.blob, url: URL.createObjectURL(stored.blob), duration: stored.duration || 0 };
        audioMem.set(sig, rec);
        return rec;
    }
    return null;
}

// Renvoie l'audio d'un segment, en le générant si besoin (une seule requête par segment)
function ensureAudio(seg) {
    const sig = seg.sig;
    if (audioMem.has(sig)) return Promise.resolve(audioMem.get(sig));
    if (audioPending.has(sig)) return audioPending.get(sig);
    const p = (async () => {
        try {
            let rec = await lookupAudio(sig);
            if (!rec) {
                const blob = await requestAudio(seg);
                let duration = 0;
                try {
                    const buffer = await decodeBlob(blob);
                    duration = buffer.duration;
                    decodedMem.set(sig, buffer);
                } catch { /* durée inconnue : estimée */ }
                rec = { blob, url: URL.createObjectURL(blob), duration };
                audioMem.set(sig, rec);
                db.put('audio', { sig, blob, duration, chars: seg.speak.length, at: Date.now() });
            }
            audioErrors.delete(sig);
            return rec;
        } catch (err) {
            audioErrors.set(sig, err.message);
            throw err;
        } finally {
            audioPending.delete(sig);
            scheduleRefresh();
        }
    })();
    audioPending.set(sig, p);
    scheduleRefresh();
    return p;
}

// Au chargement d'un projet : retrouve l'audio déjà payé
async function warmCache(segs) {
    if (!isOnline()) return;
    let found = false;
    for (const s of segs) {
        if (s.kind === 'speech' && !audioMem.has(s.sig)) {
            if (await lookupAudio(s.sig)) found = true;
        }
    }
    if (found) scheduleRefresh();
}

/* =========================================================
   15. LIGNE DE TEMPS (blocs → segments à prononcer)
   ========================================================= */
function castVoiceFor(speaker) {
    if (!speaker || !state.project || !state.project.dialogue) return null;
    const cast = (state.project.cast || {})[engine()] || {};
    const v = cast[speaker.toUpperCase()];
    return v && voiceOptions().some(([x]) => x === v) ? v : null;
}

function buildTimeline(blockList = state.blocks) {
    const e = engine();
    const main = mainVoice(e);
    const passRaw = e === 'elevenlabs' && settings.elevenModel === 'eleven_v4';
    const segs = [];
    const warnings = new Set();
    const st = { voice: null, rateFactor: 1, tone: null };
    let prevSpeaker;

    blockList.forEach((block, bi) => {
        if (prevSpeaker !== undefined && (block.speaker || null) !== prevSpeaker) st.voice = null;
        prevSpeaker = block.speaker || null;
        if (bi > 0 && settings.gap > 0) segs.push({ kind: 'gap', block: bi, seconds: settings.gap });

        let display = '';
        let speakParts = [];
        let dispStart = -1;

        const flush = () => {
            const raw = speakParts.join(' ').replace(/\s+/g, ' ').trim();
            const visible = stripTags(raw);
            if (visible) {
                const voice = st.voice || castVoiceFor(block.speaker) || main;
                const speakSource = passRaw ? raw : visible;
                const seg = {
                    kind: 'speech', block: bi, engine: e,
                    text: display.slice(dispStart),
                    start: dispStart, end: display.length,
                    speak: prepareSpeech(speakSource),
                    voice, voiceName: voiceLabel(voice, e) || 'voix par défaut',
                    rate: settings.rate * st.rateFactor,
                    tone: e === 'openai' ? (st.tone || settings.instructions || '') : '',
                    model: settings.elevenModel,
                    stability: settings.stability,
                    pitch: settings.pitch,
                    speaker: block.speaker || null,
                };
                if (!seg.speak) seg.speak = visible;
                seg.sig = jobSignature(seg);
                segs.push(seg);
            }
            speakParts = [];
            dispStart = -1;
        };

        tokenize(block.text).forEach(tok => {
            if (tok.type === 'text' || tok.type === 'raw') {
                if (tok.type === 'text') {
                    const clean = tok.text.replace(/\s+/g, ' ').trim();
                    if (clean) {
                        if (dispStart < 0) dispStart = display ? display.length + 1 : 0;
                        display += (display ? ' ' : '') + clean;
                    }
                }
                speakParts.push(tok.type === 'raw' ? tok.text : tok.text);
                return;
            }
            flush();
            if (tok.type === 'pause') segs.push({ kind: 'pause', block: bi, seconds: tok.seconds });
            else if (tok.type === 'voice') {
                if (!tok.name) st.voice = null;
                else {
                    const v = findVoiceByName(tok.name, e);
                    if (v) st.voice = v;
                    else warnings.add(`Voix « ${tok.name} » introuvable pour ce moteur : voix principale utilisée.`);
                }
            } else if (tok.type === 'rate') st.rateFactor = tok.factor;
            else if (tok.type === 'tone') st.tone = tok.text;
        });
        flush();
        block.display = display;
    });

    // Durées (réelles si l'audio existe déjà, sinon estimées)
    segs.forEach(s => {
        if (s.kind !== 'speech') { s.duration = s.seconds; s.exact = true; return; }
        const rec = isOnline(e) ? audioMem.get(s.sig) : null;
        s.exact = !!(rec && rec.duration);
        s.duration = s.exact ? rec.duration : s.speak.length / (CHARS_PER_SECOND * effectiveRate(s.rate, e));
    });

    return { segs, warnings: [...warnings] };
}

// Positions dans le temps (début / fin de chaque segment)
function layoutTimeline(segs, lead = 0) {
    let t = lead;
    return segs.map(s => {
        const item = Object.assign({}, s, { at: t });
        t += s.duration;
        item.endAt = t;
        return item;
    });
}

function timelineTotals(tl) {
    let total = 0, speech = 0, fixed = 0, chars = 0, charsToGenerate = 0, exact = true;
    tl.segs.forEach(s => {
        total += s.duration;
        if (s.kind === 'speech') {
            speech += s.duration;
            chars += s.speak.length;
            if (!audioMem.has(s.sig)) charsToGenerate += s.speak.length;
            if (!s.exact) exact = false;
        } else fixed += s.duration;
    });
    return { total, speech, fixed, chars, charsToGenerate, exact };
}

function estimateCost(chars, seconds, e = engine()) {
    if (e === 'libre') return 0;
    if (e === 'openai') return (seconds / 60) * PRICES.openaiPerMinute + (chars / 4) * 0.6e-6;
    if (e === 'elevenlabs') return (chars / 1000) * (PRICES.eleven[settings.elevenModel] || 0.08);
    return 0;
}

/* =========================================================
   16. RAFRAÎCHISSEMENT GÉNÉRAL DE L'INTERFACE
   ========================================================= */
let refreshTimer = null;
let lastSigKey = '';

function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshAll, 40);
}

// Blocs utilisés pour les calculs : les vrais blocs, ou le texte découpé à la volée
function workingBlocks() {
    if (state.blocks.length) return state.blocks;
    return splitText(el.text.value, settings.blockSize, !!(state.project && state.project.dialogue));
}

function refreshAll() {
    const tl = buildTimeline(workingBlocks());
    state.timeline = tl;
    const totals = timelineTotals(tl);

    // Statistiques du texte
    const visible = stripTags(el.text.value);
    el.statChars.textContent = visible.length.toLocaleString('fr-FR');
    el.statWords.textContent = (visible ? visible.split(/\s+/).length : 0).toLocaleString('fr-FR');
    el.statDuration.textContent = formatDuration(totals.total) + (totals.exact && totals.total > 0 && isOnline() ? ' (exact)' : '');

    el.statCost.title = '';
    if (!isOnline() || engine() === 'libre') el.statCost.textContent = totals.chars ? 'Gratuit' : '';
    else if (!totals.chars) el.statCost.textContent = '';
    else if (!totals.charsToGenerate) el.statCost.textContent = 'Tout est déjà généré ✓';
    else {
        const seconds = totals.speech * (totals.charsToGenerate / totals.chars);
        el.statCost.textContent = `≈ ${formatMoney(estimateCost(totals.charsToGenerate, seconds))} à générer`;
        el.statCost.title = `${totals.charsToGenerate.toLocaleString('fr-FR')} caractères à générer. Estimation au tarif public de l'API, à titre indicatif.`;
    }

    // Vitesse réellement appliquée (ElevenLabs est limité entre 0,7× et 1,2×)
    const eff = effectiveRate(settings.rate);
    el.rateValue.textContent = Math.abs(eff - settings.rate) > 0.001
        ? `${settings.rate.toFixed(2)}× → ${eff.toFixed(2)}× max`
        : `${settings.rate.toFixed(2)}×`;
    el.rateValue.title = Math.abs(eff - settings.rate) > 0.001 ? 'ElevenLabs accepte une vitesse entre 0,7× et 1,2×' : '';

    renderBlockStates(tl);
    refreshTarget(tl, totals);
    updateButtons();

    const sigKey = tl.segs.filter(s => s.kind === 'speech').map(s => s.sig).join(',');
    if (sigKey !== lastSigKey) {
        lastSigKey = sigKey;
        warmCache(tl.segs);
    }
}

function updateButtons() {
    const has = workingBlocks().length > 0;
    const online = isOnline();
    el.playAll.disabled = !has;
    el.pause.disabled = !has;
    el.exportSrt.disabled = !has;
    el.generateAll.disabled = !has || !online || state.busy;
    el.listenFinal.disabled = !has || !online || state.busy;
    el.exportAudio.disabled = !has || !online || state.busy;
    el.openVideo.disabled = !has || !online || state.busy;
    el.blockCount.textContent = state.blocks.length;
    el.editedNotice.hidden = !state.manualEdits;
}

/* =========================================================
   17. BLOCS
   ========================================================= */
function splitNow() {
    stopPlayback();
    const list = splitText(el.text.value, settings.blockSize, !!state.project.dialogue);
    state.blocks = list.map(b => ({ id: uid(), text: b.text, speaker: b.speaker }));
    state.manualEdits = false;
    renderBlocks();
    saveProjectSoon();
}

const autoSplit = debounce(() => { if (!state.manualEdits) splitNow(); }, 350);

function renderBlocks() {
    el.blocks.innerHTML = '';
    if (!state.blocks.length) {
        el.blocks.innerHTML = '<div class="empty">Écris ton texte à gauche : il est découpé automatiquement en blocs.<br>Clique sur le texte d\'un bloc pour le modifier.</div>';
    }
    state.blocks.forEach((block, i) => el.blocks.appendChild(buildBlockCard(block, i)));
    scheduleRefresh();
}

function buildBlockCard(block, index) {
    const card = document.createElement('article');
    card.className = 'block';
    card.dataset.id = block.id;

    const head = document.createElement('div');
    head.className = 'block-head';
    const left = document.createElement('div');
    left.className = 'block-left';
    const num = document.createElement('span');
    num.className = 'block-num';
    num.textContent = `Bloc ${index + 1}`;
    left.appendChild(num);
    if (block.speaker) {
        const sp = document.createElement('span');
        sp.className = 'speaker';
        sp.textContent = block.speaker;
        sp.style.background = speakerColor(block.speaker);
        left.appendChild(sp);
    }
    const meta = document.createElement('span');
    meta.className = 'block-meta';
    left.appendChild(meta);
    const status = document.createElement('span');
    status.className = 'status';
    status.hidden = true;
    head.append(left, status);

    const text = document.createElement('p');
    text.className = 'block-text';
    text.textContent = block.text;
    text.title = 'Clique pour modifier';
    text.spellcheck = true;
    try { text.contentEditable = 'plaintext-only'; } catch { text.contentEditable = 'true'; }
    if (text.contentEditable !== 'plaintext-only') text.contentEditable = 'true';
    text.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); text.blur(); }
        if (e.key === 'Escape') { text.textContent = block.text; text.blur(); }
    });
    text.addEventListener('blur', () => {
        const value = text.textContent.replace(/\s+/g, ' ').trim();
        if (!value) { text.textContent = block.text; return; }
        if (value !== block.text) {
            block.text = value;
            state.manualEdits = true;
            saveProjectSoon();
            scheduleRefresh();
            toast(`Bloc ${state.blocks.indexOf(block) + 1} modifié`);
        }
    });

    const actions = document.createElement('div');
    actions.className = 'block-actions';
    const idx = () => state.blocks.indexOf(block);
    actions.append(
        makeButton('▶ Écouter', 'success small', () => playFrom(idx(), true)),
        makeButton('⏵ Depuis ici', 'ghost small', () => playFrom(idx(), false), 'Lire ce bloc et tous les suivants'),
        makeButton('⬇ Audio', 'ghost small online-only', () => exportBlockAudio(idx()), 'Télécharger l\'audio de ce bloc'),
        makeButton('Copier', 'ghost small', async () => {
            try { await navigator.clipboard.writeText(stripTags(block.text)); toast('Texte copié'); }
            catch { toast('Copie impossible', 'error'); }
        }),
        makeButton('✕', 'ghost small', () => {
            stopPlayback();
            state.blocks = state.blocks.filter(b => b !== block);
            state.manualEdits = true;
            renderBlocks();
            saveProjectSoon();
        }, 'Supprimer ce bloc'),
    );

    card.append(head, text, actions);
    return card;
}

function makeButton(label, className, onClick, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
}

const SPEAKER_COLORS = ['#6d4aff', '#12a57a', '#e5484d', '#c27c00', '#0c8ce9', '#d6409f', '#2f9e44', '#7a5af8'];
// Couleur stable par personnage, dans l'ordre d'apparition (deux personnages = deux couleurs)
function speakerColor(name) {
    const key = (name || '').toUpperCase();
    const order = detectCast(el.text.value).map(c => c.key);
    state.blocks.forEach(b => { if (b.speaker && !order.includes(b.speaker.toUpperCase())) order.push(b.speaker.toUpperCase()); });
    let i = order.indexOf(key);
    if (i < 0) { i = 0; for (let k = 0; k < key.length; k++) i = (i * 31 + key.charCodeAt(k)) >>> 0; }
    return SPEAKER_COLORS[i % SPEAKER_COLORS.length];
}

// Met à jour durée, statut et dépassement de chaque bloc sans tout reconstruire
function renderBlockStates(tl) {
    if (!state.blocks.length) return;
    const cards = el.blocks.querySelectorAll('.block');
    const target = state.project && state.project.target;
    const laid = layoutTimeline(tl.segs);
    const blockStart = new Map();
    const blockDur = new Map();
    laid.forEach(s => {
        if (s.kind === 'gap') return;
        if (!blockStart.has(s.block)) blockStart.set(s.block, s.at);
        blockDur.set(s.block, (blockDur.get(s.block) || 0) + s.duration);
    });

    cards.forEach((card, i) => {
        const block = state.blocks[i];
        if (!block) return;
        const segs = tl.segs.filter(s => s.block === i && s.kind === 'speech');
        const meta = card.querySelector('.block-meta');
        const pauses = tl.segs.filter(s => s.block === i && s.kind === 'pause').length;
        meta.textContent = `${stripTags(block.text).length} car. · ≈ ${formatDuration(blockDur.get(i) || 0)}` + (pauses ? ` · ${pauses} pause${pauses > 1 ? 's' : ''}` : '');

        const status = card.querySelector('.status');
        status.className = 'status';
        status.title = '';
        if (!isOnline() || !segs.length) { status.hidden = true; }
        else {
            status.hidden = false;
            const pending = segs.some(s => audioPending.has(s.sig));
            const error = segs.map(s => audioErrors.get(s.sig)).find(Boolean);
            const ready = segs.every(s => audioMem.has(s.sig));
            if (pending) { status.textContent = 'Génération…'; status.classList.add('loading'); }
            else if (ready) { status.textContent = 'Audio prêt'; status.classList.add('ready'); }
            else if (error) { status.textContent = 'Erreur'; status.classList.add('error'); status.title = error; }
            else status.textContent = 'À générer';
        }

        const start = blockStart.get(i);
        card.classList.toggle('over-target', !!(target && start !== undefined && start >= target));
    });
}

/* =========================================================
   18. DURÉE CIBLE
   ========================================================= */
function parseDuration(str) {
    const s = (str || '').trim().toLowerCase().replace(',', '.');
    if (!s) return 0;
    let m;
    if ((m = s.match(/^(\d+):(\d{1,2})$/))) return +m[1] * 60 + +m[2];
    if ((m = s.match(/^(?:(\d+(?:\.\d+)?)\s*(?:min|m|mn))?\s*(?:(\d+(?:\.\d+)?)\s*(?:s|sec|secondes?)?)?$/))) {
        const v = (m[1] ? parseFloat(m[1]) * 60 : 0) + (m[2] ? parseFloat(m[2]) : 0);
        return v > 0 ? v : 0;
    }
    return 0;
}

const RATE_LIMITS = { browser: [0.5, 2], openai: [0.5, 2], elevenlabs: [0.7, 1.2], libre: [0.5, 2] };

function refreshTarget(tl, totals) {
    const target = state.project && state.project.target;
    if (!target) {
        el.targetBar.hidden = true;
        el.targetAdjust.disabled = true;
        el.targetMsg.className = 'target-msg';
        el.targetMsg.textContent = "Indique la durée de ta vidéo : l'application te dit si ton texte rentre dedans.";
        return;
    }
    const total = totals.total;
    const scale = Math.max(total, target) * 1.08 || 1;
    el.targetBar.hidden = false;
    el.targetFill.style.width = `${(total / scale) * 100}%`;
    el.targetBar.querySelector('.target-mark').style.left = `${(target / scale) * 100}%`;
    const diff = total - target;
    el.targetFill.classList.toggle('over', diff > 0.5);
    el.targetFill.classList.toggle('close', diff <= 0.5 && diff > -2);
    el.targetAdjust.disabled = !total || Math.abs(diff) < 0.5;

    const kind = totals.exact ? 'exacte' : 'estimée';
    if (!total) {
        el.targetMsg.className = 'target-msg';
        el.targetMsg.textContent = 'Écris ton texte pour voir s\'il rentre dans la durée.';
    } else if (diff > 0.5) {
        el.targetMsg.className = 'target-msg bad';
        el.targetMsg.innerHTML = `Durée ${kind} <b>${formatDuration(total)}</b> pour une cible de <b>${formatDuration(target)}</b> : <b>${formatDuration(diff)} de trop</b>. Les blocs en rouge dépassent.`;
    } else if (diff < -2) {
        el.targetMsg.className = 'target-msg';
        el.targetMsg.innerHTML = `Durée ${kind} <b>${formatDuration(total)}</b> : il reste <b>${formatDuration(-diff)}</b> de marge sur ${formatDuration(target)}.`;
    } else {
        el.targetMsg.className = 'target-msg ok';
        el.targetMsg.innerHTML = `Parfait : <b>${formatDuration(total)}</b> pour une cible de ${formatDuration(target)} ✓`;
    }
}

function adjustSpeedToTarget() {
    const target = state.project.target;
    const totals = timelineTotals(state.timeline);
    const available = target - totals.fixed;
    if (available <= 1) {
        toast('Les pauses et silences prennent déjà toute la durée. Réduis les pauses ou le silence entre blocs.', 'error');
        return;
    }
    const [min, max] = RATE_LIMITS[engine()];
    const ideal = settings.rate * totals.speech / available;
    const newRate = Math.round(clamp(ideal, min, max) * 20) / 20;
    const oldRate = settings.rate;
    settings.rate = newRate;
    el.rate.value = newRate;
    el.rateValue.textContent = `${newRate.toFixed(2)}×`;
    saveSettings();

    const newSpeech = totals.speech * oldRate / newRate;
    const excess = totals.fixed + newSpeech - target;
    if (excess > 0.5) {
        const words = stripTags(workingBlocks().map(b => b.text).join(' ')).split(/\s+/).filter(Boolean).length;
        const cut = Math.ceil(words * excess / newSpeech);
        toast(`Vitesse réglée au maximum conseillé (${newRate.toFixed(2)}×). Il faut encore couper environ ${cut} mot${cut > 1 ? 's' : ''}.`, 'error');
    } else {
        toast(`Vitesse ajustée à ${newRate.toFixed(2)}× pour tenir en ${formatDuration(target)}.` + (isOnline() ? ' Les blocs seront régénérés à cette vitesse.' : ''), 'success');
    }
    scheduleRefresh();
}

/* =========================================================
   19. PERSONNAGES (mode dialogue)
   ========================================================= */
function refreshCast() {
    const on = !!(state.project && state.project.dialogue);
    el.cast.hidden = !on;
    if (!on) return;
    const found = detectCast(el.text.value);
    state.blocks.forEach(b => {
        if (b.speaker && !found.some(c => c.key === b.speaker.toUpperCase())) found.push({ key: b.speaker.toUpperCase(), name: b.speaker });
    });
    el.castList.innerHTML = '';
    if (!found.length) {
        el.castList.innerHTML = '<div class="cast-empty">Écris une réplique par ligne : <code>MARC : Bonjour !</code></div>';
        return;
    }
    const e = engine();
    state.project.cast = state.project.cast || {};
    const cast = state.project.cast[e] = state.project.cast[e] || {};
    const opts = voiceOptions(e);
    const main = mainVoice(e);
    const used = new Set(Object.values(cast));
    const pool = opts.map(([v]) => v).filter(v => v !== main);
    let changed = false;

    found.forEach(({ key, name }) => {
        if (!cast[key] || !opts.some(([v]) => v === cast[key])) {
            const free = pool.find(v => !used.has(v)) || pool[0] || main;
            cast[key] = free;
            used.add(free);
            changed = true;
        }
        const row = document.createElement('div');
        row.className = 'cast-row';
        const label = document.createElement('span');
        label.className = 'cast-name';
        label.textContent = name;
        label.style.color = speakerColor(name);
        const sel = document.createElement('select');
        fillSelect(sel, opts, cast[key]);
        sel.addEventListener('change', () => {
            cast[key] = sel.value;
            saveProjectSoon();
            scheduleRefresh();
        });
        const test = makeButton('▶', 'ghost small', () => previewVoice(sel.value, `Bonjour, je suis ${name}.`), 'Écouter cette voix');
        row.append(label, sel, test);
        el.castList.appendChild(row);
    });
    if (changed) saveProjectSoon();
}

/* =========================================================
   20. RÉGLAGES DE LA VOIX
   ========================================================= */
function onVoicesChanged() {
    fillSelect(el.voice, voiceOptions(), mainVoice());
    refreshCast();
    renderPiperStatus();
    scheduleRefresh();
}

// Menu des langues + état de la voix Piper choisie
function refreshLibrePanel() {
    const langs = libreLanguages();
    const sel = el.libreLang;
    const options = [['', `Toutes les langues (${(libre.voices || []).length})`]]
        .concat(langs.map(([code, name, n]) => [code, `${name} (${n})`]));
    fillSelect(sel, options, settings.libreLang);
    if (settings.libreLang && !langs.some(([c]) => c === settings.libreLang)) sel.value = '';
    renderPiperStatus();
}

// « Voix prête » / « À télécharger » / barre de progression
function renderPiperStatus() {
    const box = el.libreStatus;
    box.innerHTML = '';
    if (engine() !== 'libre') return;
    if (!libre.available) {
        box.appendChild(Object.assign(document.createElement('span'), {
            className: 'piper-state warn', textContent: 'Ton navigateur est trop ancien pour les voix Piper : utilise « Navigateur ».' }));
        return;
    }
    const v = libreVoice(el.voice.value);
    if (!v) return;
    const prog = piper.progress.get(v.stem);
    const state = document.createElement('div');
    state.className = 'piper-state';
    if (prog) {
        const pct = prog.total ? Math.min(100, Math.round((prog.loaded / prog.total) * 100)) : 0;
        state.innerHTML = `<span>Téléchargement de la voix ${escapeHtml(v.name)} : <b>${pct} %</b></span>
            <div class="mini-bar"><div style="width:${pct}%"></div></div>`;
    } else if (piper.cached.has(v.stem)) {
        state.classList.add('ok');
        state.textContent = '✓ Voix prête sur cet appareil (fonctionne même hors ligne)';
    } else {
        const span = document.createElement('span');
        span.textContent = `Téléchargée une seule fois (≈ ${v.size} Mo), puis gardée sur cet appareil.`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ghost small';
        btn.textContent = '⬇ Télécharger maintenant';
        btn.addEventListener('click', () => {
            downloadPiperVoice(v.id).then(() => toast(`Voix ${v.name} prête ✓`, 'success'))
                .catch(err => toast(err.message, 'error'));
        });
        state.append(span, btn);
    }
    box.appendChild(state);
    const lic = document.createElement('div');
    lic.className = 'hint';
    lic.innerHTML = `Licence : ${escapeHtml(v.license)} · <a href="${v.source}" target="_blank" rel="noopener">fiche de la voix</a>`;
    box.appendChild(lic);
}

piper.listeners.add(() => {
    renderPiperStatus();
    // met à jour « ✓ prête » dans les menus sans perdre la sélection
    if (engine() === 'libre') {
        const keep = el.voice.value;
        fillSelect(el.voice, voiceOptions(), keep);
    }
});

function applyEngineUI() {
    const e = engine();
    if (e === 'libre') {
        refreshLibrePanel();
        loadLibreVoices();
    }
    document.body.dataset.engine = e;
    el.engine.value = e;
    el.apiKey.value = isOnline(e) ? getKey(e) : '';
    el.apiKey.type = 'password';
    el.keyToggle.textContent = 'Voir';
    el.keyProvider.textContent = e === 'openai' ? 'OpenAI' : e === 'elevenlabs' ? 'ElevenLabs' : '';
    el.apiKey.placeholder = e === 'openai' ? 'sk-…' : 'Colle ta clé ElevenLabs';
    el.model.value = settings.elevenModel;
    if (e === 'elevenlabs') loadElevenVoices();
    onVoicesChanged();
}

el.engine.addEventListener('change', () => {
    stopPlayback();
    if (el.engine.value === 'libre' && !libre.available) {
        toast('Ton navigateur ne peut pas faire tourner les voix Piper. Mets-le à jour ou utilise « Navigateur ».', 'error');
        el.engine.value = settings.engine;
        return;
    }
    settings.engine = el.engine.value;
    saveSettings();
    applyEngineUI();
    track('engine_select', { engine: settings.engine });
});

el.libreLang.addEventListener('change', () => {
    settings.libreLang = el.libreLang.value;
    saveSettings();
    onVoicesChanged();
});

el.model.addEventListener('change', () => {
    settings.elevenModel = el.model.value;
    saveSettings();
    scheduleRefresh();
});

el.apiKey.addEventListener('change', () => {
    if (!isOnline()) return;
    const key = el.apiKey.value.trim();
    if (key) storage.set(STORE.key(engine()), key);
    else storage.remove(STORE.key(engine()));
    if (engine() === 'elevenlabs') { elevenVoices = null; loadElevenVoices(true); }
    toast(key ? 'Clé enregistrée sur cet appareil' : 'Clé supprimée');
});

el.keyToggle.addEventListener('click', () => {
    const hidden = el.apiKey.type === 'password';
    el.apiKey.type = hidden ? 'text' : 'password';
    el.keyToggle.textContent = hidden ? 'Masquer' : 'Voir';
});

el.keyForget.addEventListener('click', () => {
    storage.remove(STORE.key(engine()));
    el.apiKey.value = '';
    toast('Clé supprimée de cet appareil');
});

el.voice.addEventListener('change', () => {
    renderPiperStatus();
    settings.voices[engine()] = el.voice.value;
    saveSettings();
    refreshCast();
    scheduleRefresh();
});

el.instructions.addEventListener('change', () => {
    settings.instructions = el.instructions.value.trim();
    saveSettings();
    scheduleRefresh();
});

el.normalize.addEventListener('change', () => {
    settings.normalize = el.normalize.checked;
    saveSettings();
    scheduleRefresh();
});

function bindSlider(input, output, key, format, after) {
    input.value = settings[key];
    const show = () => { output.textContent = format(parseFloat(input.value)); };
    show();
    input.addEventListener('input', () => {
        settings[key] = parseFloat(input.value);
        show();
        saveSettings();
        if (after) after();
        scheduleRefresh();
    });
}

if (window.speechSynthesis && 'onvoiceschanged' in speechSynthesis) {
    speechSynthesis.onvoiceschanged = () => {
        loadBrowserVoiceList();
        if (engine() === 'browser') onVoicesChanged();
    };
}

/* =========================================================
   21. TEXTE : saisie, import, balises, aperçu
   ========================================================= */
el.text.addEventListener('input', () => {
    if (!state.project) return;
    state.project.text = el.text.value;
    saveProjectSoon();
    refreshCastSoon();
    if (state.manualEdits) scheduleRefresh();
    else autoSplit();
    if (!state.blocks.length) scheduleRefresh();
});

const refreshCastSoon = debounce(refreshCast, 400);

el.file.addEventListener('change', () => {
    const file = el.file.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        el.text.value = reader.result;
        el.text.dispatchEvent(new Event('input'));
        toast(`« ${file.name} » importé`);
    };
    reader.onerror = () => toast('Impossible de lire ce fichier.', 'error');
    reader.readAsText(file, 'UTF-8');
    el.file.value = '';
});

function insertAtCursor(textarea, snippet, caretOffset) {
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    const before = textarea.value.slice(0, start), after = textarea.value.slice(end);
    const pre = before && !/\s$/.test(before) ? ' ' : '';
    const post = after && !/^\s/.test(after) ? ' ' : '';
    textarea.value = before + pre + snippet + post + after;
    const pos = start + pre.length + (caretOffset === undefined ? snippet.length + post.length : caretOffset);
    textarea.focus();
    textarea.setSelectionRange(pos, pos);
    textarea.dispatchEvent(new Event('input'));
}

el.tagBar.addEventListener('click', e => {
    const btn = e.target.closest('[data-insert]');
    if (!btn) return;
    const snippet = btn.dataset.insert;
    if (snippet === '[voix: ]') {
        const opts = voiceOptions().filter(([v]) => v !== mainVoice()).slice(0, 3).map(([, l]) => l.replace(/\s*\(.*\)$/, ''));
        insertAtCursor(el.text, snippet, snippet.length - 1);
        toast(opts.length ? `Écris le nom d'une voix, par ex. : ${opts.join(', ')}` : "Écris le nom d'une voix");
    } else if (snippet.startsWith('[ton:')) {
        insertAtCursor(el.text, snippet, 6);
    } else {
        insertAtCursor(el.text, snippet);
    }
});

el.helpTags.addEventListener('click', () => openDialog('dlg-help'));

el.dialogue.addEventListener('change', () => {
    state.project.dialogue = el.dialogue.checked;
    saveProjectSoon();
    refreshCast();
    if (!state.manualEdits) splitNow();
    else scheduleRefresh();
    if (el.dialogue.checked) toast('Mode dialogue : écris une réplique par ligne, « NOM : texte ».');
});

el.split.addEventListener('click', () => {
    if (state.manualEdits && !confirm('Redécouper le texte ? Les modifications faites dans les blocs seront perdues.')) return;
    splitNow();
    toast(`${state.blocks.length} bloc${state.blocks.length > 1 ? 's' : ''}`);
});

el.previewBtn.addEventListener('click', () => {
    const tl = buildTimeline(workingBlocks());
    const list = $('preview-list');
    list.innerHTML = '';
    tl.warnings.forEach(w => {
        const d = document.createElement('div');
        d.className = 'notice';
        d.textContent = w;
        list.appendChild(d);
    });
    if (!tl.segs.length) list.innerHTML += '<div class="empty">Rien à lire pour l\'instant.</div>';
    tl.segs.forEach(s => {
        if (s.kind === 'gap') return;
        const d = document.createElement('div');
        if (s.kind === 'pause') {
            d.className = 'preview-pause';
            d.textContent = `⏸ silence de ${s.seconds.toString().replace('.', ',')} s`;
        } else {
            d.className = 'preview-item';
            const info = document.createElement('small');
            info.textContent = `Bloc ${s.block + 1}${s.speaker ? ' · ' + s.speaker : ''} · ${s.voiceName} · ×${effectiveRate(s.rate).toFixed(2)}${s.tone ? ' · ton : ' + s.tone : ''}`;
            d.appendChild(info);
            d.appendChild(document.createTextNode(s.speak));
        }
        list.appendChild(d);
    });
    openDialog('dlg-preview');
});

el.targetInput.addEventListener('input', debounce(() => {
    state.project.target = parseDuration(el.targetInput.value);
    saveProjectSoon();
    scheduleRefresh();
}, 250));
el.targetAdjust.addEventListener('click', adjustSpeedToTarget);

/* =========================================================
   22. THÈME
   ========================================================= */
function applyTheme() {
    if (settings.theme) document.documentElement.dataset.theme = settings.theme;
    else delete document.documentElement.dataset.theme;
}
el.theme.addEventListener('click', () => {
    const isDark = settings.theme ? settings.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    settings.theme = isDark ? 'light' : 'dark';
    applyTheme();
    saveSettings();
});

/* =========================================================
   23. LECTURE (un bloc, ou tout à la suite)
   ========================================================= */
const player = new Audio();
player.preload = 'auto';

const playback = {
    session: 0,
    paused: false,
    active: false,
    onSegment: null,     // (seg) → appelé au début de chaque segment
    onProgress: null,    // (seg, fraction) → avancement dans le segment
    onEnd: null,
};

function setPlayingBlock(index) {
    el.blocks.querySelectorAll('.block').forEach((card, i) => card.classList.toggle('playing', i === index));
    const card = el.blocks.querySelectorAll('.block')[index];
    if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function stopPlayback() {
    playback.session++;
    playback.paused = false;
    playback.active = false;
    el.pause.textContent = '⏸ Pause';
    if (window.speechSynthesis) speechSynthesis.cancel();
    player.pause();
    player.removeAttribute('src');
    try { player.load(); } catch { /* ignoré */ }
    setPlayingBlock(-1);
    if (playback.onEnd) playback.onEnd();
}

async function waitPausable(ms, session, seg) {
    let elapsed = 0;
    while (elapsed < ms) {
        if (session !== playback.session) return;
        await sleep(50);
        if (!playback.paused) elapsed += 50;
        if (seg && playback.onProgress) playback.onProgress(seg, Math.min(1, elapsed / ms));
    }
}

function speakBrowser(seg, session, onProgress) {
    return new Promise((resolve, reject) => {
        if (!window.speechSynthesis) { reject(new Error('Ce navigateur ne sait pas lire à voix haute.')); return; }
        const u = new SpeechSynthesisUtterance(seg.speak);
        const voice = browserVoices.find(v => v.voiceURI === seg.voice);
        if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'fr-FR';
        u.rate = effectiveRate(seg.rate, 'browser');
        u.pitch = settings.pitch;
        u.volume = settings.volume;

        let gotBoundary = false;
        let started = 0;
        let pausedFor = 0, pausedAt = 0;
        const estimate = seg.duration * 1000;
        const timer = setInterval(() => {
            if (session !== playback.session) { clearInterval(timer); return; }
            if (playback.paused) { if (!pausedAt) pausedAt = Date.now(); return; }
            if (pausedAt) { pausedFor += Date.now() - pausedAt; pausedAt = 0; }
            if (!gotBoundary && started && onProgress) onProgress(Math.min(0.98, (Date.now() - started - pausedFor) / estimate));
        }, 100);

        u.onstart = () => { started = Date.now(); };
        u.onboundary = ev => {
            gotBoundary = true;
            if (onProgress && seg.speak.length) onProgress(Math.min(1, ev.charIndex / seg.speak.length));
        };
        const done = () => { clearInterval(timer); resolve(); };
        u.onend = done;
        u.onerror = ev => {
            clearInterval(timer);
            if (ev.error === 'canceled' || ev.error === 'interrupted') resolve();
            else reject(new Error('Erreur de lecture : ' + ev.error));
        };
        speechSynthesis.speak(u);
    });
}

function playUrl(url, session, onProgress) {
    return new Promise((resolve, reject) => {
        let raf = 0;
        const tick = () => {
            if (session !== playback.session) return;
            if (onProgress && player.duration) onProgress(Math.min(1, player.currentTime / player.duration));
            raf = requestAnimationFrame(tick);
        };
        player.src = url;
        player.volume = settings.volume;
        player.onended = () => { cancelAnimationFrame(raf); resolve(); };
        player.onerror = () => { cancelAnimationFrame(raf); reject(new Error('Lecture de l\'audio impossible.')); };
        player.play().then(() => { raf = requestAnimationFrame(tick); }).catch(err => {
            cancelAnimationFrame(raf);
            if (session !== playback.session) resolve(); else reject(err);
        });
    });
}

// Lit à partir d'un bloc. onlyOne = ce bloc seulement.
async function playFrom(startBlock, onlyOne) {
    stopPlayback();
    const session = playback.session;
    playback.active = true;
    await sleep(60); // Chrome ignore parfois speak() juste après cancel()

    const tl = buildTimeline(workingBlocks());
    let segs = tl.segs.filter(s => s.block >= startBlock && (!onlyOne || s.block === startBlock));
    while (segs.length && segs[0].kind === 'gap') segs = segs.slice(1);
    if (!segs.length) { playback.active = false; return; }
    tl.warnings.forEach(w => toast(w));

    const online = isOnline();
    const speechSegs = segs.filter(s => s.kind === 'speech');

    for (let i = 0; i < segs.length; i++) {
        if (session !== playback.session) return;
        const seg = segs[i];
        if (state.blocks.length) setPlayingBlock(seg.block);
        if (playback.onSegment) playback.onSegment(seg);
        try {
            if (seg.kind !== 'speech') {
                await waitPausable(seg.seconds * 1000, session, seg);
            } else if (online) {
                const rec = await ensureAudio(seg);
                // on prépare la suite pendant la lecture
                const next = speechSegs[speechSegs.indexOf(seg) + 1];
                if (next) ensureAudio(next).catch(() => {});
                if (session !== playback.session) return;
                await playUrl(rec.url, session, f => playback.onProgress && playback.onProgress(seg, f));
            } else {
                await speakBrowser(seg, session, f => playback.onProgress && playback.onProgress(seg, f));
            }
            if (playback.onProgress && session === playback.session) playback.onProgress(seg, 1);
        } catch (err) {
            if (session === playback.session) {
                toast(err.message || String(err), 'error');
                stopPlayback();
            }
            return;
        }
    }
    if (session === playback.session) {
        playback.active = false;
        setPlayingBlock(-1);
        if (playback.onEnd) playback.onEnd();
    }
}

function togglePause() {
    if (!playback.active) return;
    playback.paused = !playback.paused;
    if (playback.paused) {
        player.pause();
        if (window.speechSynthesis) speechSynthesis.pause();
    } else {
        if (player.src) player.play().catch(() => {});
        if (window.speechSynthesis) speechSynthesis.resume();
    }
    el.pause.textContent = playback.paused ? '▶ Reprendre' : '⏸ Pause';
    $('pr-pause').textContent = playback.paused ? '▶' : '⏸';
}

el.playAll.addEventListener('click', () => { playFrom(0, false); track('play_all', { engine: engine() }); });
el.stop.addEventListener('click', stopPlayback);
el.pause.addEventListener('click', togglePause);

// Écoute rapide d'une voix (test, personnages, dictionnaire)
async function previewVoice(voice, sample, opts = {}) {
    stopPlayback();
    const session = playback.session;
    playback.active = true;
    const seg = {
        kind: 'speech', engine: engine(), voice,
        speak: opts.raw ? sample : prepareSpeech(sample),
        rate: settings.rate, tone: engine() === 'openai' ? settings.instructions : '',
        model: settings.elevenModel, stability: settings.stability, pitch: settings.pitch,
    };
    seg.duration = seg.speak.length / (CHARS_PER_SECOND * effectiveRate(seg.rate));
    seg.sig = jobSignature(seg);
    try {
        if (isOnline()) {
            const rec = await ensureAudio(seg);
            if (session !== playback.session) return;
            await playUrl(rec.url, session, opts.onProgress);
        } else {
            await speakBrowser(seg, session, opts.onProgress);
        }
    } catch (err) {
        if (session === playback.session) toast(err.message || String(err), 'error');
    } finally {
        if (session === playback.session) playback.active = false;
    }
}

el.voicePreview.addEventListener('click', () => previewVoice(el.voice.value, 'Bonjour, voici un aperçu de cette voix pour ta voix off.'));

/* =========================================================
   24. PROMPTEUR
   ========================================================= */
const prompter = {
    el: $('prompter'), body: $('prompter-body'), text: $('prompter-text'),
    scrolling: false, raf: 0, lastTs: 0, targetTop: null, smoothRaf: 0,
};

function buildPrompterText() {
    const blocks = workingBlocks();
    buildTimeline(blocks); // calcule block.display
    prompter.text.innerHTML = '';
    if (!blocks.length) {
        prompter.text.innerHTML = '<p class="pr-block current">Écris d\'abord un texte.</p>';
        return;
    }
    blocks.forEach((b, i) => {
        const p = document.createElement('p');
        p.className = 'pr-block';
        p.dataset.i = i;
        if (b.speaker) {
            const sp = document.createElement('span');
            sp.className = 'pr-speaker';
            sp.textContent = b.speaker;
            p.appendChild(sp);
        }
        const display = b.display || stripTags(b.text);
        const re = /\S+/g;
        let m, last = 0;
        while ((m = re.exec(display))) {
            if (m.index > last) p.appendChild(document.createTextNode(display.slice(last, m.index)));
            const w = document.createElement('span');
            w.className = 'pr-word';
            w.dataset.s = m.index;
            w.dataset.e = m.index + m[0].length;
            w.textContent = m[0];
            p.appendChild(w);
            last = m.index + m[0].length;
        }
        prompter.text.appendChild(p);
    });
}

function prompterScrollTo(node) {
    const body = prompter.body;
    const rect = node.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    prompter.targetTop = body.scrollTop + rect.top - bodyRect.top - body.clientHeight * 0.38;
    if (!prompter.smoothRaf) {
        const step = () => {
            if (prompter.targetTop === null) { prompter.smoothRaf = 0; return; }
            const d = prompter.targetTop - body.scrollTop;
            if (Math.abs(d) < 1) { body.scrollTop = prompter.targetTop; prompter.targetTop = null; prompter.smoothRaf = 0; return; }
            body.scrollTop += d * 0.12;
            prompter.smoothRaf = requestAnimationFrame(step);
        };
        prompter.smoothRaf = requestAnimationFrame(step);
    }
}

function prompterHighlight(seg, fraction) {
    const blocks = prompter.text.querySelectorAll('.pr-block');
    blocks.forEach((b, i) => {
        b.classList.toggle('current', i === seg.block);
        if (i < seg.block) b.querySelectorAll('.pr-word').forEach(w => { w.classList.add('said'); w.classList.remove('now'); });
    });
    const block = blocks[seg.block];
    if (!block) return;
    if (seg.kind !== 'speech') return;
    const pos = seg.start + fraction * (seg.end - seg.start);
    let now = null;
    block.querySelectorAll('.pr-word').forEach(w => {
        const s = +w.dataset.s, e = +w.dataset.e;
        const said = e <= pos || (fraction >= 1 && e <= seg.end);
        w.classList.toggle('said', said);
        const isNow = !now && s <= pos && pos < e + 1 && fraction < 1 && s >= seg.start;
        w.classList.toggle('now', isNow);
        if (isNow) now = w;
    });
    if (now) prompterScrollTo(now);
}

function openPrompter() {
    stopPlayback();
    buildPrompterText();
    prompter.el.hidden = false;
    prompter.text.style.fontSize = (settings.prompterSize || 40) + 'px';
    prompter.text.classList.toggle('mirror', !!settings.prompterMirror);
    prompter.body.scrollTop = 0;
    $('pr-speed').value = settings.prompterSpeed || 60;
    document.body.style.overflow = 'hidden';
}

function stopPrompterScroll() {
    prompter.scrolling = false;
    cancelAnimationFrame(prompter.raf);
}

function closePrompter() {
    stopPrompterScroll();
    playback.onSegment = playback.onProgress = playback.onEnd = null;
    stopPlayback();
    prompter.el.hidden = true;
    document.body.style.overflow = '';
}

$('pr-voice').addEventListener('click', () => {
    stopPrompterScroll();
    buildPrompterText();
    prompter.body.scrollTop = 0;
    playback.onSegment = seg => prompterHighlight(seg, 0);
    playback.onProgress = prompterHighlight;
    playback.onEnd = null;
    playFrom(0, false);
});

$('pr-scroll').addEventListener('click', () => {
    playback.onSegment = playback.onProgress = playback.onEnd = null;
    stopPlayback();
    prompter.text.querySelectorAll('.pr-block').forEach(b => b.classList.add('current'));
    prompter.scrolling = true;
    prompter.lastTs = 0;
    let carry = 0;
    const step = ts => {
        if (!prompter.scrolling) return;
        if (prompter.lastTs) {
            carry += (ts - prompter.lastTs) / 1000 * (+$('pr-speed').value);
            const whole = Math.floor(carry);
            if (whole) { prompter.body.scrollTop += whole; carry -= whole; }
        }
        prompter.lastTs = ts;
        prompter.raf = requestAnimationFrame(step);
    };
    prompter.raf = requestAnimationFrame(step);
});

$('pr-pause').addEventListener('click', () => {
    if (prompter.scrolling) { stopPrompterScroll(); $('pr-pause').textContent = '▶'; return; }
    if (playback.active) { togglePause(); return; }
    if ($('pr-pause').textContent === '▶') { $('pr-pause').textContent = '⏸'; $('pr-scroll').click(); }
});

$('pr-speed').addEventListener('input', () => { settings.prompterSpeed = +$('pr-speed').value; saveSettings(); });
$('pr-bigger').addEventListener('click', () => {
    settings.prompterSize = Math.min(96, (settings.prompterSize || 40) + 4);
    prompter.text.style.fontSize = settings.prompterSize + 'px';
    saveSettings();
});
$('pr-smaller').addEventListener('click', () => {
    settings.prompterSize = Math.max(20, (settings.prompterSize || 40) - 4);
    prompter.text.style.fontSize = settings.prompterSize + 'px';
    saveSettings();
});
$('pr-mirror').addEventListener('click', () => {
    settings.prompterMirror = !settings.prompterMirror;
    prompter.text.classList.toggle('mirror', settings.prompterMirror);
    saveSettings();
});
$('pr-close').addEventListener('click', closePrompter);
el.openPrompter.addEventListener('click', openPrompter);

/* Raccourcis clavier */
document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!prompter.el.hidden) $('pr-voice').click();
        else playFrom(0, false);
    } else if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
        if (!prompter.el.hidden) closePrompter();
        else stopPlayback();
    } else if (e.key === ' ' && !prompter.el.hidden && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName)) {
        e.preventDefault();
        $('pr-pause').click();
    }
});

/* =========================================================
   25. PROGRESSION
   ========================================================= */
function showProgress(label, done, total) {
    el.progress.hidden = false;
    el.progressBar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    el.progressLabel.textContent = total ? `${label} ${done}/${total}` : label;
}
const hideProgress = () => { el.progress.hidden = true; };

async function withBusy(fn) {
    if (state.busy) { toast('Une opération est déjà en cours…'); return undefined; }
    state.busy = true;
    updateButtons();
    try { return await fn(); }
    catch (err) { console.error(err); toast(err.message || String(err), 'error'); return undefined; }
    finally { state.busy = false; hideProgress(); updateButtons(); }
}

/* =========================================================
   26. GÉNÉRATION DE TOUS LES SEGMENTS
   ========================================================= */
async function generateSegments(segs) {
    const speech = segs.filter(s => s.kind === 'speech');
    const unique = [...new Map(speech.map(s => [s.sig, s])).values()];
    let done = unique.filter(s => audioMem.has(s.sig)).length;
    const todo = unique.filter(s => !audioMem.has(s.sig));
    showProgress('Génération', done, unique.length);
    let index = 0;
    const worker = async () => {
        while (index < todo.length) {
            const seg = todo[index++];
            await ensureAudio(seg);
            done++;
            showProgress('Génération', done, unique.length);
        }
    };
    await Promise.all([worker(), worker()]); // 2 requêtes en parallèle
}

el.generateAll.addEventListener('click', () => withBusy(async () => {
    const tl = buildTimeline(workingBlocks());
    await generateSegments(tl.segs);
    toast('Tous les blocs sont prêts ✓', 'success');
    track('generate_all', { engine: engine(), blocks: workingBlocks().length });
}));

/* =========================================================
   27. MONTAGE AUDIO (voix + silences + musique)
   ========================================================= */
let lastRender = null;

function musicSettings() {
    const p = state.project || {};
    return {
        on: !!(state.music && state.music.buffer),
        volume: p.musicVolume === undefined ? 0.35 : p.musicVolume,
        duck: p.musicDuck === undefined ? 0.75 : p.musicDuck,
    };
}

function renderKey(segs, withMusic) {
    const m = musicSettings();
    return hash(JSON.stringify([segs.map(s => s.kind === 'speech' ? s.sig : `${s.kind}:${s.seconds}`),
        withMusic && m.on ? [state.music.name, state.music.buffer.length, m.volume, m.duck] : 0]));
}

function leadFor(withMusic) { return withMusic && musicSettings().on ? 1.2 : 0.1; }

async function renderAudio(segs, { withMusic = true, label = 'Montage' } = {}) {
    const key = renderKey(segs, withMusic);
    if (lastRender && lastRender.key === key) return lastRender;

    await generateSegments(segs);
    showProgress(label + '…');

    // Durées exactes
    const exact = [];
    for (const s of segs) {
        if (s.kind === 'speech') {
            const buffer = await decodeSig(s.sig);
            exact.push(Object.assign({}, s, { duration: buffer.duration, buffer }));
        } else exact.push(Object.assign({}, s));
    }
    while (exact.length && exact[0].kind === 'gap') exact.shift();

    const m = musicSettings();
    const music = withMusic && m.on;
    const lead = leadFor(withMusic);
    const tail = music ? 2.5 : 0.3;
    const laid = layoutTimeline(exact, lead);
    const end = laid.length ? laid[laid.length - 1].endAt : lead;
    const total = end + tail;

    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OAC(music ? 2 : 1, Math.ceil(total * SAMPLE_RATE), SAMPLE_RATE);
    const master = ctx.createGain();
    if (music) {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -6;
        comp.knee.value = 6;
        comp.ratio.value = 8;
        comp.attack.value = 0.003;
        comp.release.value = 0.2;
        master.connect(comp);
        comp.connect(ctx.destination);
    } else {
        master.connect(ctx.destination);
    }

    laid.forEach(s => {
        if (s.kind !== 'speech') return;
        const src = ctx.createBufferSource();
        src.buffer = s.buffer;
        src.connect(master);
        src.start(s.at);
    });

    if (music) {
        const src = ctx.createBufferSource();
        src.buffer = state.music.buffer;
        src.loop = true;
        const gain = ctx.createGain();
        src.connect(gain);
        gain.connect(master);
        src.start(0);

        const vol = m.volume;
        const low = vol * (1 - m.duck);
        // intervalles où la voix parle (fusionnés si le silence est court)
        const spans = [];
        laid.filter(s => s.kind === 'speech').forEach(s => {
            const last = spans[spans.length - 1];
            if (last && s.at - last[1] < 0.8) last[1] = s.endAt;
            else spans.push([s.at, s.endAt]);
        });
        const points = [[0, 0], [Math.min(0.9, lead * 0.75), vol]];
        spans.forEach(([a, b]) => {
            points.push([a - 0.3, vol], [a, low], [b, low], [b + 0.6, vol]);
        });
        const fadeEnd = total;
        const fadeStart = Math.max(total - 2.2, 0);
        points.push([fadeStart, null], [fadeEnd, 0]);

        const g = gain.gain;
        g.setValueAtTime(0, 0);
        let lastT = 0, lastV = 0;
        points.slice(1).forEach(([t, v]) => {
            if (v === null) v = lastV;            // début du fondu : on garde le niveau du moment
            if (t <= lastT + 0.005) t = lastT + 0.01;
            if (t > total) return;
            g.linearRampToValueAtTime(v, t);
            lastT = t; lastV = v;
        });
    }

    const buffer = await ctx.startRendering();
    lastRender = { key, buffer, laid, lead, total, music };
    return lastRender;
}

/* =========================================================
   28. ENCODAGE (WAV / MP3)
   ========================================================= */
function encodeWav(buffer) {
    const ch = buffer.numberOfChannels, len = buffer.length, rate = buffer.sampleRate;
    const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
    const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF'); data.setUint32(4, 36 + len * ch * 2, true); writeStr(8, 'WAVE');
    writeStr(12, 'fmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
    data.setUint32(24, rate, true); data.setUint32(28, rate * ch * 2, true); data.setUint16(32, ch * 2, true);
    data.setUint16(34, 16, true); writeStr(36, 'data'); data.setUint32(40, len * ch * 2, true);
    const chans = [];
    for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
    let o = 44;
    for (let i = 0; i < len; i++) {
        for (let c = 0; c < ch; c++) {
            const s = clamp(chans[c][i], -1, 1);
            data.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
            o += 2;
        }
    }
    return new Blob([data], { type: 'audio/wav' });
}

let lamePromise = null;
function loadLame() {
    if (window.lamejs) return Promise.resolve(window.lamejs);
    if (!lamePromise) {
        lamePromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = LAMEJS_URL;
            s.onload = () => window.lamejs ? resolve(window.lamejs) : reject(new Error('Encodeur MP3 indisponible'));
            s.onerror = () => { lamePromise = null; reject(new Error('Encodeur MP3 indisponible (pas de connexion ?)')); };
            document.head.appendChild(s);
        });
    }
    return lamePromise;
}

function toInt16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
        const s = clamp(f32[i], -1, 1);
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
}

async function encodeMp3(buffer) {
    const lame = await loadLame();
    const ch = buffer.numberOfChannels;
    const enc = new lame.Mp3Encoder(ch, buffer.sampleRate, ch > 1 ? 192 : 128);
    const left = toInt16(buffer.getChannelData(0));
    const right = ch > 1 ? toInt16(buffer.getChannelData(1)) : null;
    const parts = [];
    const block = 1152 * 40;
    for (let i = 0; i < left.length; i += block) {
        const l = left.subarray(i, i + block);
        const out = right ? enc.encodeBuffer(l, right.subarray(i, i + block)) : enc.encodeBuffer(l);
        if (out.length) parts.push(new Uint8Array(out));
        if ((i / block) % 8 === 0) {
            showProgress(`Encodage MP3 ${Math.round((i / left.length) * 100)} %`);
            await sleep(0);
        }
    }
    const end = enc.flush();
    if (end.length) parts.push(new Uint8Array(end));
    return new Blob(parts, { type: 'audio/mpeg' });
}

async function encodeAudio(buffer, format) {
    if (format === 'mp3') {
        try { return { blob: await encodeMp3(buffer), ext: 'mp3' }; }
        catch (err) {
            console.warn(err);
            toast("L'encodeur MP3 n'a pas pu se charger : le fichier est exporté en WAV (lisible partout).", 'error');
        }
    }
    showProgress('Préparation du WAV…');
    await sleep(0);
    return { blob: encodeWav(buffer), ext: 'wav' };
}

/* =========================================================
   29. EXPORTS
   ========================================================= */
function projectFileName() {
    return safeFileName(state.project ? state.project.name : 'voix-off');
}

el.exportAudio.addEventListener('click', () => withBusy(async () => {
    const tl = buildTimeline(workingBlocks());
    const r = await renderAudio(tl.segs, { withMusic: true });
    const { blob, ext } = await encodeAudio(r.buffer, settings.format);
    saveBlob(blob, `${projectFileName()}.${ext}`);
    toast(`Audio exporté (${formatDuration(r.buffer.duration)}) ✓`, 'success');
    track('export_audio', { format: ext, engine: engine(), music: !!state.music, seconds: Math.round(r.buffer.duration) });
}));

async function exportBlockAudio(index) {
    if (!isOnline()) { toast('Choisis ElevenLabs ou OpenAI pour exporter l\'audio.', 'error'); return; }
    await withBusy(async () => {
        const tl = buildTimeline(workingBlocks());
        const segs = tl.segs.filter(s => s.block === index && s.kind !== 'gap');
        if (!segs.some(s => s.kind === 'speech')) { toast('Ce bloc ne contient rien à lire.'); return; }
        const r = await renderAudio(segs, { withMusic: false, label: 'Préparation' });
        const { blob, ext } = await encodeAudio(r.buffer, settings.format);
        saveBlob(blob, `${projectFileName()}-bloc-${String(index + 1).padStart(2, '0')}.${ext}`);
    });
}

el.format.value = settings.format;
el.format.addEventListener('change', () => { settings.format = el.format.value; saveSettings(); });

el.listenFinal.addEventListener('click', async () => {
    const r = await withBusy(async () => {
        const tl = buildTimeline(workingBlocks());
        return renderAudio(tl.segs, { withMusic: true, label: 'Montage' });
    });
    if (!r) return;
    stopPlayback();
    const session = playback.session;
    playback.active = true;
    if (!r.url) r.url = URL.createObjectURL(encodeWav(r.buffer));
    const blocksLaid = r.laid.filter(s => s.kind !== 'gap');
    try {
        await playUrl(r.url, session, f => {
            const t = f * r.total;
            const cur = blocksLaid.find(s => t >= s.at && t < s.endAt);
            if (cur && state.blocks.length) setPlayingBlock(cur.block);
        });
    } catch (err) { toast(err.message, 'error'); }
    if (session === playback.session) { playback.active = false; setPlayingBlock(-1); }
});

/* ---------- Sous-titres ---------- */
function wrapSubtitle(text, max = 42) {
    if (text.length <= max) return text;
    const words = text.split(' ');
    let best = text, bestScore = Infinity;
    for (let i = 1; i < words.length; i++) {
        const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
        const score = Math.max(a.length, b.length) + (a.length > max || b.length > max ? 100 : 0);
        if (score < bestScore) { bestScore = score; best = a + '\n' + b; }
    }
    return best;
}

function chunkSubtitle(text, max = 84) {
    const out = [];
    const sentences = text.match(/[^.!?…]+[.!?…]+["'»”)]*|[^.!?…]+$/g) || [text];
    let current = '';
    sentences.map(s => s.trim()).filter(Boolean).forEach(s => {
        const candidate = current ? current + ' ' + s : s;
        if (candidate.length <= max) current = candidate;
        else {
            if (current) out.push(current);
            if (s.length <= max) current = s;
            else {
                const parts = splitLong(s, max);
                current = parts.pop();
                out.push(...parts);
            }
        }
    });
    if (current) out.push(current);
    return out;
}

function buildCues(laid) {
    const cues = [];
    laid.forEach(s => {
        if (s.kind !== 'speech' || !s.text) return;
        const chunks = chunkSubtitle(s.text);
        const totalChars = chunks.reduce((n, c) => n + c.length, 0) || 1;
        let t = s.at;
        chunks.forEach(c => {
            const d = (s.endAt - s.at) * (c.length / totalChars);
            cues.push({ start: t, end: t + d, text: c, seg: s, offset: s.text.indexOf(c) });
            t += d;
        });
    });
    return cues;
}

function srtTime(t) {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

el.exportSrt.addEventListener('click', () => {
    const tl = buildTimeline(workingBlocks());
    const online = isOnline();
    let laid, exact;
    const key = renderKey(tl.segs.filter((s, i) => !(i === 0 && s.kind === 'gap')), true);
    if (online && lastRender && lastRender.key === key) { laid = lastRender.laid; exact = true; }
    else {
        const segs = tl.segs.slice();
        while (segs.length && segs[0].kind === 'gap') segs.shift();
        laid = layoutTimeline(segs, online ? leadFor(true) : 0);
        exact = online && segs.every(s => s.exact);
    }
    const cues = buildCues(laid);
    if (!cues.length) { toast('Rien à sous-titrer.'); return; }
    const srt = cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${wrapSubtitle(c.text)}\n`).join('\n');
    saveBlob(new Blob(['﻿' + srt], { type: 'application/x-subrip;charset=utf-8' }), `${projectFileName()}.srt`);
    track('export_srt', { engine: engine() });
    if (exact) toast('Sous-titres exportés, calés sur l\'audio ✓', 'success');
    else if (online) toast('Sous-titres exportés avec un timing estimé. Génère tous les blocs pour un timing exact.');
    else toast('Sous-titres exportés (timing estimé, la voix du navigateur ne peut pas être mesurée).');
});

/* ---------- Musique de fond ---------- */
async function setMusic(blob, name, silent) {
    try {
        const buffer = await decodeBlob(blob);
        state.music = { name, blob, buffer };
        el.musicName.textContent = `${name} · ${formatDuration(buffer.duration)}`;
        el.musicBox.hidden = false;
        el.musicAdd.textContent = 'Changer';
        lastRender = null;
        if (!silent) toast('Musique ajoutée ✓', 'success');
        return true;
    } catch {
        if (!silent) toast('Ce fichier audio ne peut pas être lu par le navigateur.', 'error');
        return false;
    }
}

function clearMusicUI() {
    state.music = null;
    el.musicBox.hidden = true;
    el.musicAdd.textContent = 'Ajouter une musique';
    lastRender = null;
}

el.musicInput.addEventListener('change', async () => {
    const file = el.musicInput.files[0];
    el.musicInput.value = '';
    if (!file) return;
    if (file.size > 60 * 1024 * 1024) { toast('Fichier trop lourd (60 Mo maximum).', 'error'); return; }
    if (await setMusic(file, file.name)) {
        state.project.musicBlob = file;
        state.project.musicName = file.name;
        saveProjectSoon();
    }
});

el.musicRemove.addEventListener('click', () => {
    clearMusicUI();
    delete state.project.musicBlob;
    delete state.project.musicName;
    saveProjectSoon();
});

function bindProjectSlider(input, output, key, def) {
    input.addEventListener('input', () => {
        state.project[key] = parseFloat(input.value);
        output.textContent = `${Math.round(input.value * 100)} %`;
        lastRender = null;
        saveProjectSoon();
    });
    return () => {
        const v = state.project[key] === undefined ? def : state.project[key];
        input.value = v;
        output.textContent = `${Math.round(v * 100)} %`;
    };
}
const syncMusicVolume = bindProjectSlider(el.musicVolume, el.musicVolumeValue, 'musicVolume', 0.35);
const syncMusicDuck = bindProjectSlider(el.musicDuck, el.musicDuckValue, 'musicDuck', 0.75);

/* =========================================================
   30. DICTIONNAIRE (fenêtre)
   ========================================================= */
function renderDictionary() {
    const list = $('dict-list');
    list.innerHTML = '';
    const entries = settings.dictionary || [];
    if (!entries.length) {
        list.innerHTML = '<div class="empty">Aucun mot pour l\'instant.</div>';
        return;
    }
    entries.forEach(([from, to], i) => {
        const row = document.createElement('div');
        row.className = 'dict-row';
        const a = document.createElement('span');
        a.innerHTML = `<b>${escapeHtml(from)}</b>`;
        const arrow = document.createElement('span');
        arrow.className = 'arrow';
        arrow.textContent = '→';
        const b = document.createElement('span');
        b.textContent = to;
        row.append(a, arrow, b,
            makeButton('▶', 'ghost small', () => previewVoice(mainVoice(), to, { raw: false }), 'Écouter'),
            makeButton('✕', 'ghost small', () => {
                settings.dictionary.splice(i, 1);
                dictionaryChanged();
            }, 'Supprimer'));
        list.appendChild(row);
    });
}

function dictionaryChanged() {
    rebuildDictionary();
    saveSettings();
    renderDictionary();
    lastRender = null;
    scheduleRefresh();
}

$('dict-form').addEventListener('submit', e => {
    e.preventDefault();
    const from = $('dict-from').value.trim();
    const to = $('dict-to').value.trim();
    if (!from || !to) return;
    settings.dictionary = (settings.dictionary || []).filter(([a]) => a.toLowerCase() !== from.toLowerCase());
    settings.dictionary.unshift([from, to]);
    $('dict-from').value = '';
    $('dict-to').value = '';
    $('dict-from').focus();
    dictionaryChanged();
    toast(`« ${from} » sera prononcé « ${to} »`);
});

el.openDict.addEventListener('click', () => {
    renderDictionary();
    openDialog('dlg-dict');
    $('dict-from').focus();
});

/* =========================================================
   31. COMPARATEUR DE VOIX
   ========================================================= */
const compareCards = [];

function buildCompare() {
    const grid = $('compare-grid');
    grid.innerHTML = '';
    compareCards.length = 0;
    const opts = voiceOptions();
    const main = mainVoice();
    const others = opts.map(([v]) => v).filter(v => v !== main);
    const defaults = [main, others[0], others[1]].filter(Boolean);
    for (let i = 0; i < 3; i++) {
        const card = document.createElement('div');
        card.className = 'compare-card';
        const sel = document.createElement('select');
        fillSelect(sel, opts, defaults[i] || (opts[i] && opts[i][0]));
        const status = document.createElement('div');
        status.className = 'hint';
        status.textContent = ' ';
        const actions = document.createElement('div');
        actions.className = 'compare-actions';
        const play = makeButton('▶ Écouter', 'success small', () => playCompare(i));
        const choose = makeButton('Choisir', 'ghost small', () => {
            settings.voices[engine()] = sel.value;
            saveSettings();
            onVoicesChanged();
            toast(`Voix principale : ${voiceLabel(sel.value)}`, 'success');
        });
        actions.append(play, choose);
        card.append(sel, status, actions);
        grid.appendChild(card);
        compareCards.push({ card, sel, status });
    }
}

function compareSeg(voice) {
    const seg = {
        kind: 'speech', engine: engine(), voice,
        speak: prepareSpeech($('compare-text').value.trim() || 'Bonjour, voici un test de voix.'),
        rate: settings.rate, tone: engine() === 'openai' ? settings.instructions : '',
        model: settings.elevenModel, stability: settings.stability, pitch: settings.pitch,
    };
    seg.duration = seg.speak.length / (CHARS_PER_SECOND * effectiveRate(seg.rate));
    seg.sig = jobSignature(seg);
    return seg;
}

async function playCompare(i) {
    const c = compareCards[i];
    compareCards.forEach(x => x.card.classList.remove('playing'));
    c.card.classList.add('playing');
    stopPlayback();
    const session = playback.session;
    playback.active = true;
    const seg = compareSeg(c.sel.value);
    try {
        if (isOnline()) {
            c.status.textContent = audioMem.has(seg.sig) ? 'Lecture…' : 'Génération…';
            const rec = await ensureAudio(seg);
            c.status.textContent = `Lecture… (${rec.duration ? rec.duration.toFixed(1).replace('.', ',') + ' s' : ''})`;
            if (session !== playback.session) return;
            await playUrl(rec.url, session);
        } else {
            c.status.textContent = 'Lecture…';
            await speakBrowser(seg, session);
        }
        c.status.textContent = 'Écoutée ✓';
    } catch (err) {
        c.status.textContent = 'Erreur';
        toast(err.message || String(err), 'error');
    } finally {
        c.card.classList.remove('playing');
        if (session === playback.session) playback.active = false;
    }
    return session;
}

$('compare-run').addEventListener('click', async () => {
    const btn = $('compare-run');
    btn.disabled = true;
    try {
        if (isOnline()) {
            compareCards.forEach(c => { c.status.textContent = 'Génération…'; });
            await Promise.all(compareCards.map(c => ensureAudio(compareSeg(c.sel.value))
                .then(() => { c.status.textContent = 'Prête'; })
                .catch(err => { c.status.textContent = 'Erreur'; throw err; })));
        }
        for (let i = 0; i < compareCards.length; i++) {
            const before = playback.session;
            await playCompare(i);
            if (playback.session !== before + 1) break; // arrêté entre-temps
            await sleep(350);
        }
    } catch (err) {
        toast(err.message || String(err), 'error');
    } finally {
        btn.disabled = false;
    }
});

el.openCompare.addEventListener('click', () => {
    const first = stripTags(el.text.value).match(/[^.!?…]+[.!?…]?/);
    $('compare-text').value = first ? first[0].trim().slice(0, 200) : 'Bonjour, et bienvenue dans cette nouvelle vidéo.';
    buildCompare();
    openDialog('dlg-compare');
});
$('dlg-compare').addEventListener('close', stopPlayback);

/* =========================================================
   32. VIDÉO AUDIOGRAMME
   ========================================================= */
const VIDEO_STYLES = {
    violet: { bg: ['#1b1040', '#4b1fa8'], accent: '#b69cff', text: '#ffffff', dim: 'rgba(255,255,255,.55)' },
    nuit: { bg: ['#05122b', '#0f3d6e'], accent: '#5ec8ff', text: '#ffffff', dim: 'rgba(255,255,255,.55)' },
    sable: { bg: ['#f7f0e4', '#e6d2b0'], accent: '#b5651d', text: '#2b2118', dim: 'rgba(43,33,24,.55)' },
    noir: { bg: ['#000000', '#1c1c1c'], accent: '#ffffff', text: '#ffffff', dim: 'rgba(255,255,255,.5)' },
};

const video = { recording: false, abort: false, raf: 0, url: null };

function wrapCanvasText(ctx, text, maxWidth) {
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let line = [];
    words.forEach(w => {
        const test = line.concat(w).join(' ');
        if (ctx.measureText(test).width > maxWidth && line.length) { lines.push(line); line = [w]; }
        else line.push(w);
    });
    if (line.length) lines.push(line);
    return lines;
}

function drawVideoFrame(ctx, W, H, t, opts) {
    const st = VIDEO_STYLES[opts.style] || VIDEO_STYLES.violet;
    const unit = Math.min(W, H) / 720;

    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, st.bg[0]);
    g.addColorStop(1, st.bg[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Titre
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (opts.title) {
        ctx.fillStyle = st.text;
        ctx.font = `800 ${Math.round(40 * unit)}px Inter, "Segoe UI", sans-serif`;
        const lines = wrapCanvasText(ctx, opts.title, W * 0.84).slice(0, 2);
        lines.forEach((l, i) => ctx.fillText(l.join(' '), W / 2, H * 0.12 + i * 50 * unit));
    }

    // Forme d'onde
    const bars = 48;
    const data = opts.freq;
    const cy = opts.subs ? H * 0.42 : H * 0.5;
    const bw = (W * 0.8) / bars;
    ctx.fillStyle = st.accent;
    for (let i = 0; i < bars; i++) {
        const k = Math.abs(i - bars / 2 + 0.5) / (bars / 2);
        const v = data ? Math.min(1, (data[Math.floor(k * data.length * 0.35)] / 255) * 1.15) : 0;
        const h = Math.max(6 * unit, v * H * 0.18 * (1 - k * 0.35));
        const x = W * 0.1 + i * bw + bw * 0.2;
        const r = Math.min(bw * 0.3, h / 2);
        roundRect(ctx, x, cy - h / 2, bw * 0.6, h, r);
    }

    // Sous-titres
    if (opts.subs) {
        const cue = opts.cues.find(c => t >= c.start && t < c.end);
        if (cue) {
            const size = Math.round((W < H ? 46 : 40) * unit);
            ctx.font = `700 ${size}px Inter, "Segoe UI", sans-serif`;
            const lines = wrapCanvasText(ctx, cue.text, W * 0.84);
            const total = cue.text.split(/\s+/).filter(Boolean).length;
            const spoken = Math.floor(((t - cue.start) / (cue.end - cue.start)) * total);
            const lh = size * 1.3;
            const y0 = H * 0.68 - ((lines.length - 1) * lh) / 2;
            let n = 0;
            ctx.textAlign = 'left';
            lines.forEach((words, li) => {
                const full = words.join(' ');
                let x = W / 2 - ctx.measureText(full).width / 2;
                words.forEach(w => {
                    ctx.fillStyle = n === spoken ? st.accent : (n < spoken ? st.text : st.dim);
                    ctx.fillText(w, x, y0 + li * lh);
                    x += ctx.measureText(w + ' ').width;
                    n++;
                });
            });
            ctx.textAlign = 'center';
        }
    }

    // Barre de progression
    const p = clamp(t / opts.total, 0, 1);
    ctx.fillStyle = st.dim;
    ctx.fillRect(W * 0.08, H * 0.93, W * 0.84, 4 * unit);
    ctx.fillStyle = st.accent;
    ctx.fillRect(W * 0.08, H * 0.93, W * 0.84 * p, 4 * unit);
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
}

function videoOptions() {
    const [W, H] = $('video-format').value.split('x').map(Number);
    return { W, H, style: $('video-style').value, title: $('video-title').value.trim(), subs: $('video-subs').checked };
}

function drawVideoPreview() {
    const o = videoOptions();
    const canvas = $('video-canvas');
    canvas.width = o.W;
    canvas.height = o.H;
    const sample = stripTags(el.text.value).split(/\s+/).slice(0, 9).join(' ') || 'Tes sous-titres apparaîtront ici';
    const fake = new Uint8Array(128).map((_, i) => 140 + 90 * Math.sin(i / 5));
    drawVideoFrame(canvas.getContext('2d'), o.W, o.H, 1.5, Object.assign({}, o, {
        freq: fake, total: 6, cues: [{ start: 0, end: 4, text: sample }],
    }));
    canvas.hidden = false;
    $('video-result').hidden = true;
}

['video-format', 'video-style', 'video-title', 'video-subs'].forEach(id => $(id).addEventListener('input', () => {
    if (video.recording) return;
    const o = videoOptions();
    settings.video = { format: $('video-format').value, style: o.style, subs: o.subs };
    saveSettings();
    drawVideoPreview();
}));

el.openVideo.addEventListener('click', () => {
    $('video-format').value = settings.video.format;
    $('video-style').value = settings.video.style;
    $('video-subs').checked = settings.video.subs;
    $('video-title').value = state.project ? state.project.name : '';
    $('video-download').hidden = true;
    openDialog('dlg-video');
    drawVideoPreview();
});

$('dlg-video').addEventListener('close', () => { if (video.recording) video.abort = true; });

function pickVideoMime() {
    if (!window.MediaRecorder) return null;
    // MP4 seulement en H.264 + AAC (lisible partout, iPhone compris), sinon WebM
    const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return list.find(m => MediaRecorder.isTypeSupported(m)) || '';
}

$('video-run').addEventListener('click', async () => {
    if (video.recording) return;
    const mime = pickVideoMime();
    const canvas = $('video-canvas');
    if (mime === null || !canvas.captureStream) {
        toast("Ton navigateur ne sait pas enregistrer de vidéo. Essaie avec Chrome ou Edge récent.", 'error');
        return;
    }
    const r = await withBusy(async () => renderAudio(buildTimeline(workingBlocks()).segs, { withMusic: true }));
    if (!r) return;

    const o = videoOptions();
    canvas.width = o.W;
    canvas.height = o.H;
    canvas.hidden = false;
    $('video-result').hidden = true;
    $('video-download').hidden = true;
    const ctx2d = canvas.getContext('2d');
    const cues = buildCues(r.laid);

    const AC = window.AudioContext || window.webkitAudioContext;
    const actx = new AC();
    const src = actx.createBufferSource();
    src.buffer = r.buffer;
    const analyser = actx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;
    const dest = actx.createMediaStreamDestination();
    src.connect(analyser);
    analyser.connect(dest);
    analyser.connect(actx.destination);

    const stream = canvas.captureStream(30);
    dest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));
    let recorder;
    try {
        recorder = new MediaRecorder(stream, Object.assign({ videoBitsPerSecond: 4000000 }, mime ? { mimeType: mime } : {}));
    } catch {
        recorder = new MediaRecorder(stream);
    }
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };

    video.recording = true;
    video.abort = false;
    $('video-run').disabled = true;
    const freq = new Uint8Array(analyser.frequencyBinCount);
    if (actx.state === 'suspended') await actx.resume();
    recorder.start(500);
    const t0 = actx.currentTime + 0.05;
    src.start(t0);

    const finished = new Promise(resolve => {
        src.onended = () => setTimeout(resolve, 250);
    });
    const loop = () => {
        const t = Math.max(0, actx.currentTime - t0);
        analyser.getByteFrequencyData(freq);
        drawVideoFrame(ctx2d, o.W, o.H, t, Object.assign({}, o, { freq, total: r.total, cues }));
        $('video-run').textContent = `Enregistrement… ${formatDuration(t)} / ${formatDuration(r.total)}`;
        if (video.abort) { try { src.stop(); } catch { /* déjà arrêté */ } return; }
        video.raf = requestAnimationFrame(loop);
    };
    loop();

    await Promise.race([finished, new Promise(res => { const iv = setInterval(() => { if (video.abort) { clearInterval(iv); res(); } }, 200); })]);
    cancelAnimationFrame(video.raf);
    const stopped = new Promise(res => { recorder.onstop = res; });
    recorder.stop();
    await stopped;
    try { await actx.close(); } catch { /* ignoré */ }
    video.recording = false;
    $('video-run').disabled = false;
    $('video-run').textContent = 'Créer la vidéo';
    if (video.abort) { toast('Enregistrement annulé.'); return; }

    const type = (recorder.mimeType || mime || 'video/webm').split(';')[0];
    const blob = new Blob(chunks, { type });
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    if (video.url) URL.revokeObjectURL(video.url);
    video.url = URL.createObjectURL(blob);
    const player2 = $('video-result');
    player2.src = video.url;
    player2.hidden = false;
    canvas.hidden = true;
    const link = $('video-download');
    link.href = video.url;
    link.download = `${projectFileName()}.${ext}`;
    link.hidden = false;
    toast(ext === 'webm' ? 'Vidéo prête (format WebM : accepté par YouTube, TikTok, CapCut…) ✓' : 'Vidéo prête ✓', 'success');
    track('video_created', { format: $('video-format').value, ext });
});

/* =========================================================
   33. PROJETS
   ========================================================= */
function newProject(name, text = '') {
    const now = Date.now();
    return {
        id: uid(), name, text, blocks: null, manualEdits: false, dialogue: false,
        cast: {}, target: 0, musicVolume: 0.35, musicDuck: 0.75, createdAt: now, updatedAt: now,
    };
}

async function saveProjectNow() {
    const p = state.project;
    if (!p) return;
    p.blocks = state.blocks.map(({ id, text, speaker }) => ({ id, text, speaker }));
    p.manualEdits = state.manualEdits;
    p.updatedAt = Date.now();
    await db.put('projects', p);
    storage.set(STORE.project, p.id);
}
const saveProjectSoon = debounce(saveProjectNow, 500);

async function listProjects() {
    const all = (await db.all('projects')) || [];
    return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function refreshProjectSelect() {
    const all = await listProjects();
    el.projectSelect.innerHTML = '';
    all.forEach(p => {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.name;
        el.projectSelect.appendChild(o);
    });
    if (state.project) el.projectSelect.value = state.project.id;
}

function formatTarget(sec) {
    if (!sec) return '';
    const m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return m ? `${m}:${String(s).padStart(2, '0')}` : String(s);
}

async function openProject(p) {
    stopPlayback();
    state.project = p;
    el.text.value = p.text || '';
    el.dialogue.checked = !!p.dialogue;
    el.targetInput.value = formatTarget(p.target);
    if (Array.isArray(p.blocks) && p.blocks.length) {
        state.blocks = p.blocks.map(b => ({ id: b.id || uid(), text: b.text, speaker: b.speaker || null }));
        state.manualEdits = !!p.manualEdits;
    } else {
        state.blocks = splitText(el.text.value, settings.blockSize, !!p.dialogue).map(b => ({ id: uid(), text: b.text, speaker: b.speaker }));
        state.manualEdits = false;
    }
    clearMusicUI();
    syncMusicVolume();
    syncMusicDuck();
    if (p.musicBlob) await setMusic(p.musicBlob, p.musicName || 'musique', true);
    lastRender = null;
    storage.set(STORE.project, p.id);
    renderBlocks();
    refreshCast();
    await refreshProjectSelect();
}

el.projectSelect.addEventListener('change', async () => {
    await saveProjectNow();
    const p = await db.get('projects', el.projectSelect.value);
    if (p) openProject(p);
});

el.projectNew.addEventListener('click', async () => {
    const all = await listProjects();
    const name = prompt('Nom du nouveau projet :', `Projet ${all.length + 1}`);
    if (name === null) return;
    await saveProjectNow();
    const p = newProject(name.trim() || `Projet ${all.length + 1}`);
    await db.put('projects', p);
    await openProject(p);
    el.text.focus();
    toast('Nouveau projet créé');
});

el.projectRename.addEventListener('click', async () => {
    const name = prompt('Nouveau nom du projet :', state.project.name);
    if (!name || !name.trim()) return;
    state.project.name = name.trim();
    await saveProjectNow();
    await refreshProjectSelect();
});

el.projectDelete.addEventListener('click', async () => {
    if (!confirm(`Supprimer le projet « ${state.project.name} » ? Cette action est définitive.`)) return;
    await db.delete('projects', state.project.id);
    let all = await listProjects();
    if (!all.length) {
        const p = newProject('Mon projet');
        await db.put('projects', p);
        all = [p];
    }
    state.project = null;
    await openProject(all[0]);
    toast('Projet supprimé');
});

async function initProjects() {
    let all = await listProjects();
    if (!all.length) {
        // Reprend l'historique de l'ancienne version
        const history = storage.get(STORE.history, []);
        const created = [];
        history.slice().reverse().forEach((text, i) => {
            const words = stripTags(text).split(/\s+/).slice(0, 5).join(' ');
            const p = newProject(words.length > 3 ? words + '…' : `Texte ${i + 1}`, text);
            p.updatedAt = Date.now() - (history.length - i) * 1000;
            created.push(p);
        });
        if (!created.length) created.push(newProject('Mon projet'));
        for (const p of created) await db.put('projects', p);
        all = await listProjects();
    }
    const lastId = storage.get(STORE.project, null);
    const p = all.find(x => x.id === lastId) || all[0];
    await openProject(p);
}

/* =========================================================
   34. CACHE AUDIO / STOCKAGE
   ========================================================= */
async function refreshStorageInfo() {
    const box = el.storageInfo;
    box.innerHTML = '';
    if (!db.persistent) {
        box.textContent = '⚠ Sauvegarde indisponible (navigation privée ?) : tes projets ne seront pas gardés.';
        return;
    }
    const audio = (await db.all('audio')) || [];
    const size = audio.reduce((n, a) => n + (a.blob ? a.blob.size : 0), 0);
    const span = document.createElement('span');
    span.textContent = `Projets enregistrés sur cet appareil · audio en cache : ${(size / 1048576).toFixed(1).replace('.', ',')} Mo `;
    box.appendChild(span);
    if (audio.length) {
        const b = makeButton('Vider', 'link-btn as-btn', async () => {
            if (!confirm("Vider le cache audio ? L'audio déjà généré devra être régénéré (et repayé).")) return;
            await db.clear('audio');
            audioMem.forEach(r => URL.revokeObjectURL(r.url));
            audioMem.clear();
            decodedMem.clear();
            lastRender = null;
            scheduleRefresh();
            refreshStorageInfo();
            toast('Cache audio vidé');
        });
        box.appendChild(b);
    }
}

// Voix Piper téléchargées : taille + bouton pour les supprimer
async function piperStorageLine() {
    const box = $('piper-storage');
    if (!box) return;
    box.innerHTML = '';
    if (!piper.cached.size) return;
    const n = piper.cached.size;
    box.append(`${n} modèle${n > 1 ? 's' : ''} de voix téléchargé${n > 1 ? 's' : ''} `);
    box.appendChild(makeButton('Supprimer', 'link-btn as-btn', async () => {
        if (!confirm('Supprimer les voix téléchargées ? Elles seront retéléchargées à la prochaine utilisation.')) return;
        await clearPiperCache();
        toast('Voix supprimées de cet appareil');
    }));
}
piper.listeners.add(piperStorageLine);

window.addEventListener('beforeunload', () => { saveProjectNow(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) saveProjectNow(); });

/* =========================================================
   35. DÉMARRAGE
   ========================================================= */
// Active les voix Piper si le navigateur sait les faire tourner
async function setupLibreEngine() {
    const ok = await detectLibreServer();
    await loadLibreVoices();
    const opt = el.libreOption;
    opt.disabled = !ok;
    if (ok) {
        if (!savedSettings.engine || (savedSettings.engine === 'browser' && !savedSettings.piperSeen)) settings.engine = 'libre';
        settings.piperSeen = true;
        saveSettings();
    } else {
        opt.textContent = 'Voix Piper — navigateur trop ancien';
        if (settings.engine === 'libre') settings.engine = 'browser';
    }
}

async function init() {
    applyTheme();
    setupConsent();
    rebuildDictionary();
    el.instructions.value = settings.instructions;
    el.normalize.checked = settings.normalize;
    bindSlider(el.rate, el.rateValue, 'rate', v => `${v.toFixed(2)}×`);
    bindSlider(el.pitch, el.pitchValue, 'pitch', v => v.toFixed(1));
    bindSlider(el.stability, el.stabilityValue, 'stability', v => `${Math.round(v * 100)} %`);
    bindSlider(el.volume, el.volumeValue, 'volume', v => `${Math.round(v * 100)} %`, () => { player.volume = settings.volume; });
    bindSlider(el.gap, el.gapValue, 'gap', v => `${v.toFixed(1).replace('.', ',')} s`);
    bindSlider(el.blockSize, el.blockSizeValue, 'blockSize', v => String(v), () => { if (!state.manualEdits) autoSplit(); });
    loadBrowserVoiceList();
    await setupLibreEngine();
    applyEngineUI();
    await initProjects();
    refreshStorageInfo();
    setInterval(refreshStorageInfo, 60000);
}

init().catch(err => {
    console.error(err);
    toast('Erreur au démarrage : ' + (err.message || err), 'error');
});

})();
