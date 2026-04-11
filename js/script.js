import {typingQuestions as fallbackTypingQuestions} from './question.js';
import {parseKanaUnits, getRomajiCandidatesForUnit} from './romajiDictionary.js';

// ====================================
// グローバル変数・定数の定義
// ====================================

let questionQueue = [];         // 実際に出題される問題のリスト
let currentQuestionIndex = 0;   // 今何問目か
let chunkedText = [];           // 日本語を読点で区切ったリスト
let chunkedKana = [];           // かな読みを読点で区切ったリスト
let unitChunkMap = [];          // 各ユニットが属する文節のインデックス
let currentChunkIndex = 0;      // 今何個目の文節を打っているか
let inputBuffer = '';           // 現在文節でユーザーが打ち終えたローマ字
let chunkCommittedRomaji = '';  // 現在文節で確定済みのローマ字
let gameStartTime = 0;          // 開始タイムスタンプ
let correctKeyCount = 0;        // 正解タイプ数
let missedKeyCount = 0;         // ミスタイプ数
let missedKeysMap = {};         // ミスタイプしたキーを格納するオブジェクト
let isGameActive = false;       // ゲーム進行中フラグ
let resultChartInstance = null; // 結果チャートのインスタンス保持用
let selectedResultPeriod = 'all'; // 結果グラフの表示期間
let selectedLawHistoryPage = 1; // 法律履歴の表示ページ
let currentRunTypedHistory = []; // 現在プレイで確定した問題履歴
let lastGameSettings = null;    // 直近プレイ設定を保持
let resultTimer1 = null;        // 結果画面タイマー1
let resultTransitionToken = 0;  // 結果遷移の世代トークン
const trackedUiAnimations = new Set(); // 明示的に追跡するUIアニメーション
let trackedAnimationSequence = 0;
const trackedAnimationMeta = new WeakMap();
let typingQuestions = [...fallbackTypingQuestions];
let isQuestionDataReady = false;
const questionsJsonUrl = new URL('../data/questions.json', import.meta.url);
const START_FIELD_TO_LABEL_MAP = Object.freeze({
    constitutional: '憲法',
    civil: '民法',
    commercial: '商法',
    civil_procedure: '民事訴訟法',
    administrative: '行政法',
    criminal: '刑法',
    criminal_procedure: '刑事訴訟法',
});
const ALL_START_FIELD_KEYS = Object.freeze(Object.keys(START_FIELD_TO_LABEL_MAP));
const HISTORY_STORAGE_LIMIT = 100;
const LAW_HISTORY_PAGE_SIZE = 10;

const animationTrackerLogger = {
    enabled: true,
    log(event, payload = {}) {
        if (!this.enabled) return;
        console.debug(`[AnimationTracker] ${event}`, payload);
    },
    warn(event, payload = {}) {
        if (!this.enabled) return;
        console.warn(`[AnimationTracker] ${event}`, payload);
    },
};
const typingState = {
    units: [],           // パース済みかなユニット
    currentUnitIdx: 0,   // 現在注目しているユニットのインデックス
    typedBuffer: '',     // 現ユニットの入力済みローマ字
    candidates: [],      // 現ユニットで生き残っている候補
    // 'open'    = 複数候補あり（未確定）
    // 'locked'  = 候補が1つに確定
    // 'pending' = 短い候補で一致済みだが長い候補も残っている（保留）
    resolution: 'open',
    deferredShortPath: null, // 曖昧延長時の短縮形代替パス
};

const typingLogger = {
    enabled: true,
    debug(scope, message, payload = {}) {   
        if (!this.enabled) return;
        console.debug(`[${scope}] ${message}`, payload);
    },
    info(scope, message, payload = {}) {
        if (!this.enabled) return;
        console.info(`[${scope}] ${message}`, payload);
    },
    warn(scope, message, payload = {}) {
        if (!this.enabled) return;
        console.warn(`[${scope}] ${message}`, payload);
    },
};

const normalizeQuestionRecords = (payload) => {
    const list = Array.isArray(payload)
        ? payload
        : (payload && typeof payload === 'object' && Array.isArray(payload.questiondata)
            ? payload.questiondata
            : []);

    return list
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
            text: typeof item.text === 'string' ? item.text.trim() : '',
            kana: typeof item.kana === 'string' ? item.kana.trim() : '',
            field: typeof item.field === 'string' ? item.field.trim() : '',
            source: typeof item.source === 'string' ? item.source.trim() : '',
        }))
        .filter((item) => item.text && item.kana && item.field && item.source);
};

const loadTypingQuestionsFromJson = async () => {
    try {
        const response = await fetch(questionsJsonUrl.toString(), {cache: 'no-store'});
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const payload = await response.json();
        const loaded = normalizeQuestionRecords(payload);
        if (loaded.length === 0) {
            throw new Error('no valid question records in data/questions.json');
        }

        typingQuestions = loaded;
        console.info('[QuestionLoader] loaded questions.json', {count: typingQuestions.length});
    } catch (error) {
        typingQuestions = [...fallbackTypingQuestions];
        console.warn('[QuestionLoader] fallback to question.js', error);
    } finally {
        isQuestionDataReady = true;
    }
};

loadTypingQuestionsFromJson();

const normalizeKanaSource = (kanaSource) => {
    if (Array.isArray(kanaSource)) {
        return kanaSource.filter((kana) => typeof kana === 'string' && kana.trim().length > 0);
    }
    if (typeof kanaSource === 'string' && kanaSource.trim().length > 0) {
        return [kanaSource];
    }
    return [];
};

const resetTypingState = () => {
    typingState.units = [];
    typingState.currentUnitIdx = 0;
    typingState.typedBuffer = '';
    typingState.candidates = [];
    typingState.resolution = 'open';
    typingState.deferredShortPath = null;
};

const initializeTypingState = (units = []) => {
    resetTypingState();
    typingState.units = [...units];
    if (typingState.units.length > 0) {
        typingState.candidates = getRomajiCandidatesForUnit(typingState.units[0]);
        typingState.resolution = typingState.candidates.length === 1 ? 'locked' : 'open';
    }
};

const getNextKeyOptions = () => {
    if (typingState.candidates.length === 0) return [];
    const idx = typingState.typedBuffer.length;
    const options = new Set();
    typingState.candidates.forEach((candidate) => {
        const nextChar = candidate[idx];
        if (nextChar) options.add(nextChar);
    });

    // 保留中は次のユニットの先頭文字もハイライト対象に含める
    if (typingState.resolution === 'pending') {
        const nextUnit = typingState.units[typingState.currentUnitIdx + 1];
        if (nextUnit) {
            const nextCandidates = getRomajiCandidatesForUnit(nextUnit);
            nextCandidates.forEach((c) => {
                if (c[0]) options.add(c[0]);
            });
        }

        // 遅延ショートパス存在時、代替解釈側の次入力文字もハイライト
        // 例: buffer='nn'(ん), 代替は n(ん)+overflow'n'(な開始) → 'a'もハイライト
        if (typingState.deferredShortPath && nextUnit) {
            const nextCandidatesAlt = getRomajiCandidatesForUnit(nextUnit);
            const overflow = typingState.deferredShortPath.overflowNormalized;
            nextCandidatesAlt.forEach((c) => {
                if (c.startsWith(overflow) && c.length > overflow.length) {
                    options.add(c[overflow.length]);
                }
            });
        }
    }

    return Array.from(options);
};

const updateKeyboardHighlights = () => {
    const activeKeys = document.querySelectorAll('.key.active');
    activeKeys.forEach((key) => key.classList.remove('active'));

    const nextChars = getNextKeyOptions();
    nextChars.forEach((char) => {
        const targetId = keyIdMap[char] || char.toUpperCase();
        const keyElement = document.getElementById(targetId);
        if (keyElement) {
            keyElement.classList.add('active');
        }
    });
};

const updateChunkIndexFromState = (force = false) => {
    const mappedIndex = unitChunkMap[typingState.currentUnitIdx];
    const normalizedIndex = typeof mappedIndex === 'number' ? mappedIndex : chunkedText.length;
    if (force || normalizedIndex !== currentChunkIndex) {
        currentChunkIndex = normalizedIndex;
        chunkCommittedRomaji = '';
    }
};

