import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { clearCityCache, resolveCityId } from "@/lib/cityData";

/**
 * 批量给地点打重要性星级（后台「批量打星（未标注的）」按钮）。
 *
 * 本路由不碰数据文件：真正写盘的是任务3-A 的 CLI（scripts/rate-places.ts，内部走
 * lib/cityData.saveManualPlaces 原子写）。这里只负责四件事：
 * 1. 校验 city（resolveCityId，挡路径穿越 / 未知城市）；
 * 2. 用 process.execPath + tsx CLI + 参数数组 spawn，不拼 shell 字符串；
 * 3. 把脚本 stdout 的 NDJSON 逐行转成 SSE 事件转发给浏览器；
 * 4. 超时 / 客户端断开时杀掉子进程，避免后台残留脚本继续写数据。
 *
 * 缓存一致性（重要）：脚本是独立子进程，它写 manual 文件时只清得掉自己进程里的缓存；
 * dev server 进程内的 loadCity / loadManualPlaces 结果挂在 lib/cityData.ts 的 LRU 里，
 * 不会自动感知文件变化。所以脚本一结束（done 事件 / 子进程 close，成功失败都算）就必须在
 * 本进程调用 clearCityCache()，否则前端「完成后自动刷新列表」还会读到打星前的旧数据。
 *
 * CLI 契约（由 Lead 固定，本路由只对接、不改脚本）：
 *   node node_modules/tsx/dist/cli.mjs --env-file=.env.local scripts/rate-places.ts <city> --only-unrated --progress=json
 * stdout 只输出 NDJSON：
 *   {"type":"start","city":"liaoyang","total":141,"llm":true}
 *   {"type":"progress","done":12,"total":141,"rule":2,"llm":10}
 *   {"type":"done","city":"liaoyang","total":141,"rated":141,"skipped":0,"byStar":{"1":52,"5":12},"unrated":0}
 *   {"type":"error","message":"..."}
 * 人类可读日志走 stderr（本路由只留尾部，失败时带进 error 事件）。
 *
 * SSE 帧格式（每帧一个事件，浏览器端按 \n\n 分帧、取 data: 行 JSON）：
 *   event: progress
 *   data: {"type":"progress",...}
 *
 * 返回：
 * - 参数不合法 / 未知城市 → 400 JSON { ok:false, reason }（与 /api/admin/places 同口径）；
 * - 脚本或 tsx 缺失 → 500 JSON；
 * - 正常 → 200 text/event-stream（start / progress / done / error 事件，结束后关流）。
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 任务3-A 的 CLI（相对项目根；本路由只调不改）。 */
const SCRIPT_RELATIVE_PATH = join("scripts", "rate-places.ts");
/** tsx CLI（与 package.json 里 "fetch:seed": "tsx --env-file=..." 同一套启动方式）。 */
const TSX_CLI_RELATIVE_PATH = join("node_modules", "tsx", "dist", "cli.mjs");
/** 脚本整体超时：20 分钟（LLM 逐条打星，百来条量级足够）。 */
const SCRIPT_TIMEOUT_MS = 20 * 60 * 1000;
/** SSE 心跳间隔：长任务期间定期发注释帧，避免中间层把空闲连接掐掉。 */
const HEARTBEAT_MS = 15000;

const RequestSchema = z
  .object({
    city: z.string().min(1),
    /** 默认 true：只处理未标注地点（已有人工标注不覆盖）。 */
    onlyUnrated: z.boolean().optional(),
  })
  .strict();

function failure(status: number, reason: string) {
  return NextResponse.json({ ok: false as const, reason }, { status });
}

/** 读 JSON 请求体；不是合法 JSON 返回 null（由调用方回 400）。 */
async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** SSE 帧：event 只是给人看的类型标签，data 里的 JSON 才是客户端真正消费的契约。 */
function sseFrame(type: string, payload: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 杀掉脚本进程树。
 * Windows 下 node 的子进程不一定和父进程同生共死（tsx 视启动参数可能会再开 node），
 * 所以用 taskkill /T /F；其它平台直接 SIGKILL（本地开发只跑 Windows，这里只做兜底）。
 */
function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 15000,
      });
    } catch {
      // 进程已经退出 / 没权限：忽略（不能因为清理失败就把 500 抛给前端）。
    }
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 同上：已经退出就忽略。
  }
}

