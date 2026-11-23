/* =========================================================
 * dictionary.js — 알레르기 성분 사전 (추론 규칙의 지식 베이스)
 * ---------------------------------------------------------
 * ※ 이 파일은 프로그램 '코드'라기보다 '데이터'에 가깝습니다.
 *   직접 확인하고 보충한 뒤, 소논문에 출처를 밝혀 주세요.
 *   (매점 과자 성분표·푸드QR 데이터에서 찾은 이름을 추가하면 됨)
 *
 * 초기 목록 출처
 *  [S1] Institute of Child Nutrition, "Family Child Care Food Allergy
 *       Fact Sheets: Milk Allergies" — 영문 성분명을 한국 표기로 옮김
 *  [S2] AAAAI, "Ask the Expert: Sunflower seed" (2023)
 *  [S3] 식약처 알레르기 유발물질 표시 대상 19종 (해바라기씨 미포함)
 *       — 2026년 8월 표시기준 개정 행정예고(4종 추가) 내용 확인 필요
 *  [S4] Open Food Facts 한국 제품 데이터(ODbL)로 시험하며 찾은 성분명
 *  [S5] 식약처 푸드QR 공식 데이터(2026-11-22 수집, 500개)로 평가하며 찾은 오류
 *
 * 항목 설명
 *  word        : 성분표에서 찾을 단어 (띄어쓰기가 섞여 있어도 찾음)
 *  level       : "danger" = 위험 (해당 성분이 들어 있음)
 *                "check"  = 확인 필요 (들어 있을 수도 있음)
 *  note        : 화면에 보여 줄 판단 근거 (없으면 기본 문구 사용)
 *  unlessParen : true면, 바로 뒤에 괄호로 원료가 적혀 있을 때는 경고하지 않음
 *                예) "식물성유지(팜유)" → 괄호 안 '팜유'를 따로 검사하므로 통과
 *  source      : 어디서 확인했는지 (직접 추가할 때 꼭 적기)
 *  mandatory   : true면 알레르기 표시 의무가 있는 성분 (S3)
 *                → 알레르기 표시란을 못 찾으면 '안전' 대신 '확인 필요' (규칙 R8)
 * ========================================================= */

const FLAVOR_NOTE = "향료라서 실제 우유가 들어갔는지는 제조사에 확인이 필요해요.";
const CREAMER_NOTE = "식물성 크리머에도 카제인나트륨(우유 단백질)이 들어 있는 경우가 있어요.";
const OIL_NOTE = "해바라기씨 기름이에요. 정제된 기름은 단백질이 거의 없어 반응 가능성이 낮다는 의견도 있지만 개인차가 있어요.";
const LECITHIN_NOTE = "해바라기씨에서 뽑은 유화제예요. 단백질이 거의 없다는 의견도 있지만 개인차가 있어요.";

