import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

// Ходимо у власну функцію на тому ж походженні, а не напряму до провайдера:
// ключ лишається на сервері й не потрапляє в бандл.
export const articleApi = createApi({
  reducerPath: "articleApi",
  baseQuery: fetchBaseQuery({ baseUrl: "/api/" }),
  endpoints: (builder) => ({
    getSummary: builder.query({
      query: (params) => ({
        url: "summarize",
        method: "POST",
        body: { url: params.articleUrl },
      }),
    }),
  }),
});

export const { useLazyGetSummaryQuery } = articleApi;
