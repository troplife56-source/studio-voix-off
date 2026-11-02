/* =========================================================
   Studio Voix Off — moteur Piper dans le navigateur (Web Worker)

   Fait tourner les voix open-source Piper directement sur l'ordinateur
   du visiteur, sans serveur :
   - onnxruntime-web exécute le modèle de voix (.onnx)
   - espeak-ng (compilé en WebAssembly, comme la démo officielle de Piper)
     transforme le texte en phonèmes, dans toutes les langues
   - les modèles viennent de Hugging Face et sont gardés en cache (Cache Storage)
   ========================================================= */
'use strict';

let CONFIG = null;          // envoyé par la page : URL des bibliothèques et des voix
const models = new Map();   // stem → { session, config }
const MAX_MODELS = 1;      // un seul modèle en mémoire à la fois : plus lent à changer, mais tient sur les vieux PC

/* ---------- Chargement des bibliothèques ---------- */
let ortPromise = null;
function loadOrt() {
    if (!ortPromise) {
        ortPromise = (async () => {
            importScripts(CONFIG.ortUrl);
            const ort = self.ort;
            if (!ort) throw new Error('onnxruntime-web introuvable');
            ort.env.wasm.wasmPaths = CONFIG.ortWasmPath;
            ort.env.wasm.numThreads = 1;      // GitHub Pages n'active pas le multi-thread
            ort.env.logLevel = 'error';
            return ort;
        })().catch((err) => { ortPromise = null; throw err; });
    }
    return ortPromise;
}

/* ---------- espeak-ng : texte → phonèmes (méthode de la démo officielle Piper) ---------- */
const AUDIO_OUTPUT_SYNCHRONOUS = 2;
const espeakCHARS_AUTO = 0;
const espeakPHONEMES_IPA = 0x02;
const CLAUSE_TYPE_SENTENCE = 0x00080000;
const CLAUSE_PERIOD = 40 | 0x00000000 | CLAUSE_TYPE_SENTENCE;
const CLAUSE_QUESTION = 40 | 0x00002000 | CLAUSE_TYPE_SENTENCE;
const CLAUSE_EXCLAMATION = 45 | 0x00003000 | CLAUSE_TYPE_SENTENCE;
const CLAUSE_COMMA = 20 | 0x00001000 | 0x00040000;
const CLAUSE_COLON = 30 | 0x00000000 | 0x00040000;
const CLAUSE_SEMICOLON = 30 | 0x00001000 | 0x00040000;
const PUNCTUATION = {
    [CLAUSE_PERIOD]: '.', [CLAUSE_QUESTION]: '?', [CLAUSE_EXCLAMATION]: '!',
    [CLAUSE_COMMA]: ', ', [CLAUSE_COLON]: ': ', [CLAUSE_SEMICOLON]: '; ',
};

let espeakPromise = null;

// Essaie d'abord les fichiers du site (copie locale), sinon ceux de la démo officielle Piper
async function importEspeak() {
    const sources = [];
    if (CONFIG.espeakLocal) sources.push({ url: new URL(CONFIG.espeakLocal, self.location.href).href, base: null });
    if (CONFIG.espeakRemote) sources.push({ url: CONFIG.espeakRemote.js, base: CONFIG.espeakRemote });
    let lastErr = null;
    for (const src of sources) {
        try {
            const mod = await import(src.url);
            return { factory: mod.default || mod, base: src.base, url: src.url };
        } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error('espeak-ng introuvable');
}

function loadEspeak() {
    if (!espeakPromise) {
        espeakPromise = (async () => {
            const { factory, base, url } = await importEspeak();
            const options = {
                locateFile(path) {
                    if (base) return /\.data$/.test(path) ? base.data : base.dir + path;
                    return new URL(path, url).href;
                },
            };
            if (base) options.locateFile = (path) => (/\.data$/.test(path) ? base.data : base.dir + path);
            const E = await factory(options);
            E._espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, 0, 0);
            return E;
        })().catch((err) => { espeakPromise = null; throw err; });
    }
    return espeakPromise;
}

function allocString(E, str) {
    const size = E.lengthBytesUTF8(str) + 1;
    const ptr = E._malloc(size);
    E.stringToUTF8(str, ptr, size);
    return ptr;
}