const ALLERGENS = {
  milk: {
    name: "우유",
    mandatory: true, // 알레르기 표시 의무 대상 (S3)
    defaultNote: {
      danger: "우유에서 나온 성분이에요.",
      check: "우유 성분이 들어 있을 수도 있어요.",
    },
    keywords: [
      // ── 위험: 이름에 우유가 드러나는 것
      { word: "우유", level: "danger", source: "S3" },
      { word: "원유", level: "danger", note: "가공하지 않은 우유예요." },
      { word: "밀크", level: "danger", note: "'밀크'는 우유라는 뜻이에요." },
      { word: "분유", level: "danger", note: "우유를 말린 가루예요. (탈지분유·전지분유·혼합분유 등)", source: "S1" },
      // 아래 2개: Open Food Facts 한국 제품 데이터로 시험하다 빠진 것을 발견해 추가 (S4)
      { word: "탈지유", level: "danger", note: "지방을 뺀 우유예요.", source: "S4" },
      { word: "전지유", level: "danger", note: "지방을 빼지 않은 우유예요.", source: "S4" },
      { word: "유고형분", level: "danger", note: "우유에서 물을 뺀 고형 성분이에요.", source: "S1" },
      { word: "유가공품", level: "danger", note: "우유를 가공해 만든 식품이에요." },
      { word: "유단백", level: "danger", note: "우유 단백질이에요.", source: "S1" },
      { word: "버터", level: "danger", note: "우유 지방으로 만들어요.", source: "S1" },
      { word: "유지방", level: "danger", note: "우유 지방이에요.", source: "S1" },
      { word: "유크림", level: "danger", note: "우유에서 분리한 크림이에요." },
      { word: "생크림", level: "danger", note: "우유에서 분리한 크림이에요." },
      { word: "사워크림", level: "danger", note: "우유 크림을 발효한 거예요.", source: "S1" },
      { word: "치즈", level: "danger", note: "우유로 만들어요." },
      { word: "연유", level: "danger", note: "우유를 졸여 만든 거예요." },
      { word: "요구르트", level: "danger", note: "우유를 발효한 거예요.", source: "S1" },
      { word: "요거트", level: "danger", note: "우유를 발효한 거예요.", source: "S1" },
      { word: "발효유", level: "danger", note: "우유를 발효한 거예요." },

      // ── 위험: 우유처럼 안 보이는 이름
      { word: "유청", level: "danger", note: "치즈를 만들고 남은 액체 속 우유 단백질이에요. (유청분말·유청단백 등)", source: "S1" },
      { word: "카제인", level: "danger", note: "우유의 주요 단백질이에요. (카제인나트륨 등)", source: "S1" },
      { word: "유당", level: "danger", note: "우유 속 당분(락토스)이에요.", source: "S1" },
      { word: "락토스", level: "danger", note: "우유 속 당분(유당)이에요.", source: "S1" },
      { word: "락트알부민", level: "danger", note: "우유 단백질이에요.", source: "S1" },
      { word: "락토알부민", level: "danger", note: "우유 단백질이에요.", source: "S1" },
      { word: "락토글로불린", level: "danger", note: "우유 단백질이에요.", source: "S1" },
      { word: "락토페린", level: "danger", note: "우유 단백질이에요.", source: "S1" },

      // ── 확인 필요: 들어 있을 수도, 아닐 수도 있는 것
      { word: "크림", level: "check", note: "우유 크림일 수도, 식물성 크림일 수도 있어요." },
      { word: "크리머", level: "check", note: CREAMER_NOTE },
      { word: "프림", level: "check", note: CREAMER_NOTE },
      { word: "마가린", level: "check", note: "제품에 따라 우유 성분을 넣기도 해요." },
      { word: "유산균", level: "check", note: "우유에 배양한 유산균일 수 있어요." },
      { word: "우유향", level: "check", note: FLAVOR_NOTE },
      { word: "밀크향", level: "check", note: FLAVOR_NOTE },
      { word: "버터향", level: "check", note: FLAVOR_NOTE },
      { word: "치즈향", level: "check", note: FLAVOR_NOTE },
      { word: "타가토스", level: "check", note: "유당으로 만드는 경우가 있는 감미료예요.", source: "S1" },
      { word: "락티톨", level: "check", note: "유당으로 만드는 감미료예요.", source: "S1" },
    ],
    // 우유 관련 글자가 들어 있지만 우유가 아닌 것 → 경고에서 뺌
    exclude: [
      "코코아버터", "카카오버터", "땅콩버터", "피넛버터", "아몬드버터", "해바라기씨버터",
      "코코넛밀크", "아몬드밀크", "오트밀크", "귀리밀크",
      "천연유래", "자연유래", "락토스프리",
      // 고기·알이 든 가공품이라는 식품 유형 이름 속 '유가공품'을 우유로 잘못 찾지 않게 (S5)
      // ('유함유가공품'은 우유가 든 가공품이라 제외하지 않음)
      "식육함유가공품", "알함유가공품",
    ],
  },

  sunflower: {
    name: "해바라기씨",
    defaultNote: {
      danger: "해바라기씨예요. 해바라기씨는 알레르기 의무 표시 대상(19종)이 아니라서 알레르기 표시란에는 안 나올 수 있어요.",
      check: "해바라기씨 성분이 들어 있을 수도 있어요.",
    },
    keywords: [
      { word: "해바라기씨", level: "danger", source: "S3" },
      { word: "해바라기유", level: "check", note: OIL_NOTE, source: "S2" },
      { word: "해바라기씨유", level: "check", note: OIL_NOTE, source: "S2" },
      { word: "해바라기레시틴", level: "check", note: LECITHIN_NOTE, source: "S2" },
      { word: "해바라기씨레시틴", level: "check", note: LECITHIN_NOTE, source: "S2" },
      { word: "해바라기", level: "check", note: "해바라기에서 나온 원료예요. 씨·기름·레시틴 중 어떤 형태인지 확인해 주세요." },
      { word: "레시틴", level: "check", unlessParen: true, note: "원료(대두·해바라기 등)가 적혀 있지 않아요." },
      { word: "식물성유지", level: "check", unlessParen: true, note: "어떤 식물의 기름인지 적혀 있지 않아요." },
      { word: "혼합식용유", level: "check", unlessParen: true, note: "어떤 기름을 섞었는지 적혀 있지 않아요." },
      { word: "씨앗", level: "check", note: "어떤 씨앗인지 확인이 필요해요." },
      { word: "혼합견과", level: "check", note: "어떤 견과·씨앗이 섞였는지 확인이 필요해요." },
    ],
    exclude: ["대두레시틴", "콩레시틴", "난황레시틴"],
  },
};