const escapeHtml = (rawText = '') => {
    return String(rawText)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

const getCompletedKanaLengthInCurrentChunk = () => {
    const currentGuideChunk = chunkedKana[currentChunkIndex];
    if (!currentGuideChunk) return 0;

    const safeLimit = Math.min(
        typingState.currentUnitIdx,
        typingState.units.length,
        unitChunkMap.length
    );

    let completedLength = 0;
    for (let idx = 0; idx < safeLimit; idx++) {
        if (unitChunkMap[idx] !== currentChunkIndex) continue;
        completedLength += Array.from(typingState.units[idx] || '').length;
    }

    const chunkLength = Array.from(currentGuideChunk).length;
    return Math.max(0, Math.min(completedLength, chunkLength));
};

const buildCurrentGuideHtml = () => {
    const currentGuideChunk = chunkedKana[currentChunkIndex];
    if (!currentGuideChunk) return '';

    const guideChars = Array.from(currentGuideChunk);
    const completedLength = getCompletedKanaLengthInCurrentChunk();
    const completedText = escapeHtml(guideChars.slice(0, completedLength).join(''));
    const pendingText = escapeHtml(guideChars.slice(completedLength).join(''));

    return `<span class="guide-completed">${completedText}</span><span class="guide-pending">${pendingText}</span>`;
};

const buildKanaChunks = (kanaText) => {
    if (!kanaText) return [];
    return kanaText.split(/([、。])/).reduce((acc, curr) => {
        if (curr.match(/([、。])/) && acc.length > 0) {
            acc[acc.length - 1] += curr;
        } else if (curr !== '') {
            acc.push(curr);
        }
        return acc;
    }, []);
};

const buildUnitsFromChunks = (chunks, fallbackText = '') => {
    const units = [];
    const chunkMap = [];
    if (Array.isArray(chunks) && chunks.length > 0) {
        chunks.forEach((chunk, chunkIdx) => {
            const parsed = parseKanaUnits(chunk);
            parsed.forEach((unit) => {
                units.push(unit);
                chunkMap.push(chunkIdx);
            });
        });
    } else if (fallbackText) {
        const parsed = parseKanaUnits(fallbackText);
        parsed.forEach((unit) => {
            units.push(unit);
            chunkMap.push(0);
        });
    }
    return { units, chunkMap };
};

const primeTypingStateFromKana = (kanaSource, kanaChunks) => {
    const kanaList = normalizeKanaSource(kanaSource);
    const primaryKana = kanaList[0] || '';
    const { units, chunkMap } = buildUnitsFromChunks(
        Array.isArray(kanaChunks) && kanaChunks.length === chunkedText.length ? kanaChunks : [],
        primaryKana
    );
    unitChunkMap = chunkMap;
    initializeTypingState(units);
    updateChunkIndexFromState(true);
    if (typingState.units.length === 0) {
        typingLogger.warn('KanaParser', 'no kana units parsed', { questionIndex: currentQuestionIndex });
    } else {
        typingLogger.debug('KanaParser', 'state primed', { units: typingState.units });
    }
};

const recordMissedKeyExpectation = () => {
    const nextChars = getNextKeyOptions();
    if (nextChars.length === 0) return;
    const target = nextChars[0].toUpperCase();
    missedKeysMap[target] = (missedKeysMap[target] || 0) + 1;
};

const finalizeCurrentUnit = () => {
    const completedValue = typingState.typedBuffer;
    chunkCommittedRomaji += completedValue;
    typingState.resolution = 'open';
    typingState.deferredShortPath = null;
    typingLogger.info('InputEngine', 'unit completed', {
        unit: typingState.units[typingState.currentUnitIdx],
        value: completedValue,
    });
    typingState.currentUnitIdx += 1;
    typingState.typedBuffer = '';

    const nextUnit = typingState.units[typingState.currentUnitIdx];
    if (!nextUnit) {
        typingState.candidates = [];
        typingState.resolution = 'open';
        updateKeyboardHighlights();
        nextQuestion();
        return false;
    }

    typingState.candidates = getRomajiCandidatesForUnit(nextUnit);
    typingState.resolution = typingState.candidates.length === 1 ? 'locked' : 'open';
    updateChunkIndexFromState();
    updateKeyboardHighlights();
    return true;
};

const runKanaParserSmokeTest = () => {
    const sample = 'がっこう';
    const parsed = parseKanaUnits(sample);
    const expected = ['が', 'っこ', 'う'];
    const isMatch = parsed.length === expected.length && parsed.every((unit, idx) => unit === expected[idx]);
    if (!isMatch) {
        console.warn('[KanaParser] unexpected chunking result', { sample, parsed, expected });
    } else {
        console.debug('[KanaParser] smoke test ok', parsed);
    }
};

runKanaParserSmokeTest();

// --- 特殊なidへの対応表
const keyIdMap = {
    '-' : 'Minus',
    '^' : 'Caret',
    '￥' : 'Yen',
    '@' : 'AtMark',
    '[' : 'BracketLeft',
    ';' : 'Semicolon',
    ':' : 'Colon',
    ']' : 'BracketRight',
    ',' : 'Comma',
    '.' : 'Period',
    '/' : 'Slash',
    '\\' : 'Backslash',
};


// ====================================
// HTML要素の取得
// ====================================

const form = document.getElementById('form');
const startErrorElement = document.getElementById('start-error-message');
const startScreen = document.getElementById('start-screen');
const gameScreen = document.getElementById('game-screen');
const resultsScreen = document.getElementById('results-screen');
const delayScreens = document.querySelectorAll('.delay-screen');
const textElement = document.getElementById('question-text');
const charGuideElement = document.getElementById('current-char-guide');
const guideElement = document.getElementById('current-guide');
const inputElement = document.getElementById('user-input');
const fieldElement = document.getElementById('question-field');
const sourceElement  = document.getElementById('question-source'); 
const remainingElement = document.getElementById('question-remaining');
const questionArea = document.getElementById('question-area');
const answerArea = document.getElementById('answer-area');
const keys = document.querySelectorAll('.key');
const statItems = document.querySelectorAll('.stat-item');
const keyboardContainer = document.getElementById('keyboard-container');
const resultPeriodInputs = document.querySelectorAll('input[name="result-period"]');
const resultHistorySection = document.getElementById('result-history-section');
const lawHistoryListElement = document.getElementById('law-history-list');
const lawHistoryPaginationElement = document.getElementById('law-history-pagination');
const lawHistoryEmptyElement = document.getElementById('law-history-empty');
const lawHistoryCardTemplate = document.getElementById('law-history-card-template');
const navContainer = document.querySelector('.nav');

const hasGameScreenDom = Boolean(
    form
    && startScreen
    && gameScreen
    && resultsScreen
    && textElement
    && charGuideElement
    && guideElement
    && inputElement
    && fieldElement
    && sourceElement
    && questionArea
    && answerArea
    && keyboardContainer
);

const SCREEN = {
    START: 'start',
    GAME: 'game',
    RESULTS: 'results',
};

let currentScreen = SCREEN.START;

const GAME_SCREEN_VISUAL_DEFAULTS = Object.freeze({
    questionAreaHeight: '10.25rem',
    questionAreaMargin: '0 .25rem 0 .25rem',
    answerAreaHeight: '10.5rem',
});

const cancelAnimationsOnElement = (element) => {
    if (!element || typeof element.getAnimations !== 'function') return;
    element.getAnimations().forEach((animation) => {
        animation.cancel();
    });
};

const normalizeGameScreenAnimatedStyles = () => {
    questionArea.style.height = GAME_SCREEN_VISUAL_DEFAULTS.questionAreaHeight;
    questionArea.style.margin = '';
    questionArea.style.opacity = '1';
    questionArea.style.transform = 'none';

    answerArea.style.height = GAME_SCREEN_VISUAL_DEFAULTS.answerAreaHeight;
    answerArea.style.opacity = '1';
    answerArea.style.transform = 'none';

    inputElement.style.opacity = '1';

    keys.forEach((key) => {
        key.style.opacity = '1';
        key.style.transform = '';
    });
};

const setVisibleScreen = (screen) => {
    startScreen.style.display = screen === SCREEN.START ? 'block' : 'none';
    gameScreen.style.display = screen === SCREEN.GAME ? 'flex' : 'none';
    resultsScreen.style.display = screen === SCREEN.RESULTS ? 'flex' : 'none';
    currentScreen = screen;
};

const showResultsOverview = (history = getStoredHistory()) => {
    drawResultChart();
    const latest = history.length
        ? history[history.length - 1]
        : { wpm: 0, accuracy: 0, weakKey: '特になし' };
    displayResultStats(latest);
    renderLawHistory(history, 1);
    statItems.forEach((item) => {
        item.style.opacity = 1;
    });
};

const isTransitionPhase = () => !isGameActive && currentScreen === SCREEN.GAME;

const setStartScreenError = (message = '') => {
    if (!startErrorElement) return;
    startErrorElement.textContent = message;
};

const clearStartScreenError = () => {
    setStartScreenError('');
};

const getNormalizedSelectedFieldKeys = (selectedFields = []) => {
    if (!Array.isArray(selectedFields)) return [];
    const safeKeys = selectedFields
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => Object.hasOwn(START_FIELD_TO_LABEL_MAP, value));
    return Array.from(new Set(safeKeys));
};

const filterQuestionsBySelectedFields = (questions, selectedFieldKeys) => {
    if (!Array.isArray(questions) || questions.length === 0) return [];
    const normalizedKeys = getNormalizedSelectedFieldKeys(selectedFieldKeys);
    if (normalizedKeys.length === 0) return [];

    const selectedLabels = new Set(normalizedKeys.map((key) => START_FIELD_TO_LABEL_MAP[key]));
    return questions.filter((question) => selectedLabels.has(question.field));
};

// ====================================
// ページロード時の初期化
// ====================================

