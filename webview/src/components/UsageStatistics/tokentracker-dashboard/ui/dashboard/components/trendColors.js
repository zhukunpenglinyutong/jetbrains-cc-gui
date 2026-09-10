// Color palettes shared by TrendBar, the hover tooltip breakdown, and
// external consumers (ProjectDetailModal re-uses getModelColor via
// TrendMonitor.jsx's re-export).

const STACK_COLORS = [
  "#f472b6", // 浅粉 (如儿子)
  "#38bdf8", // 天蓝 (如 OpenAI)
  "#34d399", // 绿色
  "#fbbf24", // 金黄
  "#a78bfa", // 浅紫
  "#fb7185", // 玫瑰红
  "#2dd4bf", // 青色
  "#f97316", // 橙色
  "#6366f1", // 靛蓝
  "#ec4899", // 洋红
  "#14b8a6", // 薄荷绿
  "#f59e0b", // 琥珀黄
];

export const TOKEN_COLORS = {
  "Input": "#38bdf8",
  "Cached Input": "#14b8a6",
  "Output": "#a78bfa",
  "Reasoning Output": "#fb7185",
};

const MODEL_PROVIDER_COLORS = {
  codex: "#3b82f6",
  gpt: "#10b981",
  openai: "#10b981",

  claude: "#d97757",
  anthropic: "#d97757",

  gemini: "#2196f3",
  google: "#2196f3",

  kimi: "#a78bfa",
  moonshot: "#a78bfa",

  opencode: "#f59e0b",
  deepseek: "#f59e0b",

  droid: "#ef4444",

  kilo: "#facc15",
};

export function getModelColor(modelName) {
  const normalized = modelName.toLowerCase();
  for (const [key, color] of Object.entries(MODEL_PROVIDER_COLORS)) {
    if (normalized.includes(key)) {
      return color;
    }
  }

  let hash = 0;
  for (let i = 0; i < modelName.length; i++) {
    hash = modelName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % STACK_COLORS.length;
  return STACK_COLORS[index];
}
