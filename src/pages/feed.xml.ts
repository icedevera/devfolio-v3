import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { getCollection } from "astro:content";
import { SITE } from "../site";

export async function GET(context: APIContext) {
  const articles = (await getCollection("articles")).sort(
    (a, b) => b.data.date.valueOf() - a.data.date.valueOf(),
  );
  return rss({
    title: SITE.name,
    description: SITE.description,
    site: context.site ?? context.url.origin,
    trailingSlash: false,
    items: articles.map((article) => ({
      title: article.data.title,
      description: article.data.description,
      pubDate: article.data.date,
      link: `/articles/${article.id}`,
    })),
  });
}
