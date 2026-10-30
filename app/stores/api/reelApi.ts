import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

// Reel2AICart RTK Query — ALL backend comms go here. No manual isLoading.
// Endpoints map to PRD §7 MCP tools + §5 activation (backed by Neon cache).
export const reelApi = createApi({
  reducerPath: "reelApi",
  baseQuery: fetchBaseQuery({ baseUrl: "/api" }),
  tagTypes: ["Video", "Product"],
  endpoints: (builder) => ({
    getVideoSummary: builder.query<unknown, string>({
      query: (videoId) => `video-summary?video_id=${videoId}`,
      providesTags: (_r, _e, id) => [{ type: "Video", id }],
    }),
    searchProducts: builder.query<unknown, { q: string; price_max?: number }>({
      query: (p) => ({
        url: "search-products",
        params: p,
      }),
      providesTags: ["Product"],
    }),
  }),
});

export const { useGetVideoSummaryQuery, useSearchProductsQuery } = reelApi;
