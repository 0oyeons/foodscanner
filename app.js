/* =========================================================
 * app.js — 알레르기 성분 스캐너 (주기능)
 *  1. 내 알레르기 설정 (저장 / 불러오기)
 *  2. 사진 → 글자 (OCR, Tesseract.js)
 *  3. 성분 분석 (추론: 규칙 기반 키워드 사전, dictionary.js)
 *     R1 사전 단어 찾기 · R2 긴 단어 먼저 · R3 제외어 · R4 혼입 문장은 확인 필요
 *     R5 괄호 원료 · R6 띄어쓰기 허용 · R7 가장 높은 등급으로 판정
 *     R8 표시 의무 성분인데 알레르기 표시란이 없으면 '안전' 대신 '확인 필요'
 *     R9 섭취·조리 방법 안내 문장의 이름은 판정에서 뺌
 *  4. 결과 화면 (판정 + 판단 근거 + 원문 표시)
 * ========================================================= */

const $ = (selector) => document.querySelector(selector);
const STORAGE_KEY = "allergy-scanner-settings";

const SAMPLE_TEXT = `제품명: 예시 초코칩 쿠키 (가상 제품)
원재료명: 밀가루(밀:미국산), 설탕, 식물성유지(팜유, 해바라기유), 코코아버터, 전지분유, 유청분말, 대두레시틴, 젖산, 정제소금, 합성향료(밀크향)
알레르기 유발물질: 밀, 우유, 대두 함유
이 제품은 땅콩, 호두, 해바라기씨를 사용한 제품과 같은 제조시설에서 제조하고 있습니다.`;

/* ---------------------------------------------------------
 * 1. 내 알레르기 설정
 * ------------------------------------------------------- */

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.allergens)) {
      saved.allergens = saved.allergens.filter((id) => id in ALLERGENS);
      return saved;
    }
  } catch (e) {
    // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)이면 기본값 사용
  }
  return { allergens: Object.keys(ALLERGENS), custom: "" };
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    // 저장에 실패해도 검사는 그대로 동작
  }
}

function renderAllergenChoices(settings) {
  const box = $("#allergen-list");
  box.innerHTML = "";
  for (const [id, allergen] of Object.entries(ALLERGENS)) {
    const label = document.createElement("label");
    label.className = "chip";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = id;
    input.checked = settings.allergens.includes(id);
    input.addEventListener("change", onSettingsChange);
    label.append(input, document.createTextNode(allergen.name));
    box.append(label);
  }
  $("#custom-words").value = settings.custom || "";
}

function readSettingsFromScreen() {
  const checked = document.querySelectorAll("#allergen-list input:checked");
  return {
    allergens: [...checked].map((input) => input.value),
    custom: $("#custom-words").value,
  };
}

function onSettingsChange() {
  saveSettings(readSettingsFromScreen());
}

// "땅콩, 호두" → ["땅콩", "호두"]
function parseCustomWords(raw) {
  return (raw || "")
    .split(/[,，、\n]/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
}

/* ---------------------------------------------------------
 * 2. 사진 → 글자 (OCR)
 * ------------------------------------------------------- */

let ocrWorker = null;

const OCR_STATUS_TEXT = {
  "loading tesseract core": "글자 인식 엔진을 불러오는 중",
  "initializing tesseract": "글자 인식 엔진을 준비하는 중",
  "loading language traineddata": "한국어 인식 데이터를 받는 중 (처음 한 번만)",
  "initializing api": "거의 다 준비됐어요",
  "recognizing text": "글자를 읽는 중",
};

async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  // "kor" = 한국어 인식 데이터, 1 = 신경망(LSTM) 인식 방식
  ocrWorker = await Tesseract.createWorker("kor", 1, {
    logger: updateOcrProgress,
  });
  return ocrWorker;
}

