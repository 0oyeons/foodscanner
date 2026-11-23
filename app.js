/* =========================================================
 * app.js — 알레르기 성분 스캐너 (주기능)
 *  1. 내 알레르기 설정 (저장 / 불러오기)
 *  2. 사진 → 글자 (OCR, Tesseract.js): 원재료 부분 고르기 → 흑백·대비 → 글자 인식,
 *     신뢰도가 낮으면 이진화해서 다시 읽고, 그래도 낮으면 '안전' 대신 '확인 필요'
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
 *   ① 사진을 올리면 원재료명 부분을 손가락으로 끌어서 고른다
 *   ② 고른 부분만 잘라 키우고, 흑백으로 바꾼 뒤 대비를 높인다
 *   ③ 잘라 낸 부분은 '글자 덩어리 하나'(PSM 6)로 읽는다
 *   ④ 신뢰도가 낮으면 글자만 남기는 이진화(적응형 임계값)로 한 번 더 읽고
 *      신뢰도가 높은 쪽을 쓴다
 *   ⑤ 신뢰도가 낮거나 읽은 글자에 '원재료명'이 없으면 '안전' 대신 '확인 필요'로
 *      보여 준다(큰 글씨만 읽고 성분표를 놓친 경우를 막기 위해)
 * ------------------------------------------------------- */

let ocrWorker = null;
let cropImage = null;      // 올린 사진(원본 크기)
let cropRect = null;       // 고른 영역 {x, y, w, h} (원본 사진 픽셀 기준)
let cropScale = 1;         // 화면에 그린 크기 / 원본 크기
let dragStart = null;
let lastOcr = null;        // 마지막으로 읽은 결과 {text, confidence, header}

const OCR_RETRY_BELOW = 70;     // 이보다 낮으면 이진화해서 한 번 더 읽기
const OCR_LOW_CONFIDENCE = 60;  // 이보다 낮으면 '안전'으로 보여 주지 않기
const INGREDIENT_HEADER = /원\s*[재제]\s*[료로]/; // '원재료명'(잘못 읽힌 '원재로', '원제료'도 포함)

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

/* ① 영역 고르기 ------------------------------------------- */

function drawCrop() {
  const canvas = $("#crop-canvas");
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.drawImage(cropImage, 0, 0, w, h);
  if (!cropRect) return;
  const r = {
    x: cropRect.x * cropScale, y: cropRect.y * cropScale,
    w: cropRect.w * cropScale, h: cropRect.h * cropScale,
  };
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)"; // 고르지 않은 곳은 어둡게
  ctx.fillRect(0, 0, w, r.y);
  ctx.fillRect(0, r.y + r.h, w, h - r.y - r.h);
  ctx.fillRect(0, r.y, r.x, r.h);
  ctx.fillRect(r.x + r.w, r.y, w - r.x - r.w, r.h);
  ctx.strokeStyle = "#2f6fed";
  ctx.lineWidth = Math.max(2, w / 300);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
}

function showCrop(img) {
  cropImage = img;
  cropRect = null;
  const box = $("#crop-box");
  box.hidden = false;
  const canvas = $("#crop-canvas");
  const shownWidth = Math.min(box.clientWidth || 600, 900);
  const ratio = window.devicePixelRatio || 1;
  cropScale = Math.min(1, (shownWidth * ratio) / img.width);
  canvas.width = Math.round(img.width * cropScale);
  canvas.height = Math.round(img.height * cropScale);
  drawCrop();
  $("#crop-append").hidden = true;
}

function pointerToImage(event) {
  const canvas = $("#crop-canvas");
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width / cropScale;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height / cropScale;
  return {
    x: Math.max(0, Math.min(cropImage.width, x)),
    y: Math.max(0, Math.min(cropImage.height, y)),
  };
}

function onCropDown(event) {
  if (!cropImage) return;
  event.preventDefault();
  $("#crop-canvas").setPointerCapture(event.pointerId);
  dragStart = pointerToImage(event);
  cropRect = null;
  drawCrop();
}

function onCropMove(event) {
  if (!dragStart) return;
  event.preventDefault();
  const p = pointerToImage(event);
  cropRect = {
    x: Math.min(dragStart.x, p.x), y: Math.min(dragStart.y, p.y),
    w: Math.abs(p.x - dragStart.x), h: Math.abs(p.y - dragStart.y),
  };
  drawCrop();
}

function onCropUp() {
  if (!dragStart) return;
  dragStart = null;
  // 너무 작게 고르면(실수로 톡 친 경우) 고르지 않은 것으로 본다
  if (cropRect && (cropRect.w < 20 || cropRect.h < 20)) cropRect = null;
  drawCrop();
}