// ページ読み込み時に画面状態をリセット
window.addEventListener('load', () => {
    const history = getStoredHistory();
    displaySideStats(history);
    renderLawHistory(history, 1);

    if (!hasGameScreenDom) {
        return;
    }

    const requestedScreen = new URLSearchParams(window.location.search).get('screen');
    if (requestedScreen === SCREEN.RESULTS) {
        setVisibleScreen(SCREEN.RESULTS);
        showResultsOverview(history);
        return;
    }

    setVisibleScreen(SCREEN.START);
    clearStartScreenError();
});

// ====================================
// 履歴取得 / 統計計算 ヘルパー
// ====================================

const STORAGE_KEY = 'law_type_play_data';

const MIN_VALID_KEYS_PER_SEC = 2;
const MIN_VALID_ACCURACY = 70;

const toFiniteNumber = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
};

const isValidResultRecord = (record) => {
    if (!record || typeof record !== 'object') {
        return false;
    }

    const wpm = toFiniteNumber(record.wpm);
    const accuracy = toFiniteNumber(record.accuracy);
    if (wpm === null || accuracy === null) {
        return false;
    }

    return wpm >= MIN_VALID_KEYS_PER_SEC && accuracy >= MIN_VALID_ACCURACY;
};

const normalizeResultRecord = (record) => {
    if (!record || typeof record !== 'object') {
        return null;
    }

    const wpm = toFiniteNumber(record.wpm);
    const accuracy = toFiniteNumber(record.accuracy);
    const dateMs = new Date(record.date).getTime();
    if (wpm === null || accuracy === null || !Number.isFinite(dateMs)) {
        return null;
    }

    const missCount = toFiniteNumber(record.missCount);
    const duration = toFiniteNumber(record.duration);
    const rawQuestionHistory = Array.isArray(record.questionHistory)
        ? record.questionHistory
        : (Array.isArray(record.questions) ? record.questions : []);
    const questionHistory = rawQuestionHistory
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
            field: typeof item.field === 'string' ? item.field.trim() : '',
            source: typeof item.source === 'string' ? item.source.trim() : '',
            text: typeof item.text === 'string' ? item.text.trim() : '',
        }))
        .filter((item) => item.text.length > 0);

    return {
        date: new Date(dateMs).toISOString(),
        wpm,
        missCount: missCount === null ? 0 : missCount,
        accuracy,
        weakKey: typeof record.weakKey === 'string' && record.weakKey.length > 0 ? record.weakKey : '特になし',
        duration: duration === null ? 0 : duration,
        questionHistory,
    };
};

const sanitizeHistoryRecords = (history) => {
    if (!Array.isArray(history)) {
        return [];
    }

    return history
        .map(normalizeResultRecord)
        .filter((record) => record && isValidResultRecord(record));
};

const getStoredHistory = () => {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        const sanitized = sanitizeHistoryRecords(parsed);
        const trimmed = sanitized.slice(-HISTORY_STORAGE_LIMIT);

        // 既存データも読込時に自己修復して外れ値を物理削除する
        if (JSON.stringify(parsed) !== JSON.stringify(trimmed)) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
        }

        return trimmed;
    } catch (e) {
        console.error('storage parse error', e);
        localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
        return [];
    }
};

const flattenLawHistoryEntries = (history) => {
    if (!Array.isArray(history) || history.length === 0) {
        return [];
    }

    const entries = [];
    for (let idx = history.length - 1; idx >= 0; idx--) {
        const record = history[idx];
        if (!record || !Array.isArray(record.questionHistory)) {
            continue;
        }

        record.questionHistory.forEach((question) => {
            if (!question || typeof question !== 'object' || !question.text) {
                return;
            }
            entries.push({
                field: question.field || '分野未設定',
                source: question.source || '出典未設定',
                text: question.text,
            });
        });
    }

    return entries;
};

const buildCombinedLawHistoryEntries = (history = getStoredHistory()) => {
    const persistedEntries = flattenLawHistoryEntries(history);
    const runtimeEntries = currentRunTypedHistory
        .slice()
        .reverse()
        .map((question) => ({
            field: question.field || '分野未設定',
            source: question.source || '出典未設定',
            text: question.text || '',
        }))
        .filter((item) => item.text.length > 0);

    return [...runtimeEntries, ...persistedEntries];
};

const createLawHistoryCardElement = (entry) => {
    if (!lawHistoryCardTemplate || !(lawHistoryCardTemplate instanceof HTMLTemplateElement)) {
        return null;
    }

    const fragment = lawHistoryCardTemplate.content.cloneNode(true);
    const cardElement = fragment.querySelector('.law-history-card');
    if (!cardElement) {
        return null;
    }

    const fieldElement = cardElement.querySelector('.law-history-field');
    const sourceElement = cardElement.querySelector('.law-history-source-text');
    const textElement = cardElement.querySelector('.law-history-text');

    if (fieldElement) fieldElement.textContent = entry.field;
    if (sourceElement) sourceElement.textContent = entry.source;
    if (textElement) textElement.textContent = entry.text;

    return cardElement;
};

const renderLawHistory = (history = getStoredHistory(), requestedPage = selectedLawHistoryPage) => {
    if (!lawHistoryListElement || !lawHistoryPaginationElement || !lawHistoryEmptyElement || !lawHistoryCardTemplate) {
        return;
    }

    const entries = buildCombinedLawHistoryEntries(history);
    if (entries.length === 0) {
        selectedLawHistoryPage = 1;
        lawHistoryListElement.innerHTML = '';
        lawHistoryPaginationElement.innerHTML = '';
        lawHistoryEmptyElement.style.display = 'block';
        return;
    }

    const totalPages = Math.max(1, Math.ceil(entries.length / LAW_HISTORY_PAGE_SIZE));
    const safePage = Math.min(Math.max(Number(requestedPage) || 1, 1), totalPages);
    selectedLawHistoryPage = safePage;

    const startIdx = (safePage - 1) * LAW_HISTORY_PAGE_SIZE;
    const pageEntries = entries.slice(startIdx, startIdx + LAW_HISTORY_PAGE_SIZE);

    lawHistoryEmptyElement.style.display = 'none';
    lawHistoryListElement.replaceChildren();
    pageEntries.forEach((entry) => {
        const card = createLawHistoryCardElement(entry);
        if (card) {
            lawHistoryListElement.appendChild(card);
        }
    });

    lawHistoryPaginationElement.replaceChildren();
    Array.from({length: totalPages}, (_, idx) => idx + 1).forEach((page) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'law-history-page-button';
        if (page === safePage) {
            button.classList.add('is-active');
        }
        button.dataset.page = String(page);
        button.textContent = String(page);
        lawHistoryPaginationElement.appendChild(button);
    });
};

const getHistoryByPeriod = (history, period) => {
    if (!Array.isArray(history) || history.length === 0) {
        return [];
    }

    if (period === '500') {
        return history.slice(-500);
    }
    if (period === '100') {
        return history.slice(-100);
    }
    if (period === '50') {
        return history.slice(-50);
    }
    return history;
};

const initializeResultPeriodSelector = () => {
    if (!resultPeriodInputs.length) {
        return;
    }

    const checkedInput = Array.from(resultPeriodInputs).find((input) => input.checked);
    if (checkedInput) {
        selectedResultPeriod = checkedInput.value;
    }

    resultPeriodInputs.forEach((input) => {
        input.addEventListener('change', () => {
            if (!input.checked) {
                return;
            }

            selectedResultPeriod = input.value;
            if (currentScreen === SCREEN.RESULTS) {
                drawResultChart();
            }
        });
    });
};

const initializeLawHistoryPagination = () => {
    if (!lawHistoryPaginationElement) {
        return;
    }

    lawHistoryPaginationElement.addEventListener('click', (event) => {
        const target = event.target.closest('.law-history-page-button');
        if (!target) {
            return;
        }

        const page = Number(target.dataset.page);
        if (!Number.isFinite(page)) {
            return;
        }

        renderLawHistory(getStoredHistory(), page);
        if (resultHistorySection) {
            resultHistorySection.scrollIntoView({
                behavior: 'smooth',
                block: 'start',
            });
        }
    });
};

