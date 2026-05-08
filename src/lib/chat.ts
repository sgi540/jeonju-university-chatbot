export type ChatRole = "assistant" | "user";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  sources?: ChatSourceCard[];
}

interface CreateMessageOptions {
  id?: string;
  createdAt?: string;
  sources?: ChatSourceCard[];
}

export interface ChatSourceCard {
  title: string;
  category: string;
  url: string;
  excerpt: string;
  score?: number;
}

export interface PromptCard {
  label: string;
  prompt: string;
  tone: string;
}

export interface LinkCard {
  title: string;
  description: string;
  href: string;
}

export const assistantName =
  process.env.NEXT_PUBLIC_ASSISTANT_NAME ?? "JJ Campus Copilot";

export const modelLabel =
  process.env.NEXT_PUBLIC_MODEL_LABEL ?? "Qwen 3.6 35B";

export const endpointLabel =
  process.env.NEXT_PUBLIC_LM_STUDIO_ENDPOINT_LABEL ?? "127.0.0.1:1234";

export const starterPrompts: PromptCard[] = [
  {
    label: "학사 일정",
    prompt: "이번 학기 수강신청과 정정 기간을 안내해줘.",
    tone: "날짜/절차형",
  },
  {
    label: "증명서 발급",
    prompt: "재학증명서를 어디서 발급받는지 단계별로 설명해줘.",
    tone: "실행형",
  },
  {
    label: "국제학생 안내",
    prompt: "외국인 학생이 자주 찾는 전주대 서비스와 문의처를 정리해줘.",
    tone: "다국어형",
  },
  {
    label: "포털 사용법",
    prompt: "포털, 사이버캠퍼스, 도서관 사이트 차이를 학생 입장에서 설명해줘.",
    tone: "비교형",
  },
];

export const scenarioBadges = [
  "학사/행정 안내",
  "포털 서비스 탐색",
  "생활관/도서관/통학 안내",
  "국제학생 FAQ",
  "문의처 연결",
];

export const officialLinks: LinkCard[] = [
  {
    title: "전주대학교 메인",
    description: "학사, 장학, 등록, 학생지원 흐름의 중심 허브",
    href: "https://fire.jj.ac.kr/jj/main.do",
  },
  {
    title: "사이버캠퍼스",
    description: "수업과 원격교육 경험을 연결하는 핵심 학습 채널",
    href: "https://cyber.jj.ac.kr",
  },
  {
    title: "증명발급",
    description: "민원과 행정 시나리오에서 가장 자주 호출되는 기능",
    href: "https://jj.webminwon.kr",
  },
  {
    title: "도서관",
    description: "운영시간, 자료 검색, 서비스 안내를 위한 공식 도메인",
    href: "https://lib.jj.ac.kr",
  },
];

export function createMessage(
  role: ChatRole,
  content: string,
  options: CreateMessageOptions = {},
): ChatMessage {
  return {
    id: options.id ?? crypto.randomUUID(),
    role,
    content,
    createdAt: options.createdAt ?? new Date().toISOString(),
    sources: options.sources,
  };
}

export function formatKoreanTime(iso: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