/* ②~④ 전처리와 글자 인식 ----------------------------------- */

// 고른 부분을 잘라 글자 폭에 맞게 키우고, 흑백 + 대비 높이기
function prepareCrop(img, rect) {
  const scale = Math.min(1600 / rect.w, 3, 2400 / Math.max(rect.w, rect.h));
  const w = Math.max(1, Math.round(rect.w * scale));
  const h = Math.max(1, Math.round(rect.h * scale));
  const pad = 30; // 가장자리에 흰 여백을 두면 글자 인식이 안정적이다
  const canvas = document.createElement("canvas");
  canvas.width = w + pad * 2;
  canvas.height = h + pad * 2;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, pad, pad, w, h);

  const image = ctx.getImageData(pad, pad, w, h);
  const px = image.data; // [R, G, B, A, R, G, B, A, ...]
  const gray = new Uint8ClampedArray(w * h);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const v = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
    gray[j] = v;
    hist[v]++;
  }
  // 가장 어두운 1%와 가장 밝은 1%를 기준으로 밝기 범위를 넓힌다(대비 높이기)
  const n = w * h;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.01) { hi = v; break; } }
  const span = Math.max(1, hi - lo);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const v = Math.max(0, Math.min(255, ((gray[j] - lo) * 255) / span));
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(image, pad, pad);
  return canvas;
}

// 적응형 임계값(주변 평균보다 15% 어두우면 글자): 조명이 고르지 않거나 반사가 있을 때 쓴다
function binarize(source) {
  const w = source.width, h = source.height;
  const px = source.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const W1 = w + 1;
  const integral = new Float64Array(W1 * (h + 1));
  for (let y = 1; y <= h; y++) {
    let row = 0;
    for (let x = 1; x <= w; x++) {
      row += px[((y - 1) * w + (x - 1)) * 4];
      integral[y * W1 + x] = integral[(y - 1) * W1 + x] + row;
    }
  }
  const size = Math.max(15, Math.floor(w / 16)) | 1;
  const r = size >> 1;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  const result = octx.createImageData(w, h);
  const o = result.data;
  let black = 0;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const area = (y1 - y0) * (x1 - x0);
      const sum = integral[y1 * W1 + x1] - integral[y0 * W1 + x1] - integral[y1 * W1 + x0] + integral[y0 * W1 + x0];
      const k = (y * w + x) * 4;
      const v = px[k] * area <= sum * 0.85 ? 0 : 255;
      if (v === 0) black++;
      o[k] = o[k + 1] = o[k + 2] = v;
      o[k + 3] = 255;
    }
  }
  // 밝은 글씨가 어두운 바탕에 있으면 뒤집어서 검은 글씨로 만든다
  if (black > (w * h) / 2) {
    for (let k = 0; k < o.length; k += 4) o[k] = o[k + 1] = o[k + 2] = 255 - o[k];
  }
  octx.putImageData(result, 0, 0);
  return out;
}

async function recognize(worker, canvas, psm) {
  await worker.setParameters({ tessedit_pageseg_mode: String(psm), preserve_interword_spaces: "1" });
  const { data } = await worker.recognize(canvas);
  return { text: data.text.trim(), confidence: Math.round(data.confidence || 0) };
}

function setOcrBusy(busy) {
  $("#ocr-box").hidden = false;
  $("#ocr-bar").hidden = !busy;
  $("#check-btn").disabled = busy;
  $("#crop-read").disabled = busy;
  $("#crop-append").disabled = busy;
  $("#photo-label").classList.toggle("is-disabled", busy);
}

async function onPhotoSelected(event) {
  const file = event.target.files[0];
  event.target.value = ""; // 같은 사진을 다시 골라도 동작하도록
  if (!file) return;
  try {
    showCrop(await loadImage(file));
    $("#ocr-box").hidden = false;
    $("#ocr-bar").hidden = true;
    $("#ocr-status").textContent = "원재료명부터 알레르기 표시('○○ 함유')까지 손가락으로 끌어서 고른 뒤 '고른 부분 읽기'를 눌러 주세요.";
    $("#crop-box").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    console.error(error);
    $("#ocr-box").hidden = false;
    $("#ocr-status").textContent = "사진을 열지 못했어요. 다른 사진을 골라 주세요.";
  }
}