const computeHistoryMetrics = (history) => {
    const safeHistory = Array.isArray(history)
        ? history.filter((item) => {
            const dateMs = new Date(item.date).getTime();
            return toFiniteNumber(item.wpm) !== null && Number.isFinite(dateMs);
        })
        : [];

    const count = safeHistory.length;
    if (count === 0) {
        return {
            recentAvgWpm: 0,
            recentChange: 0,
            initialAvgWpm: 0,
            initialChange: 0,
            latest: null,
            totalPlayDays: 0,
            currentStreakDays: 0,
            currentAvgWpm: 0,
            maxWpm: 0,
            cumulativeWeakKeys: '特になし',
        };
    }

    const wpms = safeHistory.map(h => Number(h.wpm));
    const maxWpm = Math.max(...wpms);
    const latest = safeHistory[count - 1];
    const latestWpm = Number(latest.wpm);

    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();

    const toAvg = (arr) => arr.length > 0 ? arr.reduce((a,b) => a + b, 0) / arr.length : 0;
    const pickWindow = (startMs, endMs) => 
        safeHistory
            .map(h => ({ t: new Date(h.date).getTime(), wpm: Number(h.wpm) }))
            .filter(h => h.t >= startMs && h.t <= endMs)
            .map(h => h.wpm);
    
    // 1週間前ウインドウ
    const recentWpms = pickWindow(now - 14 * DAY, now - 7 * DAY);
    const recentAvgWpm = toAvg(recentWpms);
    const recentChange = recentAvgWpm > 0 ? (((latestWpm / recentAvgWpm) - 1) * 100) : 0

    // 1か月前ウインドウ
    const initialWpms = pickWindow(now - 60 * DAY, now - 30 * DAY);
    const initialAvgWpm = toAvg(initialWpms);
    const initialChange = initialAvgWpm > 0 ? (((latestWpm / initialAvgWpm) - 1) * 100) : 0;

    // aside-contents 用データ
    // 総プレイ日数の計算
    const daySet = new Set(
        safeHistory.map(h => {
            const d = new Date(h.date);
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        })
    );

    const totalPlayDays = daySet.size;

    // 連続プレイ日数の計算
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let streak = 0;

    const sortedDays = Array.from(daySet).sort((a,b) => b.localeCompare(a));

    for(const dayStr of sortedDays){
        const d = new Date(dayStr);
        d.setHours(0,0,0,0);
        const diffDays = Math.round((today - d) / (1000 * 60 * 60 * 24));
        if(diffDays === streak){
            streak += 1;
        }else if(diffDays> streak){
            break;
        }
    }

    // 直近の平均スピード
    const currentWpms = pickWindow(now - 7 * DAY, now);
    const currentAvgWpm = toAvg(currentWpms);

    // 履歴内で最も出現回数が多い苦手キーを算出（同率はカンマ区切り）
    const weakKeyCountMap = {};
    safeHistory.forEach((item) => {
        if (typeof item.weakKey !== 'string' || item.weakKey.length === 0 || item.weakKey === '特になし') {
            return;
        }

        item.weakKey
            .split(',')
            .map((key) => key.trim())
            .filter((key) => key.length > 0 && key !== '特になし')
            .forEach((key) => {
                weakKeyCountMap[key] = (weakKeyCountMap[key] || 0) + 1;
            });
    });

    let cumulativeWeakKeys = '特になし';
    const weakKeyEntries = Object.entries(weakKeyCountMap);
    if (weakKeyEntries.length > 0) {
        const maxWeakKeyCount = Math.max(...weakKeyEntries.map(([, value]) => value));
        cumulativeWeakKeys = weakKeyEntries
            .filter(([, value]) => value === maxWeakKeyCount)
            .map(([key]) => key)
            .sort((a, b) => a.localeCompare(b))
            .join(',');
    }

    return {
        recentAvgWpm,
        recentChange,
        initialAvgWpm,
        initialChange,
        latest,
        totalPlayDays,
        currentStreakDays: streak,
        currentAvgWpm,
        maxWpm,
        cumulativeWeakKeys,
    };
};

const displayResultStats = (data) => {
    // html 要素の取得
    const wpmEl = document.getElementById('stat-wpm');
    const accEl = document.getElementById('stat-accuracy');
    const weakEl = document.getElementById('stat-weak-keys');
    const recentAvgEl = document.getElementById('stat-recent-wpm-avg');
    const recentChangeEl = document.getElementById('stat-wpm-recent-change');
    const initialAvgEl = document.getElementById('stat-initial-wpm-avg');
    const initialrecentChangeEl = document.getElementById('stat-wpm-initial-change');
    const maxEl = document.getElementById('stat-wpm-max');

    const applyChangeStyle = (el, val) => {
        if (!el) return;
        let color = '#6b7280';
        if (val > 0) color = '#e65a4d';
        else if (val < 0) color = '#3b82f6';
        el.style.color = color;
    };

    if (wpmEl) wpmEl.textContent = Number(data.wpm).toFixed(2) + ' keys/秒';
    if (accEl) accEl.textContent = Number(data.accuracy).toFixed(1) + ' %';
    if (weakEl) weakEl.textContent = data.weakKey || '特になし';

    const history = getStoredHistory();
    const metrics = computeHistoryMetrics(history);

    if(recentAvgEl) {
        recentAvgEl.textContent = metrics.recentAvgWpm.toFixed(2) + ' keys/秒';
    }
    if (recentChangeEl) {
        const sign = metrics.recentChange > 0 ? '+ ' : '';
        recentChangeEl.textContent = sign + metrics.recentChange.toFixed(1) + ' %';
        applyChangeStyle(recentChangeEl, metrics.recentChange);
    }
    if (initialAvgEl) {
        initialAvgEl.textContent = metrics.initialAvgWpm.toFixed(2) + ' keys/秒';
    }
    if (initialrecentChangeEl) {
        const sign = metrics.initialChange > 0 ? '+ ' : '';
        initialrecentChangeEl.textContent = sign + metrics.initialChange.toFixed(1) + ' %';
        applyChangeStyle(initialrecentChangeEl, metrics.initialChange);
    }
};

// ====================================
// 補助関数
// ====================================

// --- 設定を取得する関数の定義 ---
const getGameSettings = () => {
    //問題形式
    // const format = document.querySelector('input[name="format"]:checked').value;
    //問題数
    const itemcounts = parseInt(document.querySelector('input[name="itemcounts"]:checked').value);
    //各種設定
    const options = [];
    document.querySelectorAll('input[name="setting"]:checked').forEach((checkbox) => {
        options.push(checkbox.value);
    });

    const selectedFields = [];
    document.querySelectorAll('input[name="field"]:checked').forEach((checkbox) => {
        selectedFields.push(checkbox.value);
    });

    return{
        // mode: format,
        questionCounts: itemcounts,
        settings: options,
        selectedFields,
    };
};

// --- タイプべきキーのハイライト ---
const highlightNextKeys = () => {
    updateKeyboardHighlights();
};

// --- 残り問題数の表示更新 ---
const updateRemainingQuestionCount = (forcedValue = null) => {
    if(!remainingElement) return;

    if(forcedValue !== null){
        remainingElement.textContent = `残り${forcedValue}問`;
        return;
    }

    if(!isGameActive || questionQueue.length === 0){
        remainingElement.textContent = '';
        return;
    }

    const remaining = Math.max(questionQueue.length - currentQuestionIndex, 0);
    remainingElement.textContent = `残り${remaining}問`;
};

// --- ミスタイプしたキーのハイライト ---
const highlightMissedKey = (char) => {
    // id の取得
    const targetId = keyIdMap[char] || char.toUpperCase();
    const targetElement = document.getElementById(targetId);

    // keyframs, options の定義 / アニメーションの実行
    if(targetElement){
        const keyframes = [
            {backgroundColor: 'red', offset: 0},
            {backgroundColor: 'white', offset: 1},
        ];
        const options = {
            duration: 200,
            iterations: 2,
        }
        targetElement.animate(keyframes, options);
    }
};

// --- localStrageへの保存 ---
const saveToLocalStorage = (data) => {
    const normalizedData = normalizeResultRecord(data);
    if (!normalizedData || !isValidResultRecord(normalizedData)) {
        return false;
    }

    const history = getStoredHistory();
    history.push(normalizedData);
    const trimmedHistory = history.slice(-HISTORY_STORAGE_LIMIT);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmedHistory));
    return true;
};

const trackAnimation = (animation, label = 'anonymous') => {
    if (!animation) return null;

    const id = ++trackedAnimationSequence;
    trackedAnimationMeta.set(animation, {
        id,
        label,
        startedAt: performance.now(),
        state: 'running',
    });

    trackedUiAnimations.add(animation);
    animationTrackerLogger.log('tracked', {
        id,
        label,
        activeCount: trackedUiAnimations.size,
    });

    animation.finished
        .then(() => {
            const meta = trackedAnimationMeta.get(animation) || {};
            trackedAnimationMeta.set(animation, {
                ...meta,
                finishedAt: performance.now(),
                state: 'finished',
            });
            animationTrackerLogger.log('finished', {
                id,
                label,
                activeCount: trackedUiAnimations.size,
            });
        })
        .catch((error) => {
            const meta = trackedAnimationMeta.get(animation) || {};
            trackedAnimationMeta.set(animation, {
                ...meta,
                finishedAt: performance.now(),
                state: error?.name === 'AbortError' ? 'canceled' : 'error',
            });
            animationTrackerLogger.log('ended-with-error', {
                id,
                label,
                reason: error?.name || 'unknown',
                activeCount: trackedUiAnimations.size,
            });
        });

    return animation;
};

const cancelTrackedUiAnimations = () => {
    animationTrackerLogger.log('cancel-batch-start', {
        activeCount: trackedUiAnimations.size,
    });

    trackedUiAnimations.forEach((animation) => {
        const meta = trackedAnimationMeta.get(animation) || {};
        try {
            animation.cancel();
            animationTrackerLogger.log('cancel-requested', {
                id: meta.id || 'unknown',
                label: meta.label || 'unknown',
            });
        } catch (e) {
            animationTrackerLogger.warn('cancel-failed', {
                id: meta.id || 'unknown',
                label: meta.label || 'unknown',
                reason: e?.message || e,
            });
        }
    });

    trackedUiAnimations.clear();
    animationTrackerLogger.log('cancel-batch-cleared', {
        activeCount: trackedUiAnimations.size,
    });
};

