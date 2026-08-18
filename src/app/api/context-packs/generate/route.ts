import { NextResponse } from "next/server";
import { normalizeClientProviderUrl, trustedServerProviderUrl } from "@/lib/provider";
import type { WordMeta } from "@/lib/contextPack";
import { readServerAIEnv } from "@/lib/serverConfig";

export interface GenerateResult {
  mode: "local" | "openai";
  words: string[];
  planning: string;
  passage?: string;
  translation?: string;
  meanings?: WordMeta[];
  /** 本次请求实际生效的模型（服务端配置优先）。 */
  model?: string;
  /** 服务端是否配置了 OPENAI_API_KEY（此时客户端配置被忽略）。 */
  serverConfigured: boolean;
  warning?: string;
}

/**
 * 进程内生成缓存：相同词表 + 规划方式 + 调整意见 + 模型 的近期结果直接复用。
 * 生成的瓶颈在模型服务的首字延迟（TTFT，实测波动 2–27s），命中缓存时几乎零延迟。
 */
const GENERATION_TTL_MS = 30 * 60_000;
const generationCache = new Map<string, { text: string; at: number }>();

function readGenerationCache(key: string): string | null {
  const hit = generationCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > GENERATION_TTL_MS) {
    generationCache.delete(key);
    return null;
  }
  return hit.text;
}