// Renvoie une liste de phrases en phonèmes IPA (avec la ponctuation, comme Piper)
function espeakPhonemize(E, text, voice) {
    const voicePtr = allocString(E, voice);
    const ok = E._espeak_SetVoiceByName(voicePtr);
    E._free(voicePtr);
    if (ok !== 0 && ok !== undefined) throw new Error(`voix espeak inconnue : ${voice}`);

    const textPtr = allocString(E, text);
    const textPtrPtr = E._malloc(4);
    E.setValue(textPtrPtr, textPtr, '*');
    const terminatorPtr = E._malloc(4);
    const sentences = [];
    let current = '';
    try {
        for (let guard = 0; guard < 10000; guard++) {
            const phonemesPtr = E._espeak_TextToPhonemesWithTerminator(textPtrPtr, espeakCHARS_AUTO, espeakPHONEMES_IPA, terminatorPtr);
            current += E.UTF8ToString(phonemesPtr);
            const terminator = E.getValue(terminatorPtr, 'i32');
            const punct = PUNCTUATION[terminator & 0x000fffff];
            if (punct) current += punct;
            if ((terminator & CLAUSE_TYPE_SENTENCE) === CLAUSE_TYPE_SENTENCE) {
                if (current.trim()) sentences.push(current.trim());
                current = '';
            }
            const next = E.getValue(textPtrPtr, '*');
            if (!next) break;
            E.setValue(textPtrPtr, next, '*');
        }
    } finally {
        E._free(textPtr);
        E._free(textPtrPtr);
        E._free(terminatorPtr);
    }
    if (current.trim()) sentences.push(current.trim());
    return sentences;
}

/* ---------- Téléchargement avec cache ---------- */
async function fetchCached(url, onProgress) {
    let cache = null;
    try { cache = self.caches ? await caches.open(CONFIG.cacheName) : null; } catch { cache = null; }
    if (cache) {
        const hit = await cache.match(url);
        if (hit) return hit.arrayBuffer();
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`téléchargement impossible (${res.status})`);
    const total = parseInt(res.headers.get('Content-Length') || '0', 10);
    if (!(res.body && res.body.getReader && onProgress)) {
        const buffer = await res.arrayBuffer();
        if (cache) {
            try { await cache.put(url, new Response(new Blob([buffer]))); } catch { /* espace insuffisant */ }
        }
        return buffer;
    }
    // Téléchargement par morceaux, puis un seul bloc en mémoire (économe pour les vieux ordinateurs)
    const reader = res.body.getReader();
    let chunks = [];
    let loaded = 0, last = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (loaded - last > 512 * 1024) { last = loaded; onProgress(loaded, total); }
    }
    onProgress(loaded, total || loaded);
    let blob = new Blob(chunks);
    chunks = null;
    if (cache) {
        try { await cache.put(url, new Response(blob)); } catch { /* espace insuffisant : on continue sans cache */ }
    }
    const buffer = await blob.arrayBuffer();
    blob = null;
    return buffer;
}

function modelUrl(stem, ext) {
    const [code, name, quality] = stem.split('-');
    return `${CONFIG.voicesUrl}${code.split('_')[0]}/${code}/${name}/${quality}/${stem}${ext}`;
}

function releaseModel(stem) {
    const m = models.get(stem);
    models.delete(stem);
    try { if (m && m.session.release) m.session.release(); } catch { /* ignoré */ }
}

// Réglages économes en mémoire (indispensables sur les ordinateurs anciens / navigateurs 32 bits)
const SESSION_OPTIONS = {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'basic',
    enableCpuMemArena: false,
    enableMemPattern: false,
    executionMode: 'sequential',
};

const isMemoryError = (err) => /alloc|memory|mémoire|buffer|out of|OOM|RangeError/i.test(String(err && (err.message || err)));

async function loadModel(stem) {
    if (models.has(stem)) {
        const m = models.get(stem);
        models.delete(stem);
        models.set(stem, m);   // le plus récent en dernier
        return m;
    }
    const progress = (loaded, total) => postMessage({ type: 'progress', stem, loaded, total });
    stage('Préparation du moteur de voix…');
    const [ort, configBuf] = await Promise.all([loadOrt(), fetchCached(modelUrl(stem, '.onnx.json'))]);
    const config = JSON.parse(new TextDecoder().decode(configBuf));
    let onnx = new Uint8Array(await fetchCached(modelUrl(stem, '.onnx'), progress));

    // Libère d'abord la place si un autre modèle occupe déjà la mémoire
    while (models.size >= MAX_MODELS) releaseModel(models.keys().next().value);
    stage('Chargement de la voix en mémoire…');
    let session;
    try {
        session = await ort.InferenceSession.create(onnx, SESSION_OPTIONS);
    } catch (err) {
        if (!isMemoryError(err)) throw err;
        // Deuxième essai : on vide tout et on retente une fois
        [...models.keys()].forEach(releaseModel);
        await new Promise((r) => setTimeout(r, 300));
        try {
            session = await ort.InferenceSession.create(onnx, SESSION_OPTIONS);
        } catch (err2) {
            throw new Error(`MEMOIRE: ${err2 && err2.message ? err2.message : err2}`);
        }
    }
    onnx = null;
    const m = { session, config };
    models.set(stem, m);
    postMessage({ type: 'ready', stem });
    stage('');
    return m;
}

