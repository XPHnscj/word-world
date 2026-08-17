import { NextResponse } from "next/server";
import { trustedServerProviderUrl } from "@/lib/provider";
import { readServerAIEnv } from "@/lib/serverConfig";

export interface ServerConfigInfo {
  serverConfigured: boolean;
  serverBaseUrl: string;
  serverModel: string | null;
}

/**
 * 只读配置探测：设置界面打开时调用，用于提示“服务端已配置、客户端填写被忽略”。
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
