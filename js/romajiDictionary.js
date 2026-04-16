// Base romaji dictionary and helpers for kana preprocessing.

const SMALL_TSU = 'っ';
const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;
const KATAKANA_SHIFT = 0x60;
const CONSONANT_HEAD = /^[bcdfghjklmnpqrstvwxyz]/i;
const ALPHA_TOKEN = /^[a-z]+$/i;
const SOKUON_PREFIXES = ['xtu', 'ltu', 'xtsu', 'ltsu'];

const normalizeKana = (text = '') => {
    return Array.from(text).map((char) => {
        const code = char.charCodeAt(0);
        if (code >= KATAKANA_START && code <= KATAKANA_END) {
            return String.fromCharCode(code - KATAKANA_SHIFT);
        }
        return char;
    }).join('');
};

// ====================================
// --- 基本のローマ字辞書の生成 ---
// ====================================

// マップインスタンスの生成
const createBaseRomajiMap = () => {
    const map = new Map();
    const addEntry = (kana, variants) => {
        map.set(kana, variants);
    };

    const coreEntries = [
        ['あ', ['a']],
        ['い', ['i']],
        ['う', ['u']],
        ['え', ['e']],
        ['お', ['o']],
        ['か', ['ka', 'ca']],
        ['き', ['ki']],
        ['く', ['ku', 'cu', 'qu']],
        ['け', ['ke']],
        ['こ', ['ko', 'co']],
        ['が', ['ga']],
        ['ぎ', ['gi']],
        ['ぐ', ['gu']],
        ['げ', ['ge']],
        ['ご', ['go']],
        ['さ', ['sa']],
        ['し', ['shi', 'si', 'ci']],
        ['す', ['su']],
        ['せ', ['se', 'ce']],
        ['そ', ['so']],
        ['ざ', ['za']],
        ['じ', ['ji', 'zi']],
        ['ず', ['zu']],
        ['ぜ', ['ze']],
        ['ぞ', ['zo']],
        ['た', ['ta']],
        ['ち', ['chi', 'ti']],
        ['つ', ['tsu', 'tu']],
        ['て', ['te']],
        ['と', ['to']],
        ['だ', ['da']],
        ['ぢ', ['di', 'ji']],
        ['づ', ['du', 'zu']],
        ['で', ['de']],
        ['ど', ['do']],
        ['な', ['na']],
        ['に', ['ni']],
        ['ぬ', ['nu']],
        ['ね', ['ne']],
        ['の', ['no']],
        ['は', ['ha']],
        ['ひ', ['hi']],
        ['ふ', ['fu', 'hu']],
        ['へ', ['he']],
        ['ほ', ['ho']],
        ['ば', ['ba']],
        ['び', ['bi']],
        ['ぶ', ['bu']],
        ['べ', ['be']],
        ['ぼ', ['bo']],
        ['ぱ', ['pa']],
        ['ぴ', ['pi']],
        ['ぷ', ['pu']],
        ['ぺ', ['pe']],
        ['ぽ', ['po']],
        ['ま', ['ma']],
        ['み', ['mi']],
        ['む', ['mu']],
        ['め', ['me']],
        ['も', ['mo']],
        ['や', ['ya']],
        ['ゆ', ['yu']],
        ['よ', ['yo']],
        ['ら', ['ra']],
        ['り', ['ri']],
        ['る', ['ru']],
        ['れ', ['re']],
        ['ろ', ['ro']],
        ['わ', ['wa']],
        ['ゐ', ['wi']],
        ['ゑ', ['we']],
        ['を', ['wo', 'o']],
        ['ん', ['n', 'nn']],
        ['ゔ', ['vu', 'bu']],
        ['ー', ['-']],
    ];

    const smallEntries = [
        ['ぁ', ['xa', 'la']],
        ['ぃ', ['xi', 'li', 'xyi', 'lyi']],
        ['ぅ', ['xu', 'lu', 'xwu', 'lwu']],
        ['ぇ', ['xe', 'le', 'xye', 'lye']],
        ['ぉ', ['xo', 'lo']],
        ['ゃ', ['xya', 'lya']],
        ['ゅ', ['xyu', 'lyu']],
        ['ょ', ['xyo', 'lyo']],
        ['ゎ', ['xwa', 'lwa']],
        ['ゕ', ['xka', 'lka']],
        ['ゖ', ['xke', 'lke']],
    ];

    const yoonEntries = [
        ['きゃ', ['kya']],
        ['きゅ', ['kyu']],
        ['きょ', ['kyo']],
        ['ぎゃ', ['gya']],
        ['ぎゅ', ['gyu']],
        ['ぎょ', ['gyo']],
        ['しゃ', ['sha', 'sya']],
        ['しゅ', ['shu', 'syu']],
        ['しょ', ['sho', 'syo']],
        ['じゃ', ['ja', 'jya', 'zya']],
        ['じゅ', ['ju', 'jyu', 'zyu']],
        ['じょ', ['jo', 'jyo', 'zyo']],
        ['ちゃ', ['cha', 'cya', 'tya']],
        ['ちゅ', ['chu', 'cyu', 'tyu']],
        ['ちょ', ['cho', 'cyo', 'tyo']],
        ['にゃ', ['nya']],
        ['にゅ', ['nyu']],
        ['にょ', ['nyo']],
        ['ひゃ', ['hya']],
        ['ひゅ', ['hyu']],
        ['ひょ', ['hyo']],
        ['びゃ', ['bya']],
        ['びゅ', ['byu']],
        ['びょ', ['byo']],
        ['ぴゃ', ['pya']],
        ['ぴゅ', ['pyu']],
        ['ぴょ', ['pyo']],
        ['みゃ', ['mya']],
        ['みゅ', ['myu']],
        ['みょ', ['myo']],
        ['りゃ', ['rya']],
        ['りゅ', ['ryu']],
        ['りょ', ['ryo']],
    ];

    const extendedEntries = [
        ['しぇ', ['she', 'sye']],
        ['じぇ', ['je', 'zye']],
        ['ちぇ', ['che', 'tye', 'cye']],
        ['てぃ', ['thi', 'tei', 'ti']],
        ['でぃ', ['dhi', 'dei', 'di']],
        ['とぅ', ['twu', 'two', 'tu']],
        ['どぅ', ['dwu', 'dwo', 'du']],
        ['ふぁ', ['fa']],
        ['ふぃ', ['fi']],
        ['ふぇ', ['fe']],
        ['ふぉ', ['fo']],
        ['ふゅ', ['fyu']],
        ['くぁ', ['kwa', 'qa']],
        ['くぃ', ['kwi', 'qi']],
        ['くぇ', ['kwe', 'qe']],
        ['くぉ', ['kwo', 'qo']],
        ['ぐぁ', ['gwa']],
        ['ぐぃ', ['gwi']],
        ['ぐぇ', ['gwe']],
        ['ぐぉ', ['gwo']],
        ['つぁ', ['tsa']],
        ['つぃ', ['tsi']],
        ['つぇ', ['tse']],
        ['つぉ', ['tso']],
        ['ゔぁ', ['va']],
        ['ゔぃ', ['vi']],
        ['ゔぇ', ['ve']],
        ['ゔぉ', ['vo']],
        ['ゔゅ', ['vyu']],
    ];

    [...coreEntries, ...smallEntries, ...yoonEntries, ...extendedEntries].forEach(([kana, variants]) => addEntry(kana, variants));

    '0123456789'.split('').forEach((digit) => addEntry(digit, [digit]));

    const asciiEntries = [
        ['.', ['.']],
        [',', [',']],
        ['/', ['/']],
    ];
    asciiEntries.forEach(([char, variants]) => addEntry(char, variants));

    const punctuationEntries = [
        ['、', [',']],
        ['。', ['.']],
        ['・', ['/']],
    ];
    punctuationEntries.forEach(([kana, variants]) => addEntry(kana, variants));

    // 法律用語もしくはkanaに読み下さなかった漢字 / 記号に対する対応
    // kanaにすべてひらがなで記述できれば不要。
    // 漢字については将来的にすべてkanaに変換する方針とする。
    // 記号については必要に応じて追加する。

    return map;
};

