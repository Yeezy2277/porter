import { z } from "zod";
import { migratePost, MigrateError } from "@/lib/migrate";

export const dynamic = "force-dynamic";
// A live run takes a minute or two; replays take seconds.
export const maxDuration = 300;

const Body = z.object({ postId: z.number().int().positive() });

/**
 * Streams one agent run as newline-delimited JSON: each event is flushed as
 * it happens, so the page shows tool calls while the run is still going.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request", message: "Send { postId: number }." }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      try {
        await migratePost(parsed.data.postId, send);
      } catch (e) {
        // Failures inside a run were already sent as an error event; only preconditions are left.
        if (e instanceof MigrateError) send({ type: "error", message: e.message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