function stage(text) { postMessage({ type: 'stage', text }); }

/* ---------- Phonèmes → identifiants (comme piper-phonemize) ---------- */
function phonemesToIds(phonemes, idMap) {
    const ids = [];
    const pad = idMap._ || [0];
    ids.push(...(idMap['^'] || [1]), ...pad);
    for (const ch of Array.from(phonemes.normalize('NFD'))) {
        const id = idMap[ch];
        if (!id) continue;
        ids.push(...id, ...pad);
    }
    ids.push(...(idMap.$ || [2]));
    return ids;
}

function speakerId(config, speaker) {
    if ((config.num_speakers || 1) <= 1) return null;
    const map = config.speaker_id_map || {};
    if (speaker && speaker in map) return map[speaker];
    if (speaker && /^\d+$/.test(speaker)) return +speaker;
    const keys = Object.keys(map);
    return keys.length ? map[keys[0]] : 0;
}

async function synthesize({ stem, speaker, text, rate }) {
    const [{ session, config }, espeak] = await Promise.all([loadModel(stem), loadEspeak()]);
    stage('Fabrication de la voix…');
    const ort = await loadOrt();
    const voice = (config.espeak && config.espeak.voice) || stem.split('_')[0];
    const sentences = espeakPhonemize(espeak, text, voice);
    if (!sentences.length) throw new Error('aucun son à produire pour ce texte');

    const inf = config.inference || {};
    const lengthScale = (inf.length_scale || 1) / Math.min(2, Math.max(0.5, rate || 1));
    const sid = speakerId(config, speaker);
    const sampleRate = (config.audio && config.audio.sample_rate) || 22050;
    const pause = new Float32Array(Math.round(sampleRate * 0.12));
    const parts = [];

    for (const ph of sentences) {
        const ids = phonemesToIds(ph, config.phoneme_id_map || {});
        if (ids.length < 4) continue;
        const feeds = {
            input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
            input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
            scales: new ort.Tensor('float32', Float32Array.from([
                inf.noise_scale ?? 0.667, lengthScale, inf.noise_w ?? 0.8]), [3]),
        };
        if (sid !== null && session.inputNames.includes('sid')) {
            feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(sid)]), [1]);
        }
        const out = await session.run(feeds);
        const tensor = out.output || out[session.outputNames[0]];
        if (parts.length) parts.push(pause);
        parts.push(tensor.data instanceof Float32Array ? tensor.data : Float32Array.from(tensor.data));
    }
    if (!parts.length) throw new Error('aucun son produit');
    return encodeWav(parts, sampleRate);
}

function encodeWav(parts, sampleRate) {
    const length = parts.reduce((n, p) => n + p.length, 0);
    let peak = 0;
    for (const p of parts) for (let i = 0; i < p.length; i++) { const a = Math.abs(p[i]); if (a > peak) peak = a; }
    const gain = peak > 0 ? Math.min(1 / peak, 4) * 0.95 : 1;
    const buf = new ArrayBuffer(44 + length * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, length * 2, true);
    let o = 44;
    for (const p of parts) {
        for (let i = 0; i < p.length; i++) {
            const s = Math.max(-1, Math.min(1, p[i] * gain));
            v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
            o += 2;
        }
    }
    return buf;
}

/* ---------- Messages de la page ---------- */
self.onmessage = async (e) => {
    const msg = e.data || {};
    if (msg.config) CONFIG = msg.config;
    try {
        if (msg.type === 'synth') {
            const wav = await synthesize(msg);
            stage('');
            postMessage({ id: msg.id, ok: true, wav }, [wav]);
        } else if (msg.type === 'load') {
            await loadModel(msg.stem);
            postMessage({ id: msg.id, ok: true });
        } else if (msg.type === 'warmup') {
            await Promise.all([loadOrt(), loadEspeak()]);
            postMessage({ id: msg.id, ok: true });
        }
    } catch (err) {
        stage('');
        const text = (err && err.message) || String(err);
        postMessage({ id: msg.id, ok: false, error: isMemoryError(err) && !/^MEMOIRE/.test(text) ? `MEMOIRE: ${text}` : text, stem: msg.stem });
    }
};

// Exposé pour les tests
self.__piper = { phonemesToIds, speakerId, encodeWav, modelUrl };