const dumpTrackedUiAnimations = () => {
    const rows = [];
    trackedUiAnimations.forEach((animation) => {
        const meta = trackedAnimationMeta.get(animation) || {};
        rows.push({
            id: meta.id || 'unknown',
            label: meta.label || 'unknown',
            state: meta.state || 'unknown',
            playState: animation.playState,
            pending: animation.pending,
            currentTime: animation.currentTime,
        });
    });

    animationTrackerLogger.log('snapshot', { activeCount: rows.length });
    if (rows.length > 0) {
        console.table(rows);
    } else {
        console.debug('[AnimationTracker] no active tracked animations');
    }
    return rows;
};

if (typeof window !== 'undefined') {
    window.lawTypeAnimationDebug = {
        dumpTrackedUiAnimations,
        setEnabled(enabled) {
            animationTrackerLogger.enabled = !!enabled;
            console.info(`[AnimationTracker] logging ${animationTrackerLogger.enabled ? 'enabled' : 'disabled'}`);
        },
    };
}

const invalidateResultTransitions = () => {
    resultTransitionToken += 1;
    if(resultTimer1){
        clearTimeout(resultTimer1);
        resultTimer1 = null;
    }
};

const resetGameScreenVisualState = (prepareForStart = false) => {
    cancelTrackedUiAnimations();

    // 前回演出の残留アニメーションをすべて解除する
    delayScreens.forEach((screen) => {
        cancelAnimationsOnElement(screen);
    });

    cancelAnimationsOnElement(questionArea);

    cancelAnimationsOnElement(answerArea);

    keys.forEach((key) => {
        cancelAnimationsOnElement(key);
    });

    cancelAnimationsOnElement(inputElement);

    statItems.forEach((item) => {
        cancelAnimationsOnElement(item);
        item.style.opacity = '';
    });

    // 次プレイ開始時の基準値を毎回明示して、前回のforwards効果の残留を断つ
    normalizeGameScreenAnimatedStyles();

    // question/answer は delayScreens に含まれるため、最後に初期表示状態をまとめて適用する
    delayScreens.forEach((screen) => {
        if (prepareForStart) {
            screen.style.opacity = '0';
            screen.style.transform = 'scale(0)';
        } else {
            screen.style.opacity = '';
            screen.style.transform = '';
        }
    });
};

// ====================================
// ゲーム開始 (startGame)
// ====================================

const startGame = (config) => {
    if (!isQuestionDataReady) {
        console.warn('[QuestionLoader] question data is still loading');
        return;
    }
    if (!Array.isArray(typingQuestions) || typingQuestions.length === 0) {
        console.warn('[QuestionLoader] no question data available');
        return;
    }
    clearStartScreenError();

    const selectedFieldKeys = getNormalizedSelectedFieldKeys(config?.selectedFields ?? ALL_START_FIELD_KEYS);
    if (selectedFieldKeys.length === 0) {
        setStartScreenError('少なくとも1科目を選択してください。');
        return;
    }

    const filteredQuestions = filterQuestionsBySelectedFields(typingQuestions, selectedFieldKeys);
    if (filteredQuestions.length === 0) {
        setStartScreenError('選択した科目に該当する問題がありません。');
        return;
    }

    // staleな結果遷移を必ず無効化
    invalidateResultTransitions();

    // 多重起動を禁止
    if (isGameActive || currentScreen !== SCREEN.START) {
        return;
    }

    // 終了演出(fill: forwards)が残ると初期表示が崩れるため、開始前に強制リセット
    resetGameScreenVisualState(true);

    isGameActive = true;        // ゲーム開始フラグ
    guideElement.style.display = 'block';

    lastGameSettings = JSON.parse(JSON.stringify(config));  // 直近の設定を保持
    
    console.log("開始設定", config); // 設定の取得・反映確認

    correctKeyCount = 0;
    missedKeyCount = 0;
    missedKeysMap = {};
    currentRunTypedHistory = [];
    gameStartTime = Date.now();
    renderLawHistory(getStoredHistory(), 1);

    // if(config.settings.includes('roman-letters-represent')){
    //     console.log("ローマ字を表示します");
    // }
    if(keyboardContainer){
        if(config.settings.includes('keyboard-represent')){
            keyboardContainer.style.visibility = 'visible';
        } else {
            keyboardContainer.style.visibility = 'hidden';
        }
    }

    // 問題の出題
    // 問題をシャッフル
    const shuffleArray = (array) => {
        const cloneArray = [...array];
        for(let i = cloneArray.length - 1; i > 0; i--){
            const rand = Math.floor(Math.random() * (i + 1));
            [cloneArray[i], cloneArray[rand]] = [cloneArray[rand], cloneArray[i]];
        };
        return cloneArray;
    }
    const shuffledQuestions = shuffleArray(filteredQuestions);

    // 問題をスライス
    const count = Math.min(shuffledQuestions.length, config.questionCounts);
    questionQueue = shuffledQuestions.slice(0, count);

    // カウンターをリセット
    currentQuestionIndex = 0;

    // 最初の問題を表示
    setupQuestionData();
    updateQuestionDisplay();

    // ディスプレイ関連
    setVisibleScreen(SCREEN.GAME);

    // 直前に与えた初期スタイルを確定させ、初回フレーム飛びで遅延表示が崩れるのを防ぐ
    gameScreen.offsetHeight;
    
    // 問題欄、回答欄の遅延出現
    const keyframes = [
        {opacity: 0, transform: 'scale(0)'},
        {opacity: 1, transform: 'scale(1)'},
    ];
    const options = {
        duration: 250,
        delay: 500,
        fill: 'forwards',
    };

    for(const screen of delayScreens){
        trackAnimation(screen.animate(keyframes, options), `start-delay:${screen.id || 'delay-screen'}`);
    }
};

// ====================================
// データ処理・ゲーム初期化 (setupQuestionData)
// ====================================

const setupQuestionData = () => {
    const currentQuestion = questionQueue[currentQuestionIndex];
    // 日本語を句読点で分割
    chunkedText = currentQuestion.text.split(/([、。])/).reduce((acc, curr, i, arr) => {
        if(curr.match(/([、。])/) && acc.length > 0){
            acc[acc.length - 1] += curr;
        }else if(curr !== ''){
            acc.push(curr);
        }
        return acc;
    },[]);
    
    //インデックスのリセット
    currentChunkIndex = 0;
    inputBuffer = '';
    chunkCommittedRomaji = '';
    const kanaVariants = normalizeKanaSource(currentQuestion.kana);
    const primaryKana = kanaVariants[0] || '';
    chunkedKana = buildKanaChunks(primaryKana);
    if(chunkedKana.length !== chunkedText.length){
        typingLogger.warn('KanaParser', 'chunk length mismatch', {
            textChunks: chunkedText.length,
            kanaChunks: chunkedKana.length,
            questionId: currentQuestionIndex,
        });
    }
    primeTypingStateFromKana(kanaVariants, chunkedKana);
    updateKeyboardHighlights();
};

// ====================================
// 入力エンジン (handleInput)
// ====================================

// 入力を小文字に統一する関数
const normalizeInputChar = (char) => {
    if (typeof char !== 'string' || char.length === 0) return '';
    // test() : ()内のオブジェクトが正規表現にマッチするかを判定(ture / false)
    if (/[a-z]/i.test(char)) return char.toLowerCase();
    return char;
};


// ============================================================
// 保留状態の解決（「ん」の 'n' / 'nn' 表記ゆれ対応）

