const chatBaseUrl = process.env.CHAT_BASE_URL ?? "http://localhost:3000";
const lmStudioEndpoint = process.env.LM_STUDIO_TEST_ENDPOINT ?? "192.168.4.187:1234";

const cases = [
  {
    name: "graduate-school-existence",
    prompt: "전주 대학교에는 대학원이 있어?",
    includes: ["대학원이 있습니다", "일반대학원", "교육대학원"],
    excludes: ["학부 대학의 학과/학부"],
  },
  {
    name: "undergraduate-department-list",
    prompt: "전주대학교 대학 학과를 전부 알려줘",
    includes: ["학부 대학의 학과/학부", "총 76개", "인문콘텐츠대학"],
    excludes: ["대학원이 있습니다"],
  },
  {
    name: "professor-count",
    prompt: "전주대학교 교수님은 총 몇명이야?",
    includes: ["총 326명", "현직 교수진은 243명", "명예교수는 83명"],
    excludes: ["변전소"],
  },
  {
    name: "food-facility-location",
    prompt: "학교에 식당은 어디에 있어?",
    includes: ["식당 위치는", "식당(스타타워)", "식당(학생회관)"],
    excludes: ["식단입니다"],
  },
  {
    name: "campus-place-location",
    prompt: "학교 안에 변전소가 있어?",
    includes: ["변전소", "건물리스트 36번"],
    excludes: ["오시는길"],
  },
];

let failedCount = 0;

for (const testCase of cases) {
  const response = await fetch(`${chatBaseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      lmStudioEndpoint,
      messages: [
        {
          role: "user",
          content: testCase.prompt,
        },
      ],
    }),
  });
  const data = await response.json().catch(() => ({}));
  const message = String(data.message ?? data.details ?? data.error ?? "");
  const missing = testCase.includes.filter((expected) => !message.includes(expected));
  const unexpected = testCase.excludes.filter((blocked) => message.includes(blocked));
  const passed = response.ok && missing.length === 0 && unexpected.length === 0;

  if (!passed) {
    failedCount += 1;
  }

  console.log(`${passed ? "PASS" : "FAIL"} ${testCase.name}`);

  if (!passed) {
    console.log(`  prompt: ${testCase.prompt}`);
    console.log(`  status: ${response.status}`);
    console.log(`  missing: ${missing.join(", ") || "-"}`);
    console.log(`  unexpected: ${unexpected.join(", ") || "-"}`);
    console.log(`  answer: ${message.slice(0, 500)}`);
  }
}

if (failedCount > 0) {
  console.error(`\n${failedCount} intent regression case(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nAll intent regression cases passed.");
}
