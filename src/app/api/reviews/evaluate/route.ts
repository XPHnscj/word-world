import { NextResponse } from "next/server";
import { localEvaluateSentence } from "@/lib/reviewEngine";
import { normalizeClientProviderUrl, trustedServerProviderUrl } from "@/lib/provider";
import { readServerAIEnv } from "@/lib/serverConfig";
import type { ReviewEvaluation, ReviewPhase } from "@/lib/types";

type EvaluateBody = {
  lemma?: unknown;
  answer?: unknown;
  phase?: unknown;
  meaningZh?: unknown;
  sceneTopic?: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  protocol?: unknown;
};

function localResult(lemma: string, answer: string, phase: ReviewPhase): ReviewEvaluation {
  const result = localEvaluateSentence(lemma, answer);
  return {
    ...result,
    source: "local",
    feedback: phase === "transfer"
      ? `${result.feedback} 当前迁移场景要求：换一个语境仍能保持词义稳定。`
      : result.feedback,
  };
}

/**
 * 评估 Lv3/Lv4 的主动造句：优先调用已配置模型，失败时返回本地规则初筛结果。
 * 请求体只接受短词元、用户句子和复习阶段，避免把整篇学习数据发送到模型服务。
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as EvaluateBody;
  const lemma = typeof body.lemma === "string" ? body.lemma.trim().slice(0, 60) : "";
  const answer = typeof body.answer === "string" ? body.answer.trim().slice(0, 600) : "";
  const phase: ReviewPhase = body.phase === "transfer" ? "transfer" : "generation";
  if (!lemma || !answer) return NextResponse.json({ evaluation: localResult(lemma || "目标词", answer, phase) }, { status: 400 });

  const env = readServerAIEnv();
  const serverApiKey = env.apiKey;
  const apiKey = serverApiKey ?? (typeof body.apiKey === "string" ? body.apiKey.trim() : "");
  if (!apiKey) return NextResponse.json({ evaluation: localResult(lemma, answer, phase), mode: "local" });
  const baseUrl = serverApiKey ? trustedServerProviderUrl(env.baseUrl ?? undefined) : normalizeClientProviderUrl(body.baseUrl);
  if (!baseUrl) return NextResponse.json({ evaluation: localResult(lemma, answer, phase), mode: "local", warning: "模型地址无效，已使用本地初筛。" });
  const model = env.model ?? (typeof body.model === "string" && body.model.trim() ? body.model.trim() : "gpt-4o-mini");
  const sceneTopic = typeof body.sceneTopic === "string" ? body.sceneTopic.trim().slice(0, 80) : "新的生活场景";
  const prompt = `你是严谨的 IELTS 词汇教练。判断用户是否在“${sceneTopic}”中自然使用了目标词“${lemma}”。目标词必须表达常见词义，不要因为句子不够高级就判错。只返回 JSON：{"passed":true或false,"score":0-100,"feedback":"中文简短反馈","correction":"如需修改给出自然英文句子，否则为空"}。用户句子：${answer}`;
  try {
    const endpoint = body.protocol === "openai_responses" ? "responses" : "chat/completions";
    const payload = endpoint === "responses"
      ? { model, temperature: 0.1, input: [{ role: "system", content: "你只输出合法 JSON，不要解释。" }, { role: "user", content: prompt }] }
      : { model, temperature: 0.1, messages: [{ role: "system", content: "你只输出合法 JSON，不要解释。" }, { role: "user", content: prompt }] };
    const upstream = await fetch(`${baseUrl}/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    if (!upstream.ok) return NextResponse.json({ evaluation: localResult(lemma, answer, phase), mode: "local", warning: "模型评估失败，已使用本地初筛。" });
    const data = (await upstream.json()) as { choices?: Array<{ message?: { content?: unknown } }>; output_text?: unknown };
    const content = typeof data.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : typeof data.output_text === "string" ? data.output_text : "";
    const parsed = JSON.parse(content.replace(/^```json\s*/i, "").replace(/\s*```$/, "")) as Record<string, unknown>;
    if (typeof parsed.passed !== "boolean" || typeof parsed.feedback !== "string") throw new Error("invalid evaluation");
    const evaluation: ReviewEvaluation = {
      passed: parsed.passed,
      score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
      feedback: parsed.feedback.slice(0, 300),
      correction: typeof parsed.correction === "string" ? parsed.correction.slice(0, 300) : undefined,
      source: "ai",
    };
    return NextResponse.json({ evaluation, mode: "ai", model });
  } catch {
    return NextResponse.json({ evaluation: localResult(lemma, answer, phase), mode: "local", warning: "模型暂不可用，已使用本地初筛。" });
  }
}