// 短い候補（'n'）で一致済みだが長い候補（'nn'）も残っている場合に、次のキー入力を見てどちらで確定するかを判定する。
// 曖昧ケース（延長も次ユニット開始も可能）では、延長しつつ短縮形の代替パス(deferredShortPath)を保存し、さらに次の文字で決定する。 ex)「きんない」→ kinnai(n+na) / kinnnai(nn+na) どちらも許容
// ============================================================
const resolvePendingCompletion = (normalizedChar, originalChar) => {
    typingState.resolution = 'open';
    const savedShortPath = typingState.deferredShortPath;
    typingState.deferredShortPath = null;

    // 次のユニットの候補先頭文字と一致するか確認
    const nextUnit = typingState.units[typingState.currentUnitIdx + 1];
    let charStartsNextUnit = false;
    if (nextUnit) {
        const nextCandidates = getRomajiCandidatesForUnit(nextUnit);
        charStartsNextUnit = nextCandidates.some((c) => c.startsWith(normalizedChar));
    }

    // 現在のバッファを延長できるか確認
    const tentativeBuffer = typingState.typedBuffer + normalizedChar;
    const extendedCandidates = typingState.candidates.filter((c) => c.startsWith(tentativeBuffer));
    const canExtend = extendedCandidates.length > 0;

    // ─── 遅延ショートパスの解決 ───
    // 前回、延長(nn)と次ユニット開始(n→な)の両方が可能だったため延長しつつ短縮形の代替を保存していた。今回の文字で最終決定する。
    if (savedShortPath) {
        // 今回の文字が次ユニットを新たに開始できる → 延長形(nn)で確定
        if (charStartsNextUnit) {
            typingLogger.debug('InputEngine', 'deferred → extended form', {
                finalized: typingState.typedBuffer,
                nextChar: normalizedChar,
            });
            const staysOnCurrentQuestion = finalizeCurrentUnit();
            if (!staysOnCurrentQuestion) return;
            handleInput(originalChar);
            return;
        }
        // そうでなければ → 短縮形(n)に巻き戻し、溢れ文字+今回の文字を再処理
        typingLogger.debug('InputEngine', 'deferred → short form', {
            revertedTo: savedShortPath.shortBuffer,
            overflowChar: savedShortPath.overflowChar,
            currentChar: normalizedChar,
        });
        correctKeyCount--; // 曖昧延長時のカウントを取り消し
        typingState.typedBuffer = savedShortPath.shortBuffer;
        const staysOnCurrentQuestion = finalizeCurrentUnit();
        if (!staysOnCurrentQuestion) return;
        handleInput(savedShortPath.overflowChar);
        handleInput(originalChar);
        return;
    }

    // ─── 曖昧ケース: 延長と次ユニット開始の両方が可能 ───
    // 延長しつつ短縮形の代替パスを保存して、次の文字に判断を委ねる
    if (canExtend && charStartsNextUnit) {
        typingState.typedBuffer = tentativeBuffer;
        typingState.candidates = extendedCandidates;
        correctKeyCount++;

        const isComplete = extendedCandidates.some((c) => c === tentativeBuffer);
        if (isComplete) {
            // 延長形で一致したが、短縮形+次ユニットの解釈も残す
            typingState.deferredShortPath = {
                shortBuffer: tentativeBuffer.slice(0, -normalizedChar.length),
                overflowChar: originalChar,
                overflowNormalized: normalizedChar,
            };
            typingState.resolution = 'pending';
        } else {
            typingState.resolution = extendedCandidates.length === 1 ? 'locked' : 'open';
        }

        typingLogger.debug('InputEngine', 'pending → ambiguous extend', {
            buffer: typingState.typedBuffer,
            candidates: typingState.candidates,
            hasDeferredShort: !!typingState.deferredShortPath,
        });

        updateKeyboardHighlights();
        updateQuestionDisplay();
        return;
    }

    // ─── 延長のみ可能 ───
    if (canExtend) {
        typingState.typedBuffer = tentativeBuffer;
        typingState.candidates = extendedCandidates;
        typingState.resolution = extendedCandidates.length === 1 ? 'locked' : 'open';
        correctKeyCount++;

        typingLogger.debug('InputEngine', 'pending resolved → extended', {
            buffer: typingState.typedBuffer,
            candidates: typingState.candidates,
        });

        const isComplete = extendedCandidates.some((c) => c === tentativeBuffer);
        const hasLonger = extendedCandidates.some((c) => c.length > tentativeBuffer.length);

        if (isComplete && !hasLonger) {
            const staysOnCurrentQuestion = finalizeCurrentUnit();
            if (staysOnCurrentQuestion) updateQuestionDisplay();
            return;
        }
        if (isComplete && hasLonger && typingState.units[typingState.currentUnitIdx + 1]) {
            typingState.resolution = 'pending';
        }

        updateKeyboardHighlights();
        updateQuestionDisplay();
        return;
    }

    // ─── 次ユニット開始のみ可能 ───
    if (charStartsNextUnit) {
        typingLogger.debug('InputEngine', 'pending resolved → next unit', {
            finalized: typingState.typedBuffer,
            nextChar: normalizedChar,
        });
        const staysOnCurrentQuestion = finalizeCurrentUnit();
        if (!staysOnCurrentQuestion) return;
        handleInput(originalChar);
        return;
    }

    // ─── どちらにも該当しない → ミス ───
    typingLogger.warn('InputEngine', 'pending resolved → miss for next unit', {
        attempted: normalizedChar,
    });
    const staysOnCurrentQuestion = finalizeCurrentUnit();
    if (!staysOnCurrentQuestion) return;
    missedKeyCount++;
    recordMissedKeyExpectation();
    highlightMissedKey(normalizedChar);
    updateQuestionDisplay();
};

const handleInput = (char) => {
    if (!isGameActive) return;

    // ゲーム開始直後の誤入力を防ぐ (500ms)
    if (Date.now() - gameStartTime < 500) {
        return;
    }
    
    if (!char || typingState.candidates.length === 0) {
        return;
    }

    const normalizedChar = normalizeInputChar(char);
    if (!normalizedChar || normalizedChar.length !== 1) return;

    // 保留状態が存在する場合は先に解決する
    if (typingState.resolution === 'pending') {
        resolvePendingCompletion(normalizedChar, char);
        return;
    }

    const tentativeBuffer = typingState.typedBuffer + normalizedChar;
    const survivingCandidates = typingState.candidates.filter((candidate) => candidate.startsWith(tentativeBuffer));

    if (survivingCandidates.length === 0) {
        missedKeyCount++;
        recordMissedKeyExpectation();
        typingLogger.warn('InputEngine', 'miss detected', {
            attempted: normalizedChar,
            buffer: typingState.typedBuffer,
            expected: getNextKeyOptions(),
        });
        highlightMissedKey(normalizedChar);
        updateQuestionDisplay();
        return;
    }

    typingState.typedBuffer = tentativeBuffer;
    typingState.candidates = survivingCandidates;
    typingState.resolution = survivingCandidates.length === 1 ? 'locked' : 'open';
    correctKeyCount++;

    typingLogger.debug('InputEngine', 'buffer advanced', {
        buffer: typingState.typedBuffer,
        candidates: typingState.candidates,
    });

    const isUnitComplete = survivingCandidates.some((candidate) => candidate === typingState.typedBuffer);
    if (isUnitComplete) {
        // 短い候補で一致したが、より長い候補も残っている場合は確定を保留
        const hasLongerCandidates = survivingCandidates.some(
            (c) => c.length > typingState.typedBuffer.length
        );
        if (hasLongerCandidates && typingState.units[typingState.currentUnitIdx + 1]) {
            typingState.resolution = 'pending';
            typingLogger.debug('InputEngine', 'completion deferred', {
                buffer: typingState.typedBuffer,
                candidates: survivingCandidates,
            });
            updateKeyboardHighlights();
            updateQuestionDisplay();
            return;
        }

        const staysOnCurrentQuestion = finalizeCurrentUnit();
        if (staysOnCurrentQuestion) {
            updateQuestionDisplay();
        }
        return;
    }

    updateKeyboardHighlights();
    updateQuestionDisplay();
};

// ====================================
// 画面表示の更新 (updateQuestionDisplay)
// ====================================

const updateQuestionDisplay = () => {

    const currentQuestion = questionQueue[currentQuestionIndex];

    // 文節ごとにspanタグでくくって表示を変化させる
    let htmlContent = '';
    chunkedText.forEach((chunk, index) => {
        let className = '';
        if(index < currentChunkIndex){
            className = 'completed';
        }else if(index === currentChunkIndex){
            className = 'current';
        }
        
        htmlContent += `<span class="${className}">${chunk}</span>`;
    });

    textElement.innerHTML = htmlContent;

    // 分野、出典を表示
    if(currentQuestion){
        fieldElement.textContent = currentQuestion.field;
        sourceElement.textContent = currentQuestion.source;
    }

    // 今打つべき漢字文節を入力欄の上に表示する
    if(chunkedText[currentChunkIndex]){
        charGuideElement.textContent = chunkedText[currentChunkIndex];
    }else{
        charGuideElement.textContent = '';
    }

    // 今打つべきかな文節を入力欄の上に表示する（確定済みユニットのみ太字）
    if(chunkedKana[currentChunkIndex]){
        guideElement.innerHTML = buildCurrentGuideHtml();
    }else{
        guideElement.textContent = '';
    }

    // user-inputの表示
    inputBuffer = chunkCommittedRomaji + typingState.typedBuffer;
    inputElement.textContent = inputBuffer;

    // 次入力する文字のハイライト
    highlightNextKeys();
    updateRemainingQuestionCount();
};

// ====================================
// 次の問題に進む (nextQuestion)
// ====================================

const nextQuestion = () => {
    const completedQuestion = questionQueue[currentQuestionIndex];
    if (completedQuestion && typeof completedQuestion === 'object') {
        currentRunTypedHistory.push({
            field: completedQuestion.field,
            source: completedQuestion.source,
            text: completedQuestion.text,
        });
        renderLawHistory(getStoredHistory(), 1);
    }

    currentQuestionIndex++;

    // まだ問題があれば表示を更新 なければ終了
    if(currentQuestionIndex < questionQueue.length){
        setupQuestionData();
        updateQuestionDisplay();
    }else{
        finishGame();
    }
};

// ====================================
// ゲーム終了時の処理 (finishGame)
// ====================================