export async function POST(request: Request) {
  const payload = await readJsonBody(request);
  if (payload === null) return failure(400, "请求体不是合法 JSON");

  const parsed = RequestSchema.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.length === 0 ? "请求体" : issue.path.join(".")} ${issue.message}`)
      .join("；");
    return failure(400, `请求参数不合法：${detail}`);
  }

  let cityId: string;
  try {
    cityId = resolveCityId(parsed.data.city);
  } catch (error) {
    return failure(400, error instanceof Error ? error.message : String(error));
  }
  const onlyUnrated = parsed.data.onlyUnrated !== false;

  // cwd = 项目根（next dev 从项目根启动）；脚本路径、.env.local 都按它解析。
  const projectRoot = process.cwd();
  const scriptPath = join(projectRoot, SCRIPT_RELATIVE_PATH);
  const tsxCliPath = join(projectRoot, TSX_CLI_RELATIVE_PATH);
  if (!existsSync(scriptPath)) {
    return failure(
      500,
      `打星脚本不存在：${SCRIPT_RELATIVE_PATH}（请先确认任务3-A 已交付 scripts/rate-places.ts）`,
    );
  }
  if (!existsSync(tsxCliPath)) {
    return failure(500, `找不到 tsx CLI：${TSX_CLI_RELATIVE_PATH}（node_modules 是否安装完整？）`);
  }

  // 参数数组，不拼 shell 字符串：city 已经过 resolveCityId 白名单校验，但这里仍按 argv 传递。
  const args: string[] = [tsxCliPath, "--env-file=.env.local", scriptPath, cityId];
  if (onlyUnrated) args.push("--only-unrated");
  args.push("--progress=json");

  const encoder = new TextEncoder();
  /** cancel() 在 start() 之后才会被调用，用这个变量把清理逻辑接出去。 */
  let cancelHandler: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let forwardedDone = false;
      let forwardedError = false;
      let stdoutBuffer = "";
      let stderrTail = "";
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      /** 子进程 pid 的持有对象：供「还没 spawn 完就被 abort」的闭包安全读取（const 对象内可变）。 */
      const childRef: { pid: number | undefined } = { pid: undefined };

      const clearTimers = () => {
        if (timeoutTimer !== null) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (heartbeatTimer !== null) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };

      /** 结束 SSE 流（只执行一次；客户端已断开时 close() 会抛错，吞掉即可）。 */
      const closeStream = () => {
        if (closed) return;
        closed = true;
        clearTimers();
        try {
          controller.close();
        } catch {
          // 客户端已经断开，流已被取消：无需再关。
        }
      };

      /** 发一个事件帧；流已关闭 / 客户端断开时返回 false（后续事件直接丢弃）。 */
      const send = (type: string, eventPayload: unknown): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(sseFrame(type, eventPayload)));
          return true;
        } catch {
          // enqueue 失败 = 流已不可写（客户端断开）：标记关闭并杀掉脚本，别让它在后台继续跑。
          closed = true;
          clearTimers();
          killProcessTree(childRef.pid);
          return false;
        }
      };

      /** 以 error 事件收尾。 */
      const finishWithError = (message: string) => {
        send("error", { type: "error", message });
        closeStream();
      };

      /** 脚本 stdout 的一行 NDJSON → 一个 SSE 事件。 */
      const handleLine = (line: string) => {
        const text = line.trim();
        if (text === "") return;
        let event: unknown;
        try {
          event = JSON.parse(text);
        } catch {
          // stdout 契约是 NDJSON；万一脚本往 stdout 打了人类日志，保留成 log 事件便于排查，不篡改。
          send("log", { type: "log", line: text });
          return;
        }
        if (event === null || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string") {
          send("log", { type: "log", line: text });
          return;
        }
        const eventType = (event as { type: string }).type;
        if (eventType === "done") {
          forwardedDone = true;
          // 脚本是「先原子写 manual、后输出 done」（见 scripts/rate-places.ts），
          // 所以收到 done 就说明数据已落盘：立刻清本进程缓存，保证客户端紧接着的刷新读到新数据。
          clearCityCache();
        }
        if (eventType === "error") {
          forwardedError = true;
          // 失败路径也可能已经写过部分数据（比如写完 manual 后统计阶段出错），清一次缓存不会错。
          clearCityCache();
        }
        send(eventType, event);
      };

      /** 切行：只处理完整行，残行留到下一个 chunk / 流结束。 */
      const consumeStdout = (chunk: string) => {
        stdoutBuffer += chunk;
        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
          handleLine(stdoutBuffer.slice(0, newlineIndex));
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          newlineIndex = stdoutBuffer.indexOf("\n");
        }
      };

      /** 收到 kill 信号 / 客户端断开 / 超时：杀进程树并放弃后续事件。 */
      const abortRun = () => {
        if (closed) return;
        closed = true;
        clearTimers();
        killProcessTree(childRef.pid);
        try {
          controller.close();
        } catch {
          // 客户端已经断开。
        }
      };
      cancelHandler = abortRun;
      // 浏览器断开（关标签页 / 切城市 abort）时 Next 会 abort request.signal，必须停掉脚本。
      if (request.signal.aborted) {
        abortRun();
        return;
      }
      request.signal.addEventListener("abort", abortRun, { once: true });

      console.log(`[api/admin/rate-places] spawn：city=${cityId} onlyUnrated=${onlyUnrated}`);

      let child: ChildProcess;
      try {
        child = spawn(process.execPath, args, {
          cwd: projectRoot,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        finishWithError(`启动打星脚本失败：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      childRef.pid = child.pid;

      timeoutTimer = setTimeout(() => {
        finishWithError(`打星脚本超时（${Math.round(SCRIPT_TIMEOUT_MS / 60000)} 分钟）已终止`);
        killProcessTree(childRef.pid);
      }, SCRIPT_TIMEOUT_MS);

      // 心跳：LLM 打星可能长时间没有 progress 行，定期发注释帧保活（客户端按 \n\n 分帧，会忽略注释行）。
      heartbeatTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
          clearTimers();
          killProcessTree(childRef.pid);
        }
      }, HEARTBEAT_MS);

      child.stdout?.on("data", (chunk: Buffer) => {
        consumeStdout(chunk.toString("utf8"));
      });

      // stderr 是人类日志：只留尾部，脚本失败时带进 error 事件，不逐条转发给浏览器。
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
      });

      child.on("error", (error) => {
        finishWithError(`启动打星脚本失败：${error.message}`);
      });

      child.on("close", (code, signal) => {
        // 不管成功 / 失败 / 超时 / 客户端断开，子进程退出后都清一次本进程的城市数据缓存：
        // 脚本可能已经原子写过 manual 文件（哪怕我们没收到 done），旧缓存一定要失效。
        clearCityCache();
        if (closed) return; // 客户端断开 / 超时已收尾：不再补事件
        consumeStdout("\n"); // 处理最后一行没有换行符的残留
        if (code !== 0 && !forwardedError) {
          const tail = stderrTail.trim();
          finishWithError(
            `打星脚本退出码 ${code === null ? "null" : code}${signal === null ? "" : `（signal=${signal}）`}${
              tail === "" ? "" : `；stderr 尾部：${tail}`
            }`,
          );
          return;
        }
        if (!forwardedDone && !forwardedError) {
          finishWithError(`打星脚本退出码 ${code === null ? "null" : code} 但没有输出 done 事件（stdout 契约可能变了）`);
          return;
        }
        console.log(`[api/admin/rate-places] 脚本结束：city=${cityId} exitCode=${code}`);
        closeStream();
      });
    },
    cancel() {
      // 客户端取消流（浏览器断开）时 ReadableStream 的兜底清理。
      if (cancelHandler !== null) cancelHandler();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