function updateOcrProgress(message) {
  const text = OCR_STATUS_TEXT[message.status] || "준비하는 중";
  const percent = Math.round((message.progress || 0) * 100);
  $("#ocr-status").textContent = `${text}… ${percent}%`;
  $("#ocr-bar").value = percent;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// 인식률을 높이기 위해: 크기를 알맞게 맞추고 흑백으로 바꾸기
function prepareImage(img) {
  const longSide = Math.max(img.width, img.height);
  const scale = Math.min(2400 / longSide, 2.5);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = image.data; // [R, G, B, A, R, G, B, A, ...]
  for (let i = 0; i < pixels.length; i += 4) {
    const gray = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    pixels[i] = pixels[i + 1] = pixels[i + 2] = gray;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function setOcrBusy(busy) {
  $("#ocr-box").hidden = false;
  $("#ocr-bar").hidden = !busy;
  $("#check-btn").disabled = busy;
  $("#photo-label").classList.toggle("is-disabled", busy);
}

async function onPhotoSelected(event) {
  const file = event.target.files[0];
  if (!file) return;

  const preview = $("#photo-preview");
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;

  if (typeof Tesseract === "undefined") {
    $("#ocr-box").hidden = false;
    $("#ocr-status").textContent = "글자 인식 기능을 불러오지 못했어요. 인터넷 연결을 확인하거나 성분표를 직접 입력해 주세요.";
    return;
  }

  setOcrBusy(true);
  try {
    const img = await loadImage(file);
    const canvas = prepareImage(img);
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(canvas);
    $("#label-text").value = data.text.trim();
    $("#ocr-status").textContent = "다 읽었어요. 잘못 읽힌 글자가 있으면 고친 뒤 '검사하기'를 다시 눌러 주세요.";
    runAnalysis();
  } catch (error) {
    console.error(error);
    ocrWorker = null;
    $("#ocr-status").textContent = "글자를 읽지 못했어요. 더 밝고 가까이에서 다시 찍거나, 성분표를 직접 입력해 주세요.";
  } finally {
    setOcrBusy(false);
    event.target.value = ""; // 같은 사진을 다시 골라도 동작하도록
  }
}

/* ---------------------------------------------------------
 * 3. 성분 분석 (규칙 기반 추론)
 * ------------------------------------------------------- */

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 띄어쓰기가 섞여도 찾을 수 있게 만든 검색 규칙
// 예) "탈지분유" → 탈\s*지\s*분\s*유  ("탈 지 분 유"도 찾음)
function buildPattern(word, unlessParen = false) {
  const chars = [...word.replace(/\s+/g, "")].map(escapeRegex);
  let pattern = chars.join("\\s*");
  if (unlessParen) {
    // 바로 뒤에 "(원료)"가 붙어 있으면 찾지 않음 (예: "식물성유지(팜유)", "식물성유지1(팜유)")
    pattern += "(?![가-힣0-9 ]{0,4}[\\(\\[])";
  }
  return new RegExp(pattern, "g");
}

const isHangul = (ch) => !!ch && /[가-힣]/.test(ch);

// 띄어쓰기를 건너뛰어 찾은 경우, 앞뒤가 다른 낱말에 붙어 있으면 무시
// 예) "수입원 유통기한" 속 "원 유"를 '원유'로 잘못 찾는 것을 막음
function crossesWords(text, start, end) {
  return /\s/.test(text.slice(start, end)) && (isHangul(text[start - 1]) || isHangul(text[end]));
}

function findRanges(text, words) {
  const ranges = [];
  for (const word of words) {
    for (const match of text.matchAll(buildPattern(word))) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  return ranges;
}

function overlaps(ranges, start, end) {
  return ranges.some(([s, e]) => start < e && s < end);
}

// 문장이 끊기는 위치: 마침표·줄바꿈·글머리표 뒤, '이 제품은' 앞
function sentenceCuts(text) {
  const cuts = [0, text.length];
  for (const m of text.matchAll(/[.。\n※•▲*|]/g)) cuts.push(m.index + 1);
  for (const m of text.matchAll(/(이|본)\s*제품은/g)) cuts.push(m.index);
  return cuts.sort((a, b) => a - b);
}

// 표지어(혼입 문구, 섭취 방법 등)가 들어 있는 문장의 범위 찾기
// lookback: 표지어 앞쪽으로 최대 몇 글자까지 볼지 / ahead: 뒤쪽으로 최대 몇 글자까지 볼지
function findMarkerSpans(text, markers, lookback, ahead = Infinity) {
  const cuts = sentenceCuts(text);
  const spans = [];
  for (const marker of markers) {
    for (const m of text.matchAll(buildPattern(marker))) {
      const markerEnd = m.index + m[0].length;
      const before = cuts.filter((c) => c <= m.index);
      const after = cuts.filter((c) => c >= markerEnd);
      const start = Math.max(before[before.length - 1], m.index - lookback);
      const end = Math.min(after[0], markerEnd + ahead);
      spans.push([start, end]);
    }
  }
  return spans;
}

// "같은 제조시설에서 제조" 같은 혼입 주의 문구가 걸치는 범위 찾기 (R4)
// 사진에서 읽은 글자는 마침표가 빠지는 일이 많아서, 문구 앞쪽은 최대 120자까지만 봄
// (그렇지 않으면 앞에 있는 원재료 목록 전체가 '확인 필요'로 낮아질 수 있음)
const CONTACT_LOOKBACK = 120;

function findCrossContactSpans(text) {
  return findMarkerSpans(text, CROSS_CONTACT_MARKERS, CONTACT_LOOKBACK);
}

// "우유 200ml를 넣어 드세요" 같은 섭취·조리 방법 안내 문장의 범위 찾기 (R9)
// 원재료 목록까지 빼지 않도록 앞은 40자, 뒤는 80자까지만 봄
const SERVING_LOOKBACK = 40;
const SERVING_AHEAD = 80;

function findServingSpans(text) {
  return findMarkerSpans(text, SERVING_MARKERS, SERVING_LOOKBACK, SERVING_AHEAD);
}

// 알레르기 표시란 찾기 (R8)
//  ① '알레르기 유발물질:' 같은 머리말 뒤에 표시 대상 이름이나 '없음'이 오는 경우
//  ② '대두, 밀, 우유 함유'처럼 표시 대상 이름 목록 바로 뒤에 '함유'가 오는 경우
//  단, '같은 제조시설에서 제조' 같은 혼입 문구 안에 있으면 표시란이 아님
const ALLERGEN_NAME = `(?:${LABELED_ALLERGEN_NAMES.join("|")})(?:\\s*\\([^)]{0,20}\\))?`;
const BOX_HEAD = new RegExp(
  `알\\s*레\\s*르\\s*기\\s*(?:유\\s*발\\s*)?(?:물\\s*질|성\\s*분)[^가-힣]{0,6}(?:${ALLERGEN_NAME}|없\\s*음|해\\s*당\\s*없\\s*음)`, "g");
const BOX_LIST = new RegExp(
  `(?:^|[^가-힣])${ALLERGEN_NAME}(?:\\s*[,，、·/]\\s*${ALLERGEN_NAME})*\\s*(?:등\\s*)?함\\s*유`, "g");

function findAllergenBox(text) {
  const contactSpans = findCrossContactSpans(text);
  for (const pattern of [BOX_HEAD, BOX_LIST]) {
    for (const m of text.matchAll(pattern)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!overlaps(contactSpans, start, end)) return { found: true, start, end };
    }
  }
  return { found: false };
}

// 받침에 따라 '은/는' 붙이기 (예: 우유는, 땅콩은)
function withTopic(word) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return word + (code >= 0 && code <= 11171 && code % 28 !== 0 ? "은" : "는");
}

// 찾은 단어가 속한 원재료 이름 전체 (예: '카제인' → '카제인나트륨')
function getIngredientName(text, start, end) {
  const stop = /[,，、()\[\]{}「」『』<>:;·\/\n.|•▲*※]/;
  const expand = (isStop) => {
    let s = start;
    let e = end;
    while (s > 0 && !isStop(text[s - 1])) s--;
    while (e < text.length && !isStop(text[e])) e++;
    return text.slice(s, e).trim();
  };
  const matched = text.slice(start, end);
  let name = expand((ch) => stop.test(ch));
  // 띄어쓰기가 섞여 있으면 띄어쓰기에서도 끊기 (예: "이 제품은 우유" → "우유")
  if (/\s/.test(name.replace(matched, ""))) name = expand((ch) => stop.test(ch) || /\s/.test(ch));
  // 뒤에 붙은 조사는 떼기 (예: "우유를" → "우유")
  const rest = name.startsWith(matched) ? name.slice(matched.length) : null;
  if (rest && /^(을|를|이|가|은|는|와|과|도|의|로|으로)$/.test(rest)) return matched;
  return name.length > 20 ? matched : name; // 문장처럼 길면 찾은 단어만
}

function analyze(text, settings) {
  const findings = [];
  const ignored = []; // 섭취·조리 방법 안내에 나온 이름 (판정에서 뺌, R9)
  const contactSpans = findCrossContactSpans(text);
  const servingSpans = findServingSpans(text);
  const box = findAllergenBox(text);

  // 검사할 목록 = 고른 알레르기 + 직접 추가한 단어
  const groups = settings.allergens.map((id) => ({ id, ...ALLERGENS[id] }));
  const customWords = parseCustomWords(settings.custom);
  if (customWords.length > 0) {
    groups.push({
      id: "custom",
      name: "직접 추가",
      defaultNote: { danger: "내가 직접 추가한 성분이에요." },
      keywords: customWords.map((word) => ({ word, level: "danger" })),
      exclude: [],
    });
  }

  for (const group of groups) {
    const excluded = findRanges(text, group.exclude || []);
    const taken = [];
    // 긴 단어부터 찾기: '해바라기씨유'(확인 필요)를 '해바라기씨'(위험)보다 먼저 판단
    const keywords = [...group.keywords].sort((a, b) => b.word.length - a.word.length);

    for (const keyword of keywords) {
      for (const match of text.matchAll(buildPattern(keyword.word, keyword.unlessParen))) {
        const start = match.index;
        const end = start + match[0].length;
        if (overlaps(excluded, start, end) || overlaps(taken, start, end)) continue;
        if (crossesWords(text, start, end)) continue;
        taken.push([start, end]);

        // R9: "우유 200ml를 넣어 드세요"처럼 섭취·조리 방법을 안내하는 문장의 이름은 원재료가 아님
        if (servingSpans.some(([s, e]) => start >= s && end <= e)) {
          ignored.push({ groupId: group.id, groupName: group.name, word: getIngredientName(text, start, end), start, end });
          continue;
        }

        const inContactSentence = contactSpans.some(([s, e]) => start >= s && end <= e);
        findings.push({
          groupId: group.id,
          groupName: group.name,
          word: getIngredientName(text, start, end),
          start,
          end,
          contact: inContactSentence,
          level: inContactSentence ? "check" : keyword.level,
          reason: inContactSentence
            ? "'같은 시설에서 제조'한다는 안내 문구에 있어요. 원재료로 넣은 건 아니지만 섞여 들어갔을 가능성이 있어요."
            : keyword.note || group.defaultNote[keyword.level],
        });
      }
    }
  }

  // 이름은 비슷하지만 해당 성분이 아닌 것 (참고용)
  const lookalikes = [];
  for (const item of LOOKALIKES) {
    if (!settings.allergens.includes(item.allergen)) continue;
    for (const match of text.matchAll(buildPattern(item.word))) {
      lookalikes.push({ ...item, start: match.index, end: match.index + match[0].length });
    }
  }

  // R8: 표시 의무가 있는 성분(우유 등)은 원재료에 이름이 없어도 알레르기 표시란에만 적혀 있을 수 있음
  //     → 그 성분을 하나도 못 찾았는데 표시란도 없으면 '안전' 대신 '확인 필요'
  for (const group of groups) {
    if (!group.mandatory || box.found) continue;
    if (findings.some((f) => f.groupId === group.id)) continue;
    findings.push({
      groupId: group.id,
      groupName: group.name,
      word: "알레르기 표시란을 찾지 못함",
      start: -1,
      end: -1,
      contact: false,
      rule: "R8",
      level: "check",
      reason: `${withTopic(group.name)} 알레르기 표시 의무가 있어서, 원재료에 이름이 없어도 '알레르기 유발물질: ${group.name} 함유' 같은 표시란에만 적혀 있을 수 있어요. 표시란까지 찍거나 입력한 뒤 다시 검사해 주세요. 포장에 표시란이 아예 없다면 표시 대상 성분이 없는 제품일 수 있어요.`,
    });
  }

  findings.sort((a, b) => a.start - b.start);
  const levelOf = (list) =>
    list.some((f) => f.level === "danger") ? "danger" : list.some((f) => f.level === "check") ? "check" : "safe";
  const baseVerdict = levelOf(findings.filter((f) => f.rule !== "R8")); // R1~R7 판정
  const verdict = levelOf(findings); // R8까지 적용한 최종 판정

  return { findings, lookalikes, ignored, verdict, baseVerdict, box, customCount: customWords.length };
}

/* ---------------------------------------------------------
 * 4. 결과 화면
 * ------------------------------------------------------- */

const LEVEL_INFO = {
  danger: {
    label: "위험",
    icon: "✕",
    title: "먹으면 안 돼요",
    desc: "내 알레르기 성분이 들어 있어요. 아래 근거를 확인해 보세요.",
  },
  check: {
    label: "확인 필요",
    icon: "!",
    title: "확인이 필요해요",
    desc: "들어 있을 수도 있는 성분이 있어요. 아래 근거를 보고 판단하거나 보호자·제조사에 확인해 주세요.",
  },
  safe: {
    label: "안전",
    icon: "✓",
    title: "찾은 성분이 없어요",
    desc: "사전에 등록된 이름 중에서는 발견되지 않았어요. 사전에 없는 이름이나 잘못 읽힌 글자는 찾지 못하니 원문도 한 번 확인해 주세요.",
  },
};

function escapeHtml(text) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(text).replace(/[&<>"']/g, (c) => map[c]);
}

// 원문에서 찾은 부분에 색칠하기
function highlight(text, marks) {
  const sorted = [...marks].sort((a, b) => a.start - b.start);
  let html = "";
  let pos = 0;
  for (const mark of sorted) {
    if (mark.start < pos) continue; // 겹치는 표시는 건너뜀
    html += escapeHtml(text.slice(pos, mark.start));
    html += `<mark class="mark-${mark.cls}">${escapeHtml(text.slice(mark.start, mark.end))}</mark>`;
    pos = mark.end;
  }
  return html + escapeHtml(text.slice(pos));
}

function renderFinding(item) {
  const info = LEVEL_INFO[item.level];
  const count = item.count > 1 ? ` <span class="finding-count">${item.count}번</span>` : "";
  return `
    <li class="finding">
      <div class="finding-head">
        <span class="badge ${item.level}">${info.label}</span>
        <span class="finding-word">${escapeHtml(item.word)}</span>${count}
        <span class="finding-group">→ ${escapeHtml(item.groupName)}</span>
      </div>
      <p class="finding-reason">${escapeHtml(item.reason)}</p>
    </li>`;
}

function renderResult(text, result, settings) {
  const info = LEVEL_INFO[result.verdict];

  // 같은 성분이 여러 번 나오면 하나로 묶기 (판정이 다르면 더 위험한 쪽을 보여 줌)
  const grouped = new Map();
  for (const f of result.findings) {
    const key = [f.groupId, f.word, f.contact].join("|");
    const prev = grouped.get(key);
    if (!prev) {
      grouped.set(key, { ...f, count: 1 });
    } else {
      prev.count += 1;
      if (prev.level === "check" && f.level === "danger") Object.assign(prev, { level: f.level, reason: f.reason });
    }
  }
  const order = { danger: 0, check: 1 };
  const items = [...grouped.values()].sort((a, b) => order[a.level] - order[b.level] || a.start - b.start);

  // 헷갈리는 이름은 한 번씩만
  const lookalikeMap = new Map();
  for (const l of result.lookalikes) if (!lookalikeMap.has(l.word)) lookalikeMap.set(l.word, l);
  const lookalikes = [...lookalikeMap.values()];

  // 섭취·조리 방법 문장에서 나와 판정에서 뺀 이름도 한 번씩만
  const ignoredMap = new Map();
  for (const i of result.ignored) if (!ignoredMap.has(i.word)) ignoredMap.set(i.word, i);
  const ignored = [...ignoredMap.values()];

  const marks = [
    ...result.findings.filter((f) => f.start >= 0).map((f) => ({ start: f.start, end: f.end, cls: f.level })),
    ...result.lookalikes.map((l) => ({ start: l.start, end: l.end, cls: "info" })),
    ...result.ignored.map((i) => ({ start: i.start, end: i.end, cls: "info" })),
  ];

  const basis = settings.allergens.map((id) => `${ALLERGENS[id].name} ${ALLERGENS[id].keywords.length}개`);
  if (result.customCount > 0) basis.push(`직접 추가 ${result.customCount}개`);
  const boxStatus = result.box.found ? "찾음" : "못 찾음";

  $("#result").innerHTML = `
    <div class="verdict ${result.verdict}">
      <div class="verdict-icon" aria-hidden="true">${info.icon}</div>
      <div>
        <p class="verdict-title">${info.label} · ${info.title}</p>
        <p class="verdict-desc">${info.desc}</p>
      </div>
    </div>

    ${items.length > 0 ? `
      <h3>왜 이렇게 판단했나요?</h3>
      <ul class="findings">${items.map(renderFinding).join("")}</ul>` : ""}

    ${lookalikes.length > 0 ? `
      <h3>이름은 비슷하지만 괜찮은 성분</h3>
      <ul class="findings">${lookalikes.map((l) => `
        <li class="finding">
          <div class="finding-head">
            <span class="badge info">참고</span>
            <span class="finding-word">${escapeHtml(l.word)}</span>
          </div>
          <p class="finding-reason">${escapeHtml(l.note)}</p>
        </li>`).join("")}
      </ul>` : ""}

    ${ignored.length > 0 ? `
      <h3>판정에서 뺀 이름</h3>
      <ul class="findings">${ignored.map((i) => `
        <li class="finding">
          <div class="finding-head">
            <span class="badge info">참고</span>
            <span class="finding-word">${escapeHtml(i.word)}</span>
            <span class="finding-group">→ ${escapeHtml(i.groupName)}</span>
          </div>
          <p class="finding-reason">섭취·조리 방법을 안내하는 문장에 나온 이름이라 원재료가 아니에요.</p>
        </li>`).join("")}
      </ul>` : ""}

    <h3>성분표에서 찾은 위치</h3>
    <div class="source-text">${highlight(text, marks)}</div>
    <p class="hint">검사 기준: 사전에 등록된 이름 (${basis.join(", ")}) · 알레르기 표시란: ${boxStatus}</p>
  `;

  const box = $("#result");
  box.hidden = false;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

function showMessage(message) {
  const box = $("#result");
  box.innerHTML = `<p class="message">${escapeHtml(message)}</p>`;
  box.hidden = false;
}

function runAnalysis() {
  const text = $("#label-text").value.trim();
  const settings = readSettingsFromScreen();
  if (!text) return showMessage("성분표 글자를 입력하거나 사진을 올려 주세요.");
  if (settings.allergens.length === 0 && parseCustomWords(settings.custom).length === 0) {
    return showMessage("검사할 알레르기를 하나 이상 골라 주세요.");
  }
  renderResult(text, analyze(text, settings), settings);
}

/* ---------------------------------------------------------
 * 시작
 * ------------------------------------------------------- */

function init() {
  renderAllergenChoices(loadSettings());
  $("#custom-words").addEventListener("input", onSettingsChange);
  $("#photo-input").addEventListener("change", onPhotoSelected);
  $("#check-btn").addEventListener("click", runAnalysis);
  $("#sample-btn").addEventListener("click", () => {
    $("#label-text").value = SAMPLE_TEXT;
    runAnalysis();
  });
}

init();