const finishGame = () => {
    updateRemainingQuestionCount(0);
    // ゲーム終了フラグ
    isGameActive = false;
    // 終了タイムスタンプ
    const gameEndTime = Date.now();
    // 経過時間
    const durationSec = (gameEndTime - gameStartTime) / 1000;
    // wpm の計算 
    const wpm = durationSec > 0 ? (correctKeyCount / durationSec).toFixed(2) : 0.00;
    // 正答率の計算
    const totalInputs = correctKeyCount + missedKeyCount;
    const accuracy = totalInputs > 0 ? ((correctKeyCount / totalInputs) * 100).toFixed(1) : 100;

    // 苦手キーの特定
    let weakKeysList = [];
    let maxMisses = 0;
    for (const [key,count] of Object.entries(missedKeysMap)){
        if (count > maxMisses){
            maxMisses = count;
            weakKeysList = [key];
        }else if(count == maxMisses){
            weakKeysList.push(key);
        }
    };
    const weakKeys = weakKeysList.length > 0? weakKeysList.join(',') : '特になし'

    // 保存用データオブジェクト
    const resultData = {
        date: new Date().toISOString(),
        wpm: wpm,
        missCount: missedKeyCount,
        accuracy: accuracy,
        weakKey: weakKeys,
        duration: durationSec,
        questionHistory: currentRunTypedHistory.map((question) => ({
            field: question.field,
            source: question.source,
            text: question.text,
        })),
    };
    
    // データの保存
    const isSaved = saveToLocalStorage(resultData);
    if (!isSaved) {
        console.info('outlier result skipped from history', {
            wpm: resultData.wpm,
            accuracy: resultData.accuracy,
        });
    } else {
        // 保存済み履歴と重複させないため、ランタイム履歴は保存成功時にクリアする
        currentRunTypedHistory = [];
    }

    // 画面表示の更新
    charGuideElement.textContent = '';
    charGuideElement.style.display = 'none';
    guideElement.textContent = '';
    guideElement.style.display = 'none';
    document.querySelector('#user-input').textContent = 'finish!';
    document.querySelectorAll('.key.active').forEach((keys) => {
        keys.classList.remove('active');
    });

    showResults(resultData);
    console.log('showresultsを実行');
};

// ====================================
// グラフ描画 (drawResultChart)
// ====================================

const drawResultChart = () => {
    const resultChartCanvas = document.getElementById('result-chart');
    if (!resultChartCanvas) {
        return;
    }
    const ctx = resultChartCanvas.getContext('2d');

    // ローカルストレージからデータを取得
    const history = getStoredHistory();

    // 選択された期間のデータを取得
    const recentHistory = getHistoryByPeriod(history, selectedResultPeriod);

    // データセットの作成
    const labels = recentHistory.map(item => {
        const date = new Date(item.date);

        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hour = String(date.getHours()).padStart(2, '0');
        const minute = String(date.getMinutes()).padStart(2, '0');
        return `${month}/${day} ${hour}:${minute}`
    });
    const wpmData = recentHistory.map((item) => Number(item.wpm));
    const accuracyData = recentHistory.map((item) => Number(item.accuracy));
    const calcAverage = (values) => {
        if (!Array.isArray(values) || values.length === 0) {
            return null;
        }
        return values.reduce((sum, value) => sum + Number(value), 0) / values.length;
    };
    const avgWpm = calcAverage(wpmData);
    const avgAccuracy = calcAverage(accuracyData);
    
    // チャートの作成
    if(resultChartInstance){
        resultChartInstance.destroy();
    }

    resultChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels : labels,
            datasets: [
                {
                    // wpmデータセット
                    label: '   keys/秒   ',
                    data: wpmData,
                    borderColor: '#2777f7',
                    backgroundColor: 'rgba(39,119,247,0.1)',
                    borderWidth: 0.5,
                    tension: 0,
                    pointBackgroundColor: '#ffffff',
                    pointBorderColor: '#2777f7',
                    fill: true,
                    yAxisID: 'y',
                    order: 1,
                },{
                    // accuracyデータセット
                    label: '   正タイプ率   ',
                    data: accuracyData,
                    borderColor: '#ff9f40',
                    borderWidth: 0.5,
                    // borderDash: [5,5],
                    tension: 0,
                    pointBackgroundColor: '#ffffff',
                    pointBorderColor: '#ff9f40',
                    fill: false,
                    yAxisID: 'y1',
                    order: 0,
                    clip: false,
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            // layout:{
                // padding: {
                //     top: 4,
                //     bottom: 0,
                // }
            // },
            interaction: {
                mode: 'index',
                intersect: false,
            },
            elements: {
                point: {
                    radius: 0,
                    hoverRadius: 0,
                }
            },
            scales: {
                y: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    // beginAtZero: false,
                    suggestedMax: Math.max(...wpmData, 0) + 1,
                    grid: { color: "#e9f1fd"},
                },
                y1: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    min: 50,
                    max: 100,
                    ticks: {
                        stepSize: 10,
                        precision: 0,
                    },
                    grid: { display: false },
                },
                x: {
                    grid: { display: false},
                    ticks: { display: false },
                }
            },
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        usePointStyle: true,
                        pointStyle: 'line',
                        font: {
                            size: 12,
                        },
                        boxWidth: 24,
                        padding: 8,
                        generateLabels: (chart) => {
                            const items = Chart.defaults.plugins.legend.labels.generateLabels(chart);
                            items.forEach((item) => {
                                item.pointStyle = 'line';
                                item.lineWidth  = 2;
                            });
                            return items;
                        },
                    }
                },
                tooltip: {
                    displayColors : true,
                    backgroundColor: '#5c5e64',
                    padding: 8,
                    callbacks: {
                        title: (tooltipItems) => {
                            return 'プレイ日時 : ' + tooltipItems[0].label;
                        },
                        label: (context) => {
                            // wpm か accuracy かで表示する単位を変更
                            if(context.dataset.label === 'wpm'){
                                return ' 正タイプ率 : ' + Number(context.raw).toFixed(2) + ' (keys/秒)';
                            } else if(context.dataset.label === '正タイプ率'){
                                return 'タイピング速度 : ' + Number(context.raw).toFixed(1) + ' %';
                            }
                        },
                    }
                }
            },
        },
        // y軸上部に [keys/秒] を表示 
        plugins: [{
            id: 'yAxisUnit',
            afterDraw: (chart) => {

                // 左軸と右軸を取得
                const {ctx, scales: {y, y1}} = chart;
                ctx.save();
                ctx.font = 'normal 12px sans-serif';
                ctx.fillStyle = '#5c5e64';
                ctx.textAlign = 'left';

                // 描画位置
                const yPos = y.top - 16;

                // 左軸 wpm
                ctx.textAlign = 'left';
                ctx.fillText('[keys/秒]', y.left, yPos);

                // 右軸 accuracy
                ctx.textAlign = 'right';
                ctx.fillText('[%]', y1.right, yPos);

                ctx.restore();
            }
        },{
            // keys/秒 と正タイプ率の平均値ガイド線を描画
            id: 'averageGuideLines',
            afterDatasetsDraw: (chart) => {
                const {ctx, chartArea, scales: {y, y1}} = chart;

                const drawAverageLine = (value, scale, color) => {
                    if (value === null || !Number.isFinite(value) || !scale) {
                        return;
                    }

                    const yPos = scale.getPixelForValue(value);
                    if (!Number.isFinite(yPos)) {
                        return;
                    }

                    ctx.save();
                    ctx.beginPath();
                    ctx.setLineDash([4, 3]);
                    ctx.lineWidth = 0.8;
                    ctx.strokeStyle = color;
                    ctx.moveTo(chartArea.left, yPos);
                    ctx.lineTo(chartArea.right, yPos);
                    ctx.stroke();
                    ctx.restore();
                };

                drawAverageLine(avgWpm, y, 'rgba(39,119,247,0.85)');
                drawAverageLine(avgAccuracy, y1, 'rgba(255,159,64,0.85)');
            }
        },{
            // 凡例とグラフの間隔を少し広げる
            id: 'legendMargin',
            beforeInit(chart){
                const legend = chart.legend;
                if(!legend || !legend.fit) return;
                const originalFit = legend.fit;
                legend.fit = function fit(){
                    originalFit.call(this);
                    // 凡例の高さを増やすことで下側に余白を追加
                    this.height += 8;
                }
            }
        }]
    })
};

// ====================================
// 結果画面の表示 (showResults)
// ====================================

