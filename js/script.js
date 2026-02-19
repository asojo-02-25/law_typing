import {typingQuestions} from './question.js';
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
let lastGameSettings = null;    // 直近プレイ設定を保持
let resultTimer1 = null;        // 結果画面タイマー1
let resultTimer2 = null;        // 結果画面タイマー2
const typingState = {
    units: [],           // パース済みかなユニット
    currentUnitIdx: 0,   // 現在注目しているユニットのインデックス
    typedBuffer: '',     // 現ユニットの入力済みローマ字
    candidates: [],      // 現ユニットで生き残っている候補
    isLocked: false,     // 候補が一意に決まったら true
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
    typingState.isLocked = false;
};

const initializeTypingState = (units = []) => {
    resetTypingState();
    typingState.units = [...units];
    if (typingState.units.length > 0) {
        typingState.candidates = getRomajiCandidatesForUnit(typingState.units[0]);
        typingState.isLocked = typingState.candidates.length === 1;
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
    typingLogger.info('InputEngine', 'unit completed', {
        unit: typingState.units[typingState.currentUnitIdx],
        value: completedValue,
    });
    typingState.currentUnitIdx += 1;
    typingState.typedBuffer = '';

    const nextUnit = typingState.units[typingState.currentUnitIdx];
    if (!nextUnit) {
        typingState.candidates = [];
        typingState.isLocked = false;
        updateKeyboardHighlights();
        nextQuestion();
        return false;
    }

    typingState.candidates = getRomajiCandidatesForUnit(nextUnit);
    typingState.isLocked = typingState.candidates.length === 1;
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

const reverseKeyIdMap = Object.entries(keyIdMap).reduce((acc, [char, id]) => {
    acc[id.toUpperCase()] = char;
    return acc;
}, {});

// ====================================
// HTML要素の取得
// ====================================

const form = document.getElementById('form');
const startScreen = document.getElementById('start-screen');
const gameScreen = document.getElementById('game-screen');
const resultsScreen = document.getElementById('results-screen');
const delayScreens = document.querySelectorAll('.delay-screen');
const btn = document.getElementById('start-button');
const textElement = document.getElementById('question-text');
const inputElement = document.getElementById('user-input');
const guideElement = document.getElementById('current-guide');
const fieldElement = document.getElementById('question-field');
const sourceElement  = document.getElementById('question-source'); 
const remainingElement = document.getElementById('question-remaining');
const questionArea = document.getElementById('question-area');
const answerArea = document.getElementById('answer-area');
const keys = document.querySelectorAll('.key');
const statItems = document.querySelectorAll('.stat-item');
const keyboardContainer = document.getElementById('keyboard-container');

// ====================================
// ページロード時の初期化
// ====================================

// ページ読み込み時に画面状態をリセット
window.addEventListener('load', () => {
    startScreen.style.display = 'block';
    gameScreen.style.display = 'none';
    resultsScreen.style.display = 'none';

    // サイドコンテンツを更新
    const history = getStoredHistory();
    displaySideStats(history);
});

// ====================================
// 履歴取得 / 統計計算 ヘルパー
// ====================================

const STORAGE_KEY = 'law_type_play_data';

const getStoredHistory = () => {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch (e) {
        console.error('storage parse error', e);
        return [];
    }
};

const computeHistoryMetrics = (history) => {
    const count = history.length;
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
        };
    }

    const wpms = history.map(h => Number(h.wpm));
    const maxWpm = Math.max(...wpms);
    const latest = history[count - 1];
    const latestWpm = Number(latest.wpm);

    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();

    const toAvg = (arr) => arr.length > 0 ? arr.reduce((a,b) => a + b, 0) / arr.length : 0;
    const pickWindow = (startMs, endMs) => 
        history
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
        history.map(h => {
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
    if (recentAvgEl) recentAvgEl.textContent = metrics.recentAvgWpm.toFixed(2) + ' keys/秒';
    if (maxEl) maxEl.textContent = metrics.maxWpm.toFixed(2) + ' keys/秒';
};

// ====================================
// 補助関数
// ====================================

// --- 設定を取得する関数の定義 ---
const getGameSettings = () => {
    //問題形式
    const format = document.querySelector('input[name="format"]:checked').value;
    //問題数
    const itemcounts = parseInt(document.querySelector('input[name="itemcounts"]:checked').value);
    //各種設定
    const options = [];
    document.querySelectorAll('input[name="setting"]:checked').forEach((checkbox) => {
        options.push(checkbox.value);
    });

    return{
        mode: format,
        questionCounts: itemcounts,
        settings: options,
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
    const history = getStoredHistory();
    history.push(data);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
};

// ====================================
// ゲーム開始 (startGame)
// ====================================

const startGame = (config) => {
    isGameActive = true;        // ゲーム開始フラグ
    guideElement.style.display = 'block';

    lastGameSettings = JSON.parse(JSON.stringify(config));  // 直近の設定を保持
    
    console.log("開始設定", config); // 設定の取得・反映確認

    correctKeyCount = 0;
    missedKeyCount = 0;
    missedKeysMap = {};
    gameStartTime = Date.now();

    if(config.settings.includes('roman-letters-represent')){
        console.log("ローマ字を表示します");
    }
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
    const shuffledQuestions = shuffleArray(typingQuestions);

    // 問題をスライス
    const count = Math.min(shuffledQuestions.length, config.questionCounts);
    questionQueue = shuffledQuestions.slice(0, count);

    // カウンターをリセット
    currentQuestionIndex = 0;

    // 最初の問題を表示
    setupQuestionData();
    updateQuestionDisplay();

    // ディスプレイ関連
    startScreen.style.display = 'none';
    gameScreen.style.display = 'flex';
    resultsScreen.style.display = 'none';
    
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
        screen.animate(keyframes, options);
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

const normalizeInputChar = (char) => {
    if (typeof char !== 'string' || char.length === 0) return '';
    if (/[a-z]/i.test(char)) return char.toLowerCase();
    return char;
};

const getSoftKeyChar = (element) => {
    if (!element || !element.id) return '';
    const normalizedId = element.id.toUpperCase();
    if (reverseKeyIdMap[normalizedId]) {
        return normalizeInputChar(reverseKeyIdMap[normalizedId]);
    }
    if (element.id.length === 1) {
        return normalizeInputChar(element.id);
    }
    const label = element.textContent ? element.textContent.trim() : '';
    if (label.length === 1) {
        return normalizeInputChar(label);
    }
    return '';
};

const handleInput = (char, source = 'physical') => {
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

    const tentativeBuffer = typingState.typedBuffer + normalizedChar;
    const survivingCandidates = typingState.candidates.filter((candidate) => candidate.startsWith(tentativeBuffer));

    if (survivingCandidates.length === 0) {
        missedKeyCount++;
        recordMissedKeyExpectation();
        typingLogger.warn('InputEngine', 'miss detected', {
            source,
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
    typingState.isLocked = survivingCandidates.length === 1;
    correctKeyCount++;

    typingLogger.debug('InputEngine', 'buffer advanced', {
        source,
        buffer: typingState.typedBuffer,
        candidates: typingState.candidates,
    });

    const isUnitComplete = survivingCandidates.some((candidate) => candidate === typingState.typedBuffer);
    if (isUnitComplete) {
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

    // 今打つべき文節を入力欄の上に表示する
    if(chunkedText[currentChunkIndex]){
        guideElement.textContent = chunkedText[currentChunkIndex];
    }else{
        guideElement.textContent = '';
    }

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
    };
    
    // データの保存
    saveToLocalStorage(resultData);

    // 画面表示の更新
    document.querySelector('#current-guide').textContent = '';
    document.querySelector('#current-guide').style.display = 'none';
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
    const ctx = document.getElementById('result-chart').getContext('2d');

    // ローカルストレージからデータを取得
    const history = getStoredHistory();

    // 直近15回のデータを取得
    const recentHistory = history.slice(-15);

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
                    borderWidth: 2,
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
                    borderWidth: 2,
                    borderDash: [5,5],
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
            layout:{
                padding: {
                    top: 8,
                    bottom: 16,
                }
            },
            interaction: {
                mode: 'index',
                intersect: false,
            },
            scales: {
                y: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    beginAtZero: true,
                    suggestedMax: Math.max(...wpmData, 0) + 1,
                    grid: { color: "#e9f1fd"},
                },
                y1: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    min: 0,
                    max: 100,
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
                        font: {
                            size: 10,
                        },
                        boxWidth: 2,
                        padding: 8,
                        generateLabels: (chart) => {
                            const items = Chart.defaults.plugins.legend.labels.generateLabels(chart);
                            items.forEach((item) => {
                                item.lineWidth  = 1;
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
    resultTimer1 = setTimeout(() => {
        questionArea.animate([
            {height: '13rem', margin: '.5rem .25rem .5rem .25rem', opacity: 1},
            {height: '0rem', margin: '0 .25rem 0 .25rem', opacity: 0},
        ],{
            duration: 400,
            fill: 'forwards',
            transformOrigin: 'top',
        });

        answerArea.animate([
            {height: '8rem'},
            {height: '21rem'},
        ],{
            duration: 400,
            fill: 'forwards',
            transformOrigin: 'bottom',
        });

        keys.forEach((key) => {
            key.animate([
                {opacity: 1, offset: 0},
                {opacity: 0.8, offset: 0.5},
                {opacity: 0, offset: 1}
            ],{
                duration: 400,
                fill: 'forwards',
            });
        });

        inputElement.animate([
            {opacity: 1},
            {opacity: 0},
        ],{
            duration: 200,
            fill: 'forwards',
        });
    }, 1000)
    
    resultTimer2 = setTimeout(() => {    
        gameScreen.style.display = 'none';
        resultsScreen.style.display = 'flex';
        console.log('リザルト画面を表示');

        // 画面表示の更新
        drawResultChart();
        displayResultStats(data);

        const history = getStoredHistory();
        displaySideStats(history);

        statItems.forEach((item) => {
            item.animate([
                {opacity: 0},
                {opacity: 1},
            ],{
                duration: 500,
                fill: 'forwards',
                easing: 'ease-in-out',
            });
        });
    }, 1500);
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
    resetTypingState();
    if(resultChartInstance){
        resultChartInstance.destroy();
        resultChartInstance = null;    
    }
    if(resultTimer1){
        clearTimeout(resultTimer1);
        resultTimer1 = null;
    }
    if(resultTimer2){
        clearTimeout(resultTimer2);
        resultTimer2 = null;
    }

    updateRemainingQuestionCount();

    // html要素のリセット
    textElement.innerHTML = '';
    inputElement.textContent = '';
    guideElement.textContent = '';
    guideElement.style.display = 'none';
    fieldElement.textContent = '';
    sourceElement.textContent = '';
    keyboardContainer.style.visibility = 'visible';

    // 遅延画面アニメーションのリセット
    delayScreens.forEach((screen) => {
        screen.getAnimations().forEach((animation) => {
            animation.cancel();
        });
        screen.style.opacity = '';
        screen.style.transform = '';
    });

    // ゲーム画面のアニメーションリセット
    questionArea.getAnimations().forEach((animation) => {
        animation.cancel();
    });
    questionArea.style.height = '';
    questionArea.style.margin = '';
    questionArea.style.opacity = '';

    answerArea.getAnimations().forEach((animation) => {
        animation.cancel();
    });
    answerArea.style.height = '';

    keys.forEach((key) => {
        key.getAnimations().forEach((animation) => {
            animation.cancel();
        });
        key.style.opacity = '';
    });

    inputElement.getAnimations().forEach((animation) => {
        animation.cancel();
    });
    inputElement.style.opacity = '';

    // 結果画面の統計アイテムのアニメーションリセット
    statItems.forEach((item) => {
        item.getAnimations().forEach((animation) => {
            animation.cancel();
        });
        item.style.opacity = '';
    });

    // 画面の切り替え
    startScreen.style.display = 'block';
    gameScreen.style.display = 'none';
    resultsScreen.style.display = 'none';
};

// ====================================
// イベントリスナー設定
// ====================================

// --- フォーム提出 → ゲーム開始 ---
form.addEventListener('submit', (event) => {
    event.preventDefault();
    const currentSettings = getGameSettings();
    startGame(currentSettings);
});

// --- キーダウンイベント ---
document.addEventListener('keydown', (event) => {
    
    // Spaceキーの処理
    if(event.code === 'Space'){
        if(startScreen.style.display !== 'none'){
            event.preventDefault();
            resetGame();
            btn.click();
            return;
        }else if(resultsScreen.style.display !== 'none'){
            event.preventDefault();
            resetGame();
            const cfg = lastGameSettings || getGameSettings();
            startGame(cfg);
            return;
        }
    }

    // Escキーでゲーム中断
    if(event.code === 'Escape'){
        if (gameScreen.style.display !== 'none'){
        event.preventDefault();
        resetGame();
        return;
        }else if(resultsScreen.style.display !== 'none'){
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
        handleInput(event.key, 'physical');
    }
});

if(keyboardContainer){
    keyboardContainer.addEventListener('click', (event) => {
        if(!isGameActive) return;
        const keyEl = event.target.closest('.key');
        if(!keyEl) return;
        const char = getSoftKeyChar(keyEl);
        if(!char) return;
        handleInput(char, 'soft');
    });
}

// --- ヘッダーのリンク処理 ---
const navActions = {
    'nav-home-link': () => {
        startScreen.style.display = 'block';
        gameScreen.style.display = 'none';
        resultsScreen.style.display = 'none';
    },
    'nav-results-link': () => {
        startScreen.style.display = 'none';
        gameScreen.style.display = 'none';
        resultsScreen.style.display = 'flex';
        drawResultChart();
        // 最新履歴で数値表示
        const hist = getStoredHistory();
        const latest = hist.length ? hist[hist.length - 1] : { wpm: 0, accuracy: 0, weakKey: '特になし' };
        displayResultStats(latest);
        statItems.forEach((item) => { item.style.opacity = 1; });
    },
    'nav-setting-link': () => {
        window.location.href = 'setting.html';
    }
}

document.querySelector('.nav').addEventListener('click', (event) => {
    const link = event.target.closest('a[class^="nav-"]');
    if(!link) return;

    event.preventDefault();
    if(isGameActive) return;

    const action = navActions[link.className];
    if(action) action();
});

// --- サイドコンテンツの更新 ---
const displaySideStats = (history) => {
    const totalPlayDaysEl = document.querySelector('#total-play-days');
    const currentStreakDaysEl = document.querySelector('#current-streak-days');
    const sideCurrentAvgWpmEl = document.querySelector('#side-current-avg-wpm');
    const sideMaxWpmEl = document.querySelector('#side-max-wpm');
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

