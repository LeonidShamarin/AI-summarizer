import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

// const options = {
//   method: "GET",
//   url: "https://article-extractor-and-summarizer.p.rapidapi.com/summarize",
//   params: {
//     url: "https://time.com/6266679/musk-ai-open-letter/",
//     lang: "en",
//     engine: "1",
//   },
//   headers: {
//     "x-rapidapi-key": "4aed36af18msh07935c81847db05p155aefjsnf6a335877a1b",
//     "x-rapidapi-host": "article-extractor-and-summarizer.p.rapidapi.com",
//   },
// };

const rapidApiKey = import.meta.env.VITE_RAPID_API_ARTICLE_KEY;

export const articleApi = createApi({
  reducerPath: "articleApi",
  baseQuery: fetchBaseQuery({
    // baseUrl: "https://article-extractor-and-summarizer.p.rapidapi.com/",

    //друга API 
    baseUrl: "https://scrapeninja.p.rapidapi.com/",



    prepareHeaders: (headers) => {
      headers.set("x-rapidapi-key", rapidApiKey),
        headers.set(
          "x-rapidapi-host",
          // "article-extractor-and-summarizer.p.rapidapi.com"
          "scrapeninja.p.rapidapi.com"
        );
      return headers;
    },
  }),

  endpoints: (builder) => ({
    getSummary: builder.query({
      // encodeURIComponent() function encodes special characters that may be present in the parameter values
      // If we do not properly encode these characters, they can be misinterpreted by the server and cause errors or unexpected behavior. Thus that RTK bug
      query: (params) =>
        // `summarize?url=${encodeURIComponent(params.articleUrl)}&length=3`,
        `summarize?url=${encodeURIComponent(params.articleUrl)}`,
    }),
  }),
});

export const { useLazyGetSummaryQuery } = articleApi;
