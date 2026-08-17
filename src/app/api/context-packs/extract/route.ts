import { NextResponse } from "next/server";
import { normalizeClientProviderUrl, trustedServerProviderUrl } from "@/lib/provider";
import { readServerAIEnv } from "@/lib/serverConfig";

const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File))
    return NextResponse.json({ message: "没有收到文件。" }, { status: 400 });
  if (file.size > MAX_BYTES)
    return NextResponse.json({ message: "文件超过 8 MB，请压缩后重试。" }, { status: 413 });

  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  const bytes = Buffer.from(await file.arrayBuffer());

  // 1) 纯文本家族：直接按 UTF-8 读取。
  if (type.startsWith("text/") || /\.(txt|csv|md)$/i.test(name)) {
    return NextResponse.json({
      text: bytes.toString("utf8"),
      message: `已读取 ${file.name}。`,
    });
  }

  // 2) DOCX：用 mammoth 提取段落文本（.doc 旧格式无法解析，提示另存）。
  if (
    type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  ) {
    try {
      const { extractRawText } = await import("mammoth");
      const result = await extractRawText({ buffer: bytes });
      const text = (result.value ?? "").trim();
      if (text)
        return NextResponse.json({
          text,
          message: `已从 Word 文档 ${file.name} 提取文字。`,
        });
    } catch {
      // fall through to the manual fallback below
    }
  }

  // 3) PDF：用 pdf-parse 提取文本层；扫描版（纯图片）PDF 会落到兜底提示。
  if (type === "application/pdf" || name.endsWith(".pdf")) {
    try {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: bytes });
      try {
        const result = await parser.getText();
        const text = (result.text ?? "").trim();
        if (text)
          return NextResponse.json({
            text,
            message: `已从 PDF ${file.name} 提取文字。`,
          });
      } finally {
        await parser.destroy().catch(() => {});
      }
    } catch {
      // fall through to the manual fallback below
    }
  }

  // 4) 图片：把 OCR 放在服务端边界之后，由配置的视觉模型转成干净词表。
  const env = readServerAIEnv();
  const serverApiKey = env.apiKey;
  const apiKey = serverApiKey ?? String(form?.get("apiKey") ?? "").trim();
  const baseUrl = serverApiKey
    ? trustedServerProviderUrl(env.baseUrl ?? undefined)
    : normalizeClientProviderUrl(String(form?.get("baseUrl") ?? ""));
  const model = env.model ?? String(form?.get("model") || "gpt-4o-mini");
  if (apiKey && baseUrl && type.startsWith("image/")) {
    const dataUrl = `data:${file.type};base64,${bytes.toString("base64")}`;
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: "Extract only English vocabulary items from the image, one item per line." },
            { role: "user", content: [{ type: "text", text: "提取图片中的英文词汇，每行一个，不要解释。" }, { type: "image_url", image_url: { url: dataUrl } }] },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (response.ok && text)
        return NextResponse.json({ text, message: `已通过 AI 从 ${file.name} 提取词汇。` });
    } catch {
      // Return a clear manual fallback below.
    }
  }

  const reason = /\.doc$/i.test(name)
    ? "旧版 .doc 暂不支持，请另存为 .docx 后重试。"
    : "当前无法解析该文件类型，请直接粘贴词表，或在设置中配置 AI 后重试图片提取。";
  return NextResponse.json({ message: `${file.name} 已接收。${reason}` });
}
