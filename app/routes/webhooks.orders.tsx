import type { ActionFunctionArgs } from "@remix-run/node";

// PRD Pain 5: orders/create writes video_id to note_attributes for reporting.
export async function action({ request }: ActionFunctionArgs) {
  const order = (await request.json().catch(() => ({}))) as {
    note_attributes?: { name: string; value: string }[];
  };
  const vid = order.note_attributes?.find((a) => a.name === "_shopify_video")?.value ?? null;
  return Response.json({ ok: true, video_id: vid });
}
