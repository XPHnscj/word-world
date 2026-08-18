/**
 * 服务端 AI 配置读取（仅服务端路由使用）。
 *
 * 优先读取应用私有变量名 IELTS_AI_*，回退到通用的 OPENAI_* 约定。
 * 真实进程环境变量会覆盖 .env 文件；私有命名可以避免机器上残留的
 * OPENAI_* 环境变量（例如旧的中转网关配置）意外劫持本应用的模型配置。
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface ServerAIEnv {
  apiKey: string | null;
  baseUrl: string | null;
  model: string | null;
}

export interface ServerAIConfigInput {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const LOCAL_ENV_FILE = path.join(process.cwd(), ".env.local");

export function readServerAIEnv(): ServerAIEnv {
  const pick = (preferred: string | undefined, fallback: string | undefined) =>
    preferred && preferred.trim() ? preferred.trim() : fallback?.trim() ?? "";
  return {
    apiKey: pick(process.env.IELTS_AI_API_KEY, process.env.OPENAI_API_KEY) || null,
    baseUrl: pick(process.env.IELTS_AI_BASE_URL, process.env.OPENAI_BASE_URL) || null,
    model: pick(process.env.IELTS_AI_MODEL, process.env.OPENAI_MODEL) || null,
  };
}

/**
 * 设置页保存模型配置时，同时更新当前 Node 进程和本机 .env.local。
 * 这样浏览器端保存后，生成、OCR、复习评估三个服务端入口立即使用同一套配置，
 * 重启启动器后也会从 .env.local 恢复。
 */
export async function writeServerAIEnv(input: ServerAIConfigInput): Promise<void> {
  const clean = (value: string) => value.trim().replace(/[\r\n]/g, "");
  const apiKey = clean(input.apiKey);
  const baseUrl = clean(input.baseUrl);
  const model = clean(input.model);
  let previous = "";
  try {
    previous = await fs.readFile(LOCAL_ENV_FILE, "utf8");
  } catch {
    /* 首次保存时文件可能尚不存在。 */
  }
  const preserved = previous
    .split(/\r?\n/)
    .filter((line) => !/^\s*IELTS_AI_(API_KEY|BASE_URL|MODEL)=/.test(line))
    .filter((line) => !line.includes("由项目设置页同步生成"))
    .join("\n")
    .trim();
  const contents = [
    preserved,
    "# 由项目设置页同步生成；此文件仅保存在本机，不提交到仓库。",
    `IELTS_AI_API_KEY=${apiKey}`,
    `IELTS_AI_BASE_URL=${baseUrl}`,
    `IELTS_AI_MODEL=${model}`,
  ].filter(Boolean).join("\n") + "\n";
  await fs.writeFile(LOCAL_ENV_FILE, contents, "utf8");
  process.env.IELTS_AI_API_KEY = apiKey;
  process.env.IELTS_AI_BASE_URL = baseUrl;
  process.env.IELTS_AI_MODEL = model;
}
