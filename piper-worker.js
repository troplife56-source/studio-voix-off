/* =========================================================
   Studio Voix Off — moteur Piper dans le navigateur (Web Worker)

   Fait tourner les voix open-source Piper directement sur l'ordinateur
   du visiteur, sans serveur :
   - onnxruntime-web exécute le modèle de voix (.onnx)
   - phonemizer (espeak-ng compilé en WebAssembly) transforme le texte en phonèmes
   - les modèles viennent de Hugging Face et sont gardés en cache (Cache Storage)
   ========================================================= */
'use strict';

let CONFIG = null;          // envoyé par la page : URL des bibliothèques et des voix
const models = new Map();   // stem → { session, config }
const MAX_MODELS = 2;

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

let phonemizePromise = null;
function loadPhonemizer() {
    if (!phonemizePromise) {
        phonemizePromise = import(CONFIG.phonemizerUrl).then((m) => {
            const fn = m.phonemize || (m.default && m.default.phonemize) || m.default;
            if (typeof fn !== 'function') throw new Error('phonemizer introuvable');
            return fn;
        }).catch((err) => { phonemizePromise = null; throw err; });
    }
    return phonemizePromise;
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
    let buffer;
    if (res.body && res.body.getReader && onProgress) {
        const reader = res.body.getReader();
        const chunks = [];
        let loaded = 0, last = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            if (loaded - last > 512 * 1024) { last = loaded; onProgress(loaded, total); }
        }
        onProgress(loaded, total || loaded);
        buffer = new Uint8Array(loaded);
        let o = 0;
        for (const c of chunks) { buffer.set(c, o); o += c.length; }
        buffer = buffer.buffer;
    } else {
        buffer = await res.arrayBuffer();
    }
    if (cache) {
        try { await cache.put(url, new Response(buffer.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } })); }
        catch { /* espace insuffisant : on continue sans cache */ }
    }
    return buffer;
}

function modelUrl(stem, ext) {
    const [code, name, quality] = stem.split('-');
    return `${CONFIG.voicesUrl}${code.split('_')[0]}/${code}/${name}/${quality}/${stem}${ext}`;
}

async function loadModel(stem) {
    if (models.has(stem)) {
        const m = models.get(stem);
        models.delete(stem);
        models.set(stem, m);   // le plus récent en dernier
        return m;
    }
    const progress = (loaded, total) => postMessage({ type: 'progress', stem, loaded, total });
    const [ort, configBuf] = await Promise.all([loadOrt(), fetchCached(modelUrl(stem, '.onnx.json'))]);
    const config = JSON.parse(new TextDecoder().decode(configBuf));
    const onnx = await fetchCached(modelUrl(stem, '.onnx'), progress);
    const session = await ort.InferenceSession.create(onnx, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    const m = { session, config };
    models.set(stem, m);
    while (models.size > MAX_MODELS) {
        const oldest = models.keys().next().value;
        const old = models.get(oldest);
        models.delete(oldest);
        try { old.session.release && old.session.release(); } catch { /* ignoré */ }
    }
    postMessage({ type: 'ready', stem });
    return m;
}

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
    const [{ session, config }, phonemize] = await Promise.all([loadModel(stem), loadPhonemizer()]);
    const ort = await loadOrt();
    const voice = (config.espeak && config.espeak.voice) || stem.split('_')[0];
    let sentences = await phonemize(text, voice);
    if (!Array.isArray(sentences)) sentences = [String(sentences || '')];
    sentences = sentences.map((s) => String(s).trim()).filter(Boolean);
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
            postMessage({ id: msg.id, ok: true, wav }, [wav]);
        } else if (msg.type === 'load') {
            await loadModel(msg.stem);
            postMessage({ id: msg.id, ok: true });
        } else if (msg.type === 'warmup') {
            await Promise.all([loadOrt(), loadPhonemizer()]);
            postMessage({ id: msg.id, ok: true });
        }
    } catch (err) {
        postMessage({ id: msg.id, ok: false, error: (err && err.message) || String(err), stem: msg.stem });
    }
};

// Exposé pour les tests
self.__piper = { phonemesToIds, speakerId, encodeWav, modelUrl };