async function readCrop(append) {
  if (!cropImage) return;
  if (typeof Tesseract === "undefined") {
    $("#ocr-status").textContent = "글자 인식 기능을 불러오지 못했어요. 인터넷 연결을 확인하거나 성분표를 직접 입력해 주세요.";
    return;
  }
  const whole = !cropRect;
  const rect = cropRect || { x: 0, y: 0, w: cropImage.width, h: cropImage.height };
  setOcrBusy(true);
  try {
    const worker = await getOcrWorker();
    const base = prepareCrop(cropImage, rect);
    const psm = whole ? 3 : 6; // 사진 전체는 자동 배치 분석, 고른 부분은 글자 덩어리 하나
    let best = await recognize(worker, base, psm);
    let used = base;
    if (best.confidence < OCR_RETRY_BELOW) {
      const bin = binarize(base);
      const second = await recognize(worker, bin, psm);
      if (second.confidence > best.confidence) { best = second; used = bin; }
    }
    $("#ocr-input").src = used.toDataURL("image/png");
    $("#ocr-input-box").hidden = false;

    const textarea = $("#label-text");
    textarea.value = append && textarea.value.trim() ? `${textarea.value.trim()}\n${best.text}` : best.text;
    lastOcr = { text: textarea.value.trim(), confidence: best.confidence };
    lastOcr.header = INGREDIENT_HEADER.test(lastOcr.text);
    $("#crop-append").hidden = false;

    if (!lastOcr.header) {
      $("#ocr-status").textContent = `읽은 글자에 '원재료명'이 없어요(신뢰도 ${best.confidence}점). 성분표를 다 읽었는지 알 수 없으니, 원재료명부터 알레르기 표시까지 끌어서 고른 뒤 다시 읽어 주세요.`;
    } else if (best.confidence < OCR_LOW_CONFIDENCE) {
      $("#ocr-status").textContent = `글자를 제대로 읽지 못한 것 같아요(신뢰도 ${best.confidence}점). ${whole ? "원재료명 부분만 끌어서 고른 뒤 다시 읽거나, " : "더 밝고 가까이에서 다시 찍거나, "}아래 글자를 직접 고쳐 주세요.`;
    } else {
      $("#ocr-status").textContent = `다 읽었어요(신뢰도 ${best.confidence}점). 잘못 읽힌 글자가 있으면 고친 뒤 '검사하기'를 다시 눌러 주세요. 알레르기 표시가 떨어진 곳에 있으면 그 부분을 골라 '이어서 읽기'를 누르세요.`;
    }
    runAnalysis();
  } catch (error) {
    console.error(error);
    ocrWorker = null;
    $("#ocr-status").textContent = "글자를 읽지 못했어요. 더 밝고 가까이에서 다시 찍거나, 성분표를 직접 입력해 주세요.";
  } finally {
    setOcrBusy(false);
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
  const result = analyze(text, settings);
  // ⑤ 사진에서 읽은 글자를 고치지 않았고 신뢰도가 낮으면 '안전'으로 보여 주지 않는다
  const ocrWeak = lastOcr && text === lastOcr.text && (!lastOcr.header || lastOcr.confidence < OCR_LOW_CONFIDENCE);
  if (ocrWeak) {
    result.findings.unshift({
      level: "check", word: "사진 글자 인식", groupId: "_ocr", groupName: "판정 전체",
      start: -1, end: -1, contact: false,
      reason: !lastOcr.header
        ? "사진에서 읽은 글자에 '원재료명'이 없어서 성분표를 다 읽었는지 알 수 없어요. 원재료명부터 알레르기 표시까지 골라 다시 읽거나, 성분표 글자를 직접 넣은 뒤 다시 검사해 주세요."
        : `사진에서 읽은 글자의 신뢰도가 ${lastOcr.confidence}점으로 낮아서, 성분명을 잘못 읽었거나 놓쳤을 수 있어요. 원재료명 부분만 골라 다시 읽거나 잘못 읽힌 글자를 고친 뒤 다시 검사해 주세요.`,
    });
    if (result.verdict === "safe") result.verdict = "check";
  }
  renderResult(text, result, settings);
}

/* ---------------------------------------------------------
 * 시작
 * ------------------------------------------------------- */

function init() {
  renderAllergenChoices(loadSettings());
  $("#custom-words").addEventListener("input", onSettingsChange);
  $("#photo-input").addEventListener("change", onPhotoSelected);
  const crop = $("#crop-canvas");
  crop.addEventListener("pointerdown", onCropDown);
  crop.addEventListener("pointermove", onCropMove);
  crop.addEventListener("pointerup", onCropUp);
  crop.addEventListener("pointercancel", onCropUp);
  $("#crop-read").addEventListener("click", () => readCrop(false));
  $("#crop-append").addEventListener("click", () => readCrop(true));
  $("#crop-clear").addEventListener("click", () => { cropRect = null; drawCrop(); });
  $("#check-btn").addEventListener("click", runAnalysis);
  $("#sample-btn").addEventListener("click", () => {
    $("#label-text").value = SAMPLE_TEXT;
    runAnalysis();
  });
}

init();
