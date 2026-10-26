import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * 后台保护：/admin 和 /api/admin 默认只允许本机访问。
 *
 * 为什么需要它：后台没有任何鉴权，通过隧道分享时任何人都能改/删数据、改 prompt。
 *
 * 放行条件（任一）：
 * 1. Host 是 127.0.0.1 / localhost / [::1]（本机调试）
 * 2. 环境变量 ADMIN_ALLOW_REMOTE === "true"（临时要用手机/局域网访问后台时打开）
 *
 * 注意：判断用 Host 头，所以在 cpolar / Vercel 这类转发场景下也能正确拦住。
 * 局限：Host 头可被伪造，这不是完整的鉴权，只是「挡住不知道后台存在的人」。
 * 真正对外开放前必须换成真正的登录（会话 + 密码哈希）。
 */

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function middleware(request: NextRequest): NextResponse {
  if (process.env.ADMIN_ALLOW_REMOTE === "true") {
    return NextResponse.next();
  }

  // 用 Host 头判断，不要用 request.nextUrl.hostname ——
  // 后者在 next dev 下返回的是服务自身地址（127.0.0.1），不反映真实访问来源。
  const hostHeader = request.headers.get("host") ?? "";
  const hostname = hostHeader.split(":")[0].toLowerCase();
  if (LOCAL_HOSTS.has(hostname)) {
    return NextResponse.next();
  }

  // 不返回 403：403 等于告诉别人「这里有个后台，只是你没权限」。
  // 404 让人以为路径不存在。
  return new NextResponse("Not Found", { status: 404 });
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