function writeGenerationCache(key: string, text: string) {
  if (!text.trim()) return;
  if (generationCache.size >= 60) {
    const oldest = generationCache.keys().next().value;
    if (oldest !== undefined) generationCache.delete(oldest);
  }
  generationCache.set(key, { text, at: Date.now() });
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  const words = Array.isArray(body.words)
    ? body.words
        .filter((word: unknown): word is string => typeof word === "string" && /^[A-Za-z][A-Za-z'-]{0,49}$/.test(word))
        .slice(0, 50)
    : [];
  const planning = body.planning === "story" ? "story" : "topic";
  /** 用户对文章的调整意见（如指定话题、调整长度），重新生成时使用。 */
  const adjustment =
    typeof body.adjustment === "string" ? body.adjustment.trim().slice(0, 200) : "";
  /** 客户端检测到目标词重复后要求重写时传入的重复词。 */
  const fixDuplicate =
    typeof body.fixDuplicate === "string" ? body.fixDuplicate.trim().slice(0, 60) : "";
  const env = readServerAIEnv();
  const serverApiKey = env.apiKey;
  const serverConfigured = Boolean(serverApiKey);
  const apiKey = serverApiKey ?? (typeof body.apiKey === "string" ? body.apiKey.trim() : "");
  if (!apiKey || !words.length) return NextResponse.json({ mode: "local", words, planning, serverConfigured });

  const baseUrl = serverApiKey
    ? trustedServerProviderUrl(env.baseUrl ?? undefined)
    : normalizeClientProviderUrl(body.baseUrl);
  if (!baseUrl)
    return NextResponse.json({ mode: "local", words, planning, serverConfigured, warning: "AI 地址无效；线上模式仅允许公开 HTTPS 地址。" });
  const model = env.model ?? (typeof body.model === "string" && body.model.trim() ? body.model.trim() : "gpt-4o-mini");
  const protocol = body.protocol === "openai_responses" ? "openai_responses" : "openai_compatible_chat";
  const extraHeaders = parseExtraHeaders(body.extraHeaders);

  // 缓存命中：把整篇文本作为单个流式块返回，客户端无需等待模型。
  // 提示结构升级时更换版本，避免进程内复用缺少译文定位/真实主题的旧结果。
  const cacheKey = ["v5-lexical-annotations", words.join(","), planning, adjustment, fixDuplicate, model, protocol].join("\u0001");
  const cached = readGenerationCache(cacheKey);
  if (cached !== null) {
    return streamingResult(cached);
  }

  const planningInstruction = planning === "story" ? "串成一个连续的小故事，每段承接上一段" : "按一个雅思大单元主题组织词汇，保持论述连贯";
  const adjustmentInstruction = adjustment
    ? `\n用户对上一版的调整意见（必须严格遵守，例如更换话题或调整篇幅）：${adjustment}`
    : "";
  const duplicateInstruction = fixDuplicate
    ? `\n（重要）上一版短文中目标词 "${fixDuplicate}" 重复出现了。请重写：每个目标词必须且只能出现一次，同一个词禁止出现在两个不同位置。`
    : "";
  const prompt = `你是一名 IELTS Writing 教研编辑。制作一份记忆词汇兼积累论证语言的语境学习包。${planningInstruction}。${adjustmentInstruction}${duplicateInstruction}
短文必须落在一个具体、可想象的瞬间：交代地点、人物动作和至少一个视觉或听觉细节，让读者脑中出现画面；再从这个场景自然推进到一个观点，不能写成松散例句或抽象口号。自然使用以下每个目标词，且每个目标词只能出现一次：${words.join(", ")}。
连贯性优先于辞藻。先确定一个现实中可信的核心事件，所有句子必须围绕同一人物、地点和任务，并按“发生了什么 → 为什么 → 导致什么/人物如何认识”的时间或因果顺序推进。每一句都必须能回答它与前一句的关系。
禁止为了容纳单词突然切换场景或议题；禁止把 garden、kitchen、desk 等普通地点随意写成 kingdom、jungle、weapon 等象征；禁止没有上下文依据的拟人、宏大隐喻、抽象名词堆叠和故作深刻的结论。目标词若语义跨度大，应通过一个合理任务连接（例如人物先完成现场工作，再整理相关报告），不要强行把不相干概念写成比喻。
每个目标词必须采用最常见、最自然、可直接翻译的含义。具体物品或身体部位名词必须按字面义使用：例如 yolk 只能指真实蛋黄，weapon 只能指真实武器或在明确公共议题中使用其常规含义，禁止写成“项目的蛋黄/核心蛋黄”“技术像武器”之类牵强比喻。形容词和名词不得仅因语法上能拼接就放在语义不自然的位置。
每个目标词还要补充一个可迁移的 phraseFrame（词块框架）、rhetoricalFunction（该词在本文中承担的具体修辞功能，如让步、因果、举例、证据或动作推进）、register（语域）和最多 4 个 confusables（易混词；没有可靠易混词时返回空数组）。这些字段必须从正文真实用法推出，禁止套用泛化主题。
正文必须逐字包含上方列出的每个目标词原形各一次，不得改成复数、过去式、分词或派生词来代替；否则无法生成对应填词框。输出前自行逐项核对目标词数量与正文中的可填位置完全一致。
参考篇幅为 75-95 个英文词、4-6 句，允许为自然表达略有浮动，但不得超过 110 词。把目标词分散到自然、完整的句子中，禁止将多个目标词用逗号连续罗列或为了塞词而写成词汇清单。
必须主动写入一个真正值得仿写的高级复杂句，再把它作为 keySentence 返回。优先采用让步倒装、条件倒装、名词性从句、非谓语结构、强调结构或严谨的因果链；不得把普通并列句、简单时间状语句包装成优秀句型。关键句要有清晰主干、从句功能和可替换槽位。
严格区分本文内容与写作迁移：人物行动和具体场景为主体时，应标为“场景故事”；只有正文真正围绕公共议题展开论证时才标为“议论短文”。不得仅因出现 kitchen、city 等地点词就臆测为环境或城市治理话题。
只输出一个 JSON 对象，不要输出 JSON 以外的任何文字，格式：
{
  "passage": "约75-95词、4-6句且不超过110词的英文场景化议论短文（只含英文，目标词自然分散）",
  "translation": "passage 的自然完整中文翻译；每个目标词的对应译法必须在译文中连续出现一次",
  "passageMeta": { "contentType": "场景故事/议论短文/叙事议论（按正文真实内容选择）", "sceneTopic": "正文实际内容的具体中文概括，如‘厨房备餐与论文写作’，禁止泛化或臆测" },
  "words": [
    { "lemma": "目标词原形", "phonetic": "标准 IPA 音标，含 / /", "meaningZh": "该词在本语境中的准确中文义，只写中文", "translationZh": "该词在 translation 中逐字一致的连续中文对应文本", "partOfSpeech": "词性（verb/noun/adj/adv 等）", "morphology": "可靠的词根词缀拆解及中文含义；无法可靠拆解则写‘基础词，无常用词缀拆解’", "collocation": "该词在本语境中的自然常用搭配（2-5词）", "phraseFrame": "可替换的词块框架", "rhetoricalFunction": "该词在正文中的具体修辞功能", "register": "academic/formal/neutral/informal", "confusables": ["可靠易混词"] }
  ],
  "keySentence": { "sentence": "主动写入正文、最值得仿写的高级完整原句（必须与 passage 逐字一致）", "pattern": "用公式拆解主干、从句功能与可替换槽位，禁止只写‘复合句’", "explanation": "讲清语法规则、表达效果、仿写方法，并给一个适用于 Task 2 的简短替换示例", "writingTopic": "该句式真正可迁移的 IELTS 写作领域；若只是通用叙事句则写‘通用表达’，不得根据场景地点臆测话题" }
}
中文翻译约定（必须遵守）：先写完整的 translation 覆盖正文每一句，再从 translation 中逐字复制每个目标词对应的连续中文片段作为其 translationZh；禁止改写、增删字词、加括号或引号、换用同义词，否则该词的中文划线将无法与全文对应。示例：若 translation 中含“准确读数”，accurate 的 translationZh 应写“准确读数”，不得写词典义“准确的”。`;
  try {
    const endpoint = protocol === "openai_responses" ? "responses" : "chat/completions";
    // Qwen 3.7/3.6/3.5 默认开启思考，必须使用其官方的顶层 enable_thinking=false。
    // 仅对 Qwen/Model Studio 发送该字段，避免影响严格校验 OpenAI 请求体的服务。
    const isQwenProvider = /(^qwen|dashscope|maas\.aliyuncs\.com)/i.test(`${model} ${baseUrl}`);
    const modelControls = isQwenProvider ? { enable_thinking: false, max_tokens: 2400 } : { max_tokens: 2400 };
    const payload =
      protocol === "openai_responses"
        ? { model, temperature: 0.2, stream: true, ...modelControls, input: [{ role: "system", content: "你是严谨的 IELTS Writing 教研编辑。优先保证情境真实、语义连贯和搭配自然，再考虑句式难度。直接输出符合格式、语法准确的最终 JSON，禁止思考、禁止解释、不要输出推理过程。" }, { role: "user", content: prompt }] }
        : { model, temperature: 0.2, stream: true, ...modelControls, messages: [{ role: "system", content: "你是严谨的 IELTS Writing 教研编辑。优先保证情境真实、语义连贯和搭配自然，再考虑句式难度。直接输出符合格式、语法准确的最终 JSON，禁止思考、禁止解释、不要输出推理过程。" }, { role: "user", content: prompt }] };
    const upstream = await fetch(`${baseUrl}/${endpoint}`, {
      method: "POST",
      headers: { ...extraHeaders, "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ mode: "local", words, planning, serverConfigured, model, warning: `AI 请求失败（HTTP ${upstream.status}），已回退本地短文。` });
    }

    // 边收边转发：客户端立刻能看到生成进度（TTFT 后即可见），避免长时间无反馈。
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        let text = "";
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const data = trimmed.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              const delta = extractStreamDelta(data);
              if (delta) {
                text += delta;
                controller.enqueue(encoder.encode(JSON.stringify({ type: "delta", text: delta }) + "\n"));
              }
            }
          }
        } catch {
          // 流中断：把已收到的部分作为结果返回，客户端解析失败会走本地回退。
        } finally {
          writeGenerationCache(cacheKey, text);
          controller.enqueue(encoder.encode(JSON.stringify({ type: "done", text }) + "\n"));
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json({ mode: "local", words, planning, serverConfigured, model, warning: "AI 请求失败或服务不可用，已回退本地短文。" });
  }
}

/** 把整段文本包装成单块流式响应（缓存命中时使用），客户端按流式路径处理。 */
function streamingResult(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify({ type: "done", text }) + "\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

/** 从流式事件中提取增量文本（兼容 chat completions 与 responses API）。 */
function extractStreamDelta(data: string): string {
  try {
    const json = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: unknown } }>;
      type?: string;
      delta?: unknown;
      output_text?: unknown;
    };
    const content = json.choices?.[0]?.delta?.content;
    if (typeof content === "string" && content) return content;
    if (json.type === "response.output_text.delta" && typeof json.delta === "string") return json.delta;
    if (typeof json.output_text === "string" && json.output_text) return json.output_text;
    return "";
  } catch {
    return "";
  }
}

function parseExtraHeaders(value: unknown): Record<string, string> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(([key, item]) => key.toLowerCase() !== "authorization" && typeof item === "string"),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}
