import { NextResponse } from "next/server";
import { normalizeClientProviderUrl, trustedServerProviderUrl } from "@/lib/provider";
import { readServerAIEnv, writeServerAIEnv } from "@/lib/serverConfig";

export interface ServerConfigInfo {
  serverConfigured: boolean;
  serverBaseUrl: string;
  serverModel: string | null;
}

/**
 * 配置探测：设置界面打开时调用，返回服务端当前实际生效的地址和模型。
 * 不返回任何密钥内容。
 */
export async function GET(): Promise<NextResponse<ServerConfigInfo>> {
  const env = readServerAIEnv();
  const serverConfigured = Boolean(env.apiKey);
  return NextResponse.json({
    serverConfigured,
    serverBaseUrl: serverConfigured
      ? trustedServerProviderUrl(env.baseUrl ?? undefined)
      : "",
    serverModel: serverConfigured ? env.model : null,
  });
}

/**
 * 从设置页同步服务端配置。API Key 只接收和写入本机，不在响应中回显。
 * 留空 apiKey 表示沿用服务端已有密钥，避免页面刷新后误清空配置。
 */
export async function POST(request: Request): Promise<NextResponse<ServerConfigInfo | { error: string }>> {
  try {
    const body = (await request.json()) as {
      apiKey?: unknown;
      baseUrl?: unknown;
      model?: unknown;
    };
    const current = readServerAIEnv();
    const apiKey = typeof body.apiKey === "string" && body.apiKey.trim()
      ? body.apiKey.trim()
      : current.apiKey;
    const baseUrl = normalizeClientProviderUrl(body.baseUrl, false);
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!apiKey) {
      return NextResponse.json({ error: "请先填写 API Key。" }, { status: 400 });
    }
    if (!baseUrl) {
      return NextResponse.json({ error: "Base URL 必须是公开 HTTPS 接口地址。" }, { status: 400 });
    }
    if (!model) {
      return NextResponse.json({ error: "请填写模型名称。" }, { status: 400 });
    }
    await writeServerAIEnv({ apiKey, baseUrl, model });
    const serverConfigured = true;
    return NextResponse.json({
      serverConfigured,
      serverBaseUrl: trustedServerProviderUrl(baseUrl),
      serverModel: model,
    });
  } catch {
    return NextResponse.json({ error: "服务端配置写入失败，请确认项目目录可写。" }, { status: 500 });
  }
}
