/**
 * Hacker News — a JavaScript recipe.
 *
 * Demonstrates the things YAML can't do:
 *   - computed start URLs,
 *   - a custom transform,
 *   - lifecycle hooks that enrich, filter and queue extra work.
 *
 *   harvest run recipes/hackernews-api.js
 *
 * This reads the public Firebase API rather than scraping the HTML — always
 * check for an API first. It's faster, more stable, and far gentler on the site.
 */

import { registerTransform } from '../src/index.js';

// Available by name in any field below.
registerTransform('ageHours', (value) => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  return Math.round((Date.now() / 1000 - seconds) / 360) / 10;
});

const TOP_N = 30;

export default {
  name: 'hackernews',
  description: 'Top Hacker News stories, via the public Firebase API.',

  // The API returns one story per request, so the start URLs are computed
  // after fetching the ID list. `onRunStart` does that below.
  start_urls: ['https://hacker-news.firebaseio.com/v0/topstories.json'],

  rate_limit: {
    requests_per_second: 5, // this API is explicitly public and generously rated
    jitter_ms: 50,
  },

  concurrency: 8,
  concurrency_per_host: 5,

  identity: { contact: 'https://example.com/about-my-crawler' },

  // The ID-list URL yields no records; each story URL does.
  extract: {
    default: { fields: {} },
    story: {
      fields: {
        id: { from: 'json', path: 'id', type: 'integer' },
        title: { from: 'json', path: 'title', required: true },
        url: { from: 'json', path: 'url', type: 'url', default: null },
        author: { from: 'json', path: 'by' },
        score: { from: 'json', path: 'score', type: 'integer' },
        comments: { from: 'json', path: 'descendants', type: 'integer', default: 0 },
        posted_at: { from: 'json', path: 'time', transform: ['timestamp'] },
        age_hours: { from: 'json', path: 'time', transform: ['ageHours'], type: 'number' },
      },
    },
  },

  validate: {
    schema: {
      title: { required: true, min_length: 1 },
      score: { type: 'integer', min: 0 },
    },
    on_invalid: 'quarantine',
  },

  dedupe: { strategy: 'fields', key_fields: ['id'] },

  output: ['output/hackernews.ndjson', 'output/hackernews.csv'],

  hooks: {
    /**
     * The first response is a JSON array of story IDs. Turn the top N into
     * individual requests. `onResponse` gets the raw body before parsing.
     */
    async onResponse(response, ctx) {
      if (!response.url.includes('topstories.json')) return response;

      let ids;
      try {
        ids = JSON.parse(response.body);
      } catch {
        ctx.logger.error('could not parse the story ID list');
        return response;
      }

      let queued = 0;
      for (const id of ids.slice(0, TOP_N)) {
        if (ctx.enqueue({
          url: `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
          label: 'story',
          priority: 1,
        })) queued += 1;
      }
      ctx.logger.info('queued stories', { queued, available: ids.length });
      return response;
    },

    /** Derive a couple of fields that are easier to compute than to select. */
    onItem(item) {
      // Drop deleted or dead entries, which the API returns as bare objects.
      if (!item.title) return null;

      return {
        ...item,
        domain: item.url ? new URL(item.url).hostname.replace(/^www\./, '') : 'news.ycombinator.com',
        discussion_url: `https://news.ycombinator.com/item?id=${item.id}`,
        engagement: item.score && item.comments
          ? Math.round((item.comments / item.score) * 100) / 100
          : 0,
      };
    },

    onRunEnd(report) {
      if (report.items.written === 0) {
        process.stderr.write('No stories collected — the API shape may have changed.\n');
      }
    },
  },
};