// 生成したインスタンスをBASE_ROMAJI_MAPとして保持
const BASE_ROMAJI_MAP = createBaseRomajiMap();

// 拗音付きかなを1ユニットとして2文字消費させる
const consumeKanaUnit = (text, startIndex) => {
    const char = text[startIndex];
    if (!char) return { unit: '', consumed: 0 };

    const nextChar = text[startIndex + 1];
    if (nextChar) {
        const pair = char + nextChar;
        if (BASE_ROMAJI_MAP.has(pair)) {
            return { unit: pair, consumed: 2 };
        }
    }

    return { unit: char, consumed: 1 };
};

// ====================================
// --- ローマ字候補の生成 ---
// ====================================

// 基本のかなユニットに対するローマ字候補を取得
const getBaseCandidates = (unit) => BASE_ROMAJI_MAP.get(unit) || [];

// 促音付きかなに対して2種類のローマ字候補を生成
const buildSokuonCandidates = (unit) => {
    const targetUnit = unit.slice(1);
    const baseCandidates = getBaseCandidates(targetUnit);
    if (baseCandidates.length === 0) return [];

    const candidateSet = new Set();
    baseCandidates.forEach((candidate) => {
        if (!candidate || !ALPHA_TOKEN.test(candidate)) return;
        const head = candidate[0];
        if (CONSONANT_HEAD.test(head)) {
            candidateSet.add(head + candidate);
        }
        SOKUON_PREFIXES.forEach((prefix) => {
            candidateSet.add(prefix + candidate);
        });
    });

    return Array.from(candidateSet);
};

// ====================================
// --- かな候補の生成 ---
// ====================================

// 拗音、促音を考慮してかなテキストをかなユニットの配列に分解
export const parseKanaUnits = (text = '') => {
    if (!text) return [];
    const normalized = normalizeKana(text);
    const units = [];
    let cursor = 0;

    while (cursor < normalized.length) {
        const char = normalized[cursor];
        if (char === SMALL_TSU && cursor + 1 < normalized.length) {
            const { unit, consumed } = consumeKanaUnit(normalized, cursor + 1);
            units.push(char + unit);
            cursor += 1 + consumed;
            continue;
        }

        const { unit, consumed } = consumeKanaUnit(normalized, cursor);
        units.push(unit);
        cursor += consumed;
    }

    return units;
};

export const getRomajiCandidatesForUnit = (unit) => {
    if (!unit) return [];
    if (unit.startsWith(SMALL_TSU)) {
        return buildSokuonCandidates(unit);
    }
    return getBaseCandidates(unit);
};

export const romajiBaseMap = BASE_ROMAJI_MAP;