// 이름은 비슷하지만 해당 알레르기 성분이 아닌 것 (결과 화면에 참고로 보여 줌)
const LOOKALIKES = [
  { word: "젖산", allergen: "milk", note: "'젖'이 들어가지만 보통 당을 발효해 만드는 산미료라 우유 단백질이 아니에요." },
  { word: "코코아버터", allergen: "milk", note: "카카오 열매의 지방이라 우유가 아니에요." },
  { word: "카카오버터", allergen: "milk", note: "카카오 열매의 지방이라 우유가 아니에요." },
  { word: "땅콩버터", allergen: "milk", note: "땅콩으로 만들어 우유가 아니에요. (땅콩 알레르기는 따로 확인)" },
  { word: "코코넛밀크", allergen: "milk", note: "코코넛 과육으로 만들어 우유가 아니에요." },
  { word: "대두레시틴", allergen: "sunflower", note: "콩에서 뽑은 레시틴이라 해바라기씨가 아니에요. (대두 알레르기는 따로 확인)" },
];

// "같은 제조시설에서 제조" 같은 혼입 주의 문구를 알아보는 단어
// → 이 문장 안에서 찾은 성분은 '위험'이 아니라 '확인 필요'로 낮춤
const CROSS_CONTACT_MARKERS = [
  "제조시설", "같은 시설", "동일 시설", "동일한 시설",
  "같은 라인", "제조라인", "혼입", "함께 제조",
  "사용한 제품과", "사용하는 제품과", // 문장이 잘려 '제조시설'이 안 보일 때 대비
];

// "우유 200ml를 넣어 드세요" 같은 섭취·조리 방법 안내를 알아보는 단어 (S5)
// → 이 문장 안의 이름은 원재료가 아니므로 판정에서 빼고 '참고'로만 보여 줌
const SERVING_MARKERS = [
  "섭취방법", "조리방법", "드시는 방법", "먹는 방법",
  "함께 드시", "곁들여", "넣어 드시", "부어 드시", "타서 드시",
];

// 알레르기 표시란('알레르기 유발물질: 우유, 대두 함유')을 알아보는 데 쓰는 표시 대상 이름 (S3)
// 푸드QR 알레르기 정보에 실제로 나온 이름(계란, 달걀, 메추리알, 아몬드 등)도 넣음 (S5)
const LABELED_ALLERGEN_NAMES = [
  "알류", "가금류", "난류", "계란", "달걀", "메추리알", "우유", "메밀", "땅콩", "대두", "밀",
  "고등어", "게", "새우", "돼지고기", "복숭아", "토마토", "아황산류", "호두", "닭고기",
  "쇠고기", "소고기", "오징어", "조개류", "굴", "전복", "홍합", "잣", "아몬드",
];