const showResults = (data) => {
    invalidateResultTransitions();
    const transitionToken = resultTransitionToken;

    resultTimer1 = setTimeout(() => {
        if (transitionToken !== resultTransitionToken || currentScreen !== SCREEN.GAME) {
            resultTimer1 = null;
            return;
        }

        // 終了演出は毎回同じ開始状態から実行する
        normalizeGameScreenAnimatedStyles();
        delayScreens.forEach((screen) => {
            screen.style.opacity = '1';
            screen.style.transform = 'scale(1)';
        });

        const questionAreaAnimation = trackAnimation(questionArea.animate([
            {height: GAME_SCREEN_VISUAL_DEFAULTS.questionAreaHeight, margin: GAME_SCREEN_VISUAL_DEFAULTS.questionAreaMargin, opacity: 1},
            {height: '0rem', margin: '0 .25rem 0 .25rem', opacity: 0},
        ],{
            duration: 400,
            fill: 'forwards',
            transformOrigin: 'top',
        }), 'result:question-area');

        const answerAreaAnimation = trackAnimation(answerArea.animate([
            {height: GAME_SCREEN_VISUAL_DEFAULTS.answerAreaHeight},
            {height: '21.25rem'},
        ],{
            duration: 400,
            fill: 'forwards',
            transformOrigin: 'bottom',
        }), 'result:answer-area');

        keys.forEach((key, index) => {
            trackAnimation(key.animate([
                {opacity: 1, offset: 0},
                {opacity: 0.8, offset: 0.5},
                {opacity: 0, offset: 1}
            ],{
                duration: 400,
                fill: 'forwards',
            }), `result:key:${key.id || index}`);
        });

        trackAnimation(inputElement.animate([
            {opacity: 1},
            {opacity: 0},
        ],{
            duration: 200,
            fill: 'forwards',
        }), 'result:input');

        Promise.allSettled([
            questionAreaAnimation.finished,
            answerAreaAnimation.finished,
        ]).then(() => {
            if (transitionToken !== resultTransitionToken || currentScreen !== SCREEN.GAME) {
                return;
            }

            setVisibleScreen(SCREEN.RESULTS);
            console.log('リザルト画面を表示');

            // 画面切替を先に確定させ、重い描画処理は次フレームへ送る
            requestAnimationFrame(() => {
                if (transitionToken !== resultTransitionToken || currentScreen !== SCREEN.RESULTS) {
                    return;
                }

                drawResultChart();
                displayResultStats(data);

                const history = getStoredHistory();
                displaySideStats(history);
                renderLawHistory(history, 1);

                statItems.forEach((item, index) => {
                    trackAnimation(item.animate([
                        {opacity: 0},
                        {opacity: 1},
                    ],{
                        duration: 500,
                        fill: 'forwards',
                        easing: 'ease-in-out',
                    }), `result:stat:${item.id || index}`);
                });
            });
        });

        resultTimer1 = null;
    }, 1000);
};

// ====================================
// ゲームリセット (resetGame)
// ====================================

const resetGame = () => {

    // ゲーム状態変数をリセット
    questionQueue = [];         // 実際に出題される問題のリスト
    currentQuestionIndex = 0;   // 今何問目か
    chunkedText = [];           // 日本語を読点で区切ったリスト
    chunkedKana = [];           // かな読みを読点で区切ったリスト
    unitChunkMap = [];          // 各ユニットが属する文節のインデックス
    currentChunkIndex = 0;      // 今何個目の文節を打っているか
    inputBuffer = '';           // ユーザーが打っている正誤未確定の文節
    chunkCommittedRomaji = '';
    gameStartTime = 0;          // 開始タイムスタンプ
    correctKeyCount = 0;        // 正解タイプ数
    missedKeyCount = 0;         // ミスタイプ数
    missedKeysMap = {};         // ミスタイプしたキーを格納するオブジェクト
    isGameActive = false;       // ゲーム進行中フラグ
    currentRunTypedHistory = [];
    resetTypingState();

    // staleな結果遷移を先に無効化
    invalidateResultTransitions();

    if(resultChartInstance){
        resultChartInstance.destroy();
        resultChartInstance = null;    
    }

    updateRemainingQuestionCount();

    // html要素のリセット
    textElement.innerHTML = '';
    charGuideElement.textContent = '';
    charGuideElement.style.display = '';
    guideElement.textContent = '';    
    inputElement.textContent = '';
    guideElement.style.display = 'none';
    fieldElement.textContent = '';
    sourceElement.textContent = '';
    keyboardContainer.style.visibility = 'visible';

    // 表示関連の残留アニメーションを解除
    resetGameScreenVisualState(false);

    // 画面の切り替え
    setVisibleScreen(SCREEN.START);
    clearStartScreenError();
    renderLawHistory(getStoredHistory(), 1);
};

// ====================================
// イベントリスナー設定
// ====================================

const resetAndGameStart = (config) => {
    resetGame();
    startGame(config);
};

if (hasGameScreenDom) {
    initializeResultPeriodSelector();
    initializeLawHistoryPagination();
}

// --- フォーム提出 → ゲーム開始 ---
if (form) {
    form.addEventListener('submit', (event) => {
        event.preventDefault();

        const currentSettings = getGameSettings();
        resetAndGameStart(currentSettings);
    });
}

// --- キーダウンイベント ---
if (hasGameScreenDom) {
    document.addEventListener('keydown', (event) => {
        const isNavigationKey = event.code === 'Space' || event.code === 'Escape';

        // 終了演出中のSpace既定動作(スクロール)を抑止して表示崩れを防ぐ
        if(event.code === 'Space' && isTransitionPhase()){
            event.preventDefault();
            return;
        }

        // 遷移キーの長押しによる多重遷移を防止
        if(event.repeat && isNavigationKey){
            event.preventDefault();
            return;
        }
        
        // Spaceキーの処理
        if(event.code === 'Space'){
            if(currentScreen === SCREEN.START){
                event.preventDefault();
                resetAndGameStart(getGameSettings());
                return;
            }else if(currentScreen === SCREEN.RESULTS){
                event.preventDefault();
                const cfg = lastGameSettings || getGameSettings();
                resetAndGameStart(cfg);
                return;
            }
        }

        // Escキーでゲーム中断
        if(event.code === 'Escape'){
            if (currentScreen === SCREEN.GAME || currentScreen === SCREEN.RESULTS){
            event.preventDefault();
            resetGame();
            return;
            }
        }

        // キー入力の判定処理
        if(!isGameActive)return;

        if(event.repeat){
            event.preventDefault();
            return;
        }

        if(event.key.length === 1){
            event.preventDefault();
            handleInput(event.key);
        }
    });
}


// --- ヘッダーのリンク処理 ---
const prepareNavigationFromGame = () => {
    if (isGameActive || currentScreen === SCREEN.GAME) {
        resetGame();
    }
};

const navActions = {
    'nav-home-link': () => {
        prepareNavigationFromGame();
        setVisibleScreen(SCREEN.START);
    },
    'nav-results-link': () => {
        prepareNavigationFromGame();
        setVisibleScreen(SCREEN.RESULTS);
        showResultsOverview();
    },
    'nav-setting-link': () => {
        window.location.href = 'setting.html';
    }
}

if (navContainer) {
    navContainer.addEventListener('click', (event) => {
        const link = event.target.closest('a[class^="nav-"]');
        if(!link) return;

        if (!hasGameScreenDom) {
            return;
        }

        event.preventDefault();

        const action = navActions[link.className];
        if(action) action();
    });
}

// --- サイドコンテンツの更新 ---
const displaySideStats = (history) => {
    const totalPlayDaysEl = document.querySelector('#total-play-days');
    const currentStreakDaysEl = document.querySelector('#current-streak-days');
    const sideCurrentAvgWpmEl = document.querySelector('#side-current-avg-wpm');
    const sideMaxWpmEl = document.querySelector('#side-max-wpm');
    const sideCumulativeWeakKeysEl = document.querySelector('#side-cumulative-weak-keys');
    const nextExamDaysEl = document.querySelector('#next-exam-days');

    const metrics = computeHistoryMetrics(history);
    if(totalPlayDaysEl){
        totalPlayDaysEl.textContent = metrics.totalPlayDays + ' 日';
    }
    if(currentStreakDaysEl){
        currentStreakDaysEl.textContent = metrics.currentStreakDays + ' 日';
    }
    if(sideCurrentAvgWpmEl){
        sideCurrentAvgWpmEl.textContent = metrics.currentAvgWpm.toFixed(2) + ' keys/秒';
    }
    if(sideMaxWpmEl){
        sideMaxWpmEl.textContent = metrics.maxWpm.toFixed(2) + ' keys/秒';
    }
    if(sideCumulativeWeakKeysEl){
        sideCumulativeWeakKeysEl.textContent = metrics.cumulativeWeakKeys;
    }
    if(nextExamDaysEl){
        nextExamDaysEl.textContent = metrics.nextExamDays + ' 日';
    }
}

// const homeLink = document.querySelector('.nav-home-link');
// const resultsLink = document.querySelector('.nav-results-link');
// const settingLink = document.querySelector('.nav-setting-link');


// if(resultsLink){
//     resultsLink.addEventListener('click', (event) => {
//         event.preventDefault();
//         // ゲーム中の場合は処理しない
//         if(isGameActive) return;
        
//         // スタート画面を非表示にして、結果画面を表示
//         startScreen.style.display = 'none';
//         resultsScreen.style.display = 'flex';
        
//         // 結果画面にデータを表示
//         drawResultChart();

//         statItems.forEach((item) => {
//             item.style.opacity = 1;
//         });
//     });
// }

// // --- ホームのリンク処理 ---

// if(homeLink){
//     homeLink.addEventListener('click', (event) => {
//         event.preventDefault();
//         // ゲーム中の場合は処理しない
//         if(isGameActive) return;
        
//         // スタート画面を表示、他の画面を非表示
//         startScreen.style.display = 'block';
//         gameScreen.style.display = 'none';
//         resultsScreen.style.display = 'none';
//     });
// }

// // --- 設定のリンク処理 ---

// if(settingLink){
//     settingLink.addEventListener('click', (event) => {
//         event.preventDefault();
//         // ゲーム中の場合は処理しない
//         if(isGameActive) return;
        
//         // 設定ページへ遷移
//         window.location.href = 'setting.html';
//     });
// }

