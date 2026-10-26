import { NextResponse } from "next/server";
import { z } from "zod";
import { geocode } from "@/lib/amap";
import { loadCity, resolveCityId } from "@/lib/cityData";

/**
 * 地址 → 坐标（开屏问答第 2 题「手动输入地址」用）。
 *
 * 为什么单独一个接口：问答要在**进入主页之前**就把出发点定下来（写进 profile 的 lat/lng），
 * 而 /api/plan 只负责排程。这里只做「geocode + 校验」，不产生任何地点、不落盘。
 *
 * POST { address: string, city?: string }
 *   → 200 { ok: true, lng, lat, label }        （label = 用户输入的地址原文）
 *   → 200 { ok: false, reason }                 （地址解析不出来：人话原因）
 *   → 400 { ok: false, reason }                 （参数不合法）
 *
 * 约束：geocode 的城市口径与 /api/plan 完全一致（城市配置的 transferCityName），
 * 不传 city 时用服务端默认城市（ACTIVE_CITY → 索引第一个）。
 */

const GeocodeRequestSchema = z
  .object({
    address: z.string().min(1, "地址不能为空").max(80, "地址最长 80 个字"),
    city: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, "城市 id 只能是小写字母、数字和连字符")
      .max(64)
      .optional(),
  })
  .strict();

function failureResponse(reason: string, status: number) {
  return NextResponse.json({ ok: false as const, reason }, { status });
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return failureResponse("请求体不是合法 JSON", 400);
  }

  const parsed = GeocodeRequestSchema.safeParse(payload);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join("；");
    return failureResponse(`请求参数不合法：${message}`, 400);
  }

  const address = parsed.data.address.trim();
  if (address === "") return failureResponse("请求参数不合法：地址不能为空", 400);

  let city;
  try {
    city = loadCity(resolveCityId(parsed.data.city === undefined ? undefined : parsed.data.city.trim()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failureResponse(`城市数据加载失败：${message}`, 400);
  }

  // geocode 在「高德返回 status≠1」时会抛错（不是返回 null），这里统一转成 200 + 人话原因。
  // 问答页面只需要「这个地址找不到 → 换个说法」，不需要区分是查无此址还是接口抖动；
  // 文案统一以「没找到这个地址」开头（本轮：与开屏手填起点的验收口径对齐）。
  let coords: { lng: number; lat: number } | null;
  try {
    coords = await geocode(address, city.transferCityName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[api/geocode] 地址解析失败（${city.city}）：${message}`);
    return NextResponse.json({
      ok: false as const,
      reason: `没找到这个地址「${address}」，换个说法或写得更具体一点试试（例如加上区 / 路名）`,
    });
  }
  if (coords === null) {
    return NextResponse.json({
      ok: false as const,
      reason: `没找到这个地址「${address}」，换个说法或写得更具体一点试试（例如加上区 / 路名）`,
    });
  }

  return NextResponse.json({
    ok: true as const,
    lng: coords.lng,
    lat: coords.lat,
    label: address,
  });
}
