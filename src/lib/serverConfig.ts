/**
 * 服务端 AI 配置读取（仅服务端路由使用）。
 *
 * 优先读取应用私有变量名 IELTS_AI_*，回退到通用的 OPENAI_* 约定。
 * 真实进程环境变量会覆盖 .env 文件；私有命名可以避免机器上残留的
 * OPENAI_* 环境变量（例如旧的中转网关配置）意外劫持本应用的模型配置。
 */
export interface ServerAIEnv {
  apiKey: string | null;
  baseUrl: string | null;
  model: string | null;
}

export function readServerAIEnv(): ServerAIEnv {
  const pick = (preferred: string | undefined, fallback: string | undefined) =>
    preferred && preferred.trim() ? preferred.trim() : fallback?.trim() ?? "";
  return {
    apiKey: pick(process.env.IELTS_AI_API_KEY, process.env.OPENAI_API_KEY) || null,
    baseUrl: pick(process.env.IELTS_AI_BASE_URL, process.env.OPENAI_BASE_URL) || null,
    model: pick(process.env.IELTS_AI_MODEL, process.env.OPENAI_MODEL) || null,
  };
}
